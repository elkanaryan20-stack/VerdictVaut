import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { MarketStatus, Order, OrderSide, OrderStatus, OrderType, Prisma, UserStatus } from "@prisma/client";
import * as crypto from "crypto";
import { FEE_CALCULATOR, FeeCalculator } from "./fees/fee-calculator.interface";
import { ReservationService } from "../ledger/reservation.service";
import { PrismaService } from "../prisma/prisma.service";
import { SerializableTransactionRunner } from "../prisma/serializable-transaction-runner";
import { createIdempotent } from "../prisma/idempotent-create.util";
import { ExecutionCoordinator } from "./execution/execution-coordinator.service";
import { PositionReservationService } from "./positions/position-reservation.service";
import { OrderRiskValidator } from "./risk/order-risk-validator.service";
import { CreateOrderDto } from "./dto/create-order.dto";
import { MatchingAttemptFailedException } from "./trading.errors";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Client-safe projection of an Order row. Deliberately omits `sequence`:
 * it's a raw `bigint` (Prisma's native representation, not a Decimal),
 * and `JSON.stringify` throws on any object containing one — returning a
 * raw Order straight from a controller would crash that response, not
 * just leak an internal field. `sequence` is also purely an internal
 * price-time-priority tie-breaker clients must never treat as an
 * ordering signal (see the field's own docblock in schema.prisma), so
 * dropping it is correct on both grounds, not just a serialization fix.
 */
export interface OrderView {
  id: string;
  userId: string;
  marketId: string;
  outcomeId: string;
  side: OrderSide;
  type: OrderType;
  price: Prisma.Decimal | null;
  quantity: Prisma.Decimal;
  filledQuantity: Prisma.Decimal;
  remainingQuantity: Prisma.Decimal;
  status: OrderStatus;
  clientOrderId: string;
  createdAt: Date;
  updatedAt: Date;
  market?: unknown;
  outcome?: unknown;
}

export function toOrderView(order: Order & { market?: unknown; outcome?: unknown }): OrderView {
  return {
    id: order.id,
    userId: order.userId,
    marketId: order.marketId,
    outcomeId: order.outcomeId,
    side: order.side,
    type: order.type,
    price: order.price,
    quantity: order.quantity,
    filledQuantity: order.filledQuantity,
    remainingQuantity: order.remainingQuantity,
    status: order.status,
    clientOrderId: order.clientOrderId,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    ...("market" in order ? { market: order.market } : {}),
    ...("outcome" in order ? { outcome: order.outcome } : {}),
  };
}

export interface PaginatedOrders {
  items: OrderView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface OrderPlacementResult {
  orderId: string;
  status: OrderStatus;
  side: OrderSide;
  quantity: string;
  filledQuantity: string;
  remainingQuantity: string;
  fills: Array<{ fillId: string; price: string; quantity: string; executedAt: string }>;
  averageExecutionPrice: string | null;
  /** Cash (BUY) or outcome shares (SELL) still earmarked by this order's own reservation. "0" once fully consumed/released. */
  reservedAmountRemaining: string;
}

/**
 * Order intake and lifecycle only — there is intentionally no matching
 * engine here yet (see trading/matching/). Orders are validated,
 * risk-checked, funded, and persisted as resting OPEN orders; nothing
 * crosses/fills them.
 *
 * Price convention: prices are probabilities on the OPEN interval (0, 1)
 * — strictly greater than 0, strictly less than 1 — enforced both here
 * and by a DB CHECK constraint (orders_price_probability_check). This is
 * deliberately NOT enforced as "YES price + NO price = 1" at the
 * database level: resting orders for the same outcome can and do sit at
 * many different prices simultaneously, so that invariant (if it's
 * wanted at all) is a property of the matched/settled state, not of any
 * individual order row.
 *
 * Only LIMIT orders are accepted. OrderType.MARKET exists in the schema
 * for forward compatibility but is rejected here — a resting "market
 * order" with no matcher to execute it immediately would be a
 * misleading, incoherent state, not a safe simplification.
 *
 * Funding: BUY reserves cash (quantity * price + fee estimate) via
 * ReservationService against the settlement-currency LedgerAccount. SELL
 * reserves outcome shares via PositionReservationService against the
 * user's Position for that market/outcome — a distinct mechanism because
 * shares are not a LedgerAccount asset (see position-reservation.service
 * .ts for why these are deliberately not the same primitive).
 *
 * Atomicity: idempotent order creation, risk validation, and funds/share
 * reservation all run inside ONE SerializableTransactionRunner
 * transaction. If reservation fails (insufficient funds/shares), the
 * whole transaction — including the just-created order row — rolls
 * back: there is never an order with no reservation behind it.
 *
 * Idempotency: clientOrderId (client-supplied or server-generated) is
 * unique per (userId, clientOrderId). A retried or genuinely concurrent
 * duplicate submission is detected via the same SAVEPOINT-based
 * createIdempotent primitive the ledger uses, and returns the original
 * order rather than creating a second one or reserving funds twice.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: ReservationService,
    private readonly positionReservations: PositionReservationService,
    private readonly riskValidator: OrderRiskValidator,
    @Inject(FEE_CALCULATOR) private readonly feeCalculator: FeeCalculator,
    private readonly txRunner: SerializableTransactionRunner,
    private readonly executionCoordinator: ExecutionCoordinator,
  ) {}

  /**
   * Places (or idempotently returns) an order, then attempts to match it
   * against the current resting book — see ExecutionCoordinator for why
   * this is a separate step from the funding transaction above rather
   * than folded into it (bounded, crash-safe, one matching pass).
   */
  async create(userId: string, dto: CreateOrderDto): Promise<Order> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException("Account must be verified (ACTIVE) to trade");
    }

    if (dto.type === OrderType.MARKET) {
      throw new BadRequestException(
        "MARKET orders are not supported yet — only LIMIT orders can be placed until a matching engine exists to execute them immediately.",
      );
    }

    const market = await this.prisma.market.findUnique({ where: { id: dto.marketId } });
    if (!market) {
      throw new NotFoundException("Market not found");
    }
    if (market.status !== MarketStatus.OPEN) {
      throw new BadRequestException("Market is not open for trading");
    }
    if (market.closeTime && market.closeTime.getTime() <= Date.now()) {
      throw new BadRequestException("Market has passed its close time");
    }

    const outcome = await this.prisma.marketOutcome.findUnique({ where: { id: dto.outcomeId } });
    if (!outcome || outcome.marketId !== market.id) {
      throw new BadRequestException("Outcome does not belong to this market");
    }

    const quantity = new Prisma.Decimal(dto.quantity);
    if (quantity.lessThanOrEqualTo(0)) {
      throw new BadRequestException("quantity must be greater than zero");
    }

    if (!dto.price) {
      throw new BadRequestException("price is required for LIMIT orders");
    }
    const price = new Prisma.Decimal(dto.price);
    if (price.lessThanOrEqualTo(0) || price.greaterThanOrEqualTo(1)) {
      throw new BadRequestException("price must be a probability strictly between 0 and 1");
    }

    const clientOrderId = dto.clientOrderId ?? crypto.randomUUID();

    // Read-only, doesn't depend on the order being created — safe to fetch
    // ahead of the transaction. Only needed for BUY (the cash side).
    const settlementAssetSymbol =
      dto.side === OrderSide.BUY
        ? (await this.prisma.asset.findFirstOrThrow({ where: { isSettlementCurrency: true } })).symbol
        : null;

    const order = await this.txRunner.run(async (tx) => {
      const { row: order, alreadyExisted } = await createIdempotent(
        tx,
        "clientOrderId",
        async () => {
          // Re-validate the market is still OPEN INSIDE this SERIALIZABLE
          // transaction, not just from the plain (non-transactional) read
          // above — that earlier read can go stale if MarketsService.close()
          // commits concurrently between it and this point. Re-reading via
          // `tx` here means Postgres's serializable snapshot isolation
          // genuinely prevents a new order from being funded/created
          // against a market that is concurrently closing: either this
          // transaction sees close()'s already-committed CLOSED status, or
          // — under true concurrency — a write-skew is detected and this
          // transaction is retried by SerializableTransactionRunner, at
          // which point it will see the final state. Without this, a
          // stray order could be created (and funded) for a CLOSED market
          // moments after MarketsService.close() already expired every
          // order that existed at that instant, leaving it resting
          // forever and blocking resolution's own defensive
          // "no resting orders" check.
          const currentMarket = await tx.market.findUniqueOrThrow({ where: { id: market.id } });
          if (currentMarket.status !== MarketStatus.OPEN) {
            throw new BadRequestException("Market is not open for trading");
          }
          if (currentMarket.closeTime && currentMarket.closeTime.getTime() <= Date.now()) {
            throw new BadRequestException("Market has passed its close time");
          }

          await this.riskValidator.validate(
            { userId, marketId: market.id, outcomeId: outcome.id, side: dto.side, price, quantity },
            tx,
          );

          return tx.order.create({
            data: {
              userId,
              marketId: market.id,
              outcomeId: outcome.id,
              side: dto.side,
              type: OrderType.LIMIT,
              price,
              quantity,
              filledQuantity: new Prisma.Decimal(0),
              remainingQuantity: quantity,
              status: OrderStatus.OPEN,
              clientOrderId,
            },
          });
        },
        () => tx.order.findUniqueOrThrow({ where: { userId_clientOrderId: { userId, clientOrderId } } }),
      );

      if (alreadyExisted) {
        return order;
      }

      if (dto.side === OrderSide.BUY) {
        const feeBuffer = this.feeCalculator.estimateBuyReserveFee({
          marketId: market.id,
          outcomeId: outcome.id,
          price,
          quantity,
        });
        const requiredFunds = quantity.times(price).plus(feeBuffer);

        await this.reservations.reserve(tx, {
          userId,
          assetSymbol: settlementAssetSymbol!,
          amount: requiredFunds,
          referenceType: "Order",
          referenceId: order.id,
          idempotencyKey: `order-reserve:${order.id}`,
        });
      } else {
        await this.positionReservations.reserve(tx, {
          userId,
          marketId: market.id,
          outcomeId: outcome.id,
          amount: quantity,
          referenceType: "Order",
          referenceId: order.id,
          idempotencyKey: `order-reserve:${order.id}`,
        });
      }

      return order;
    });

    // Deliberately OUTSIDE the funding transaction above — see
    // ExecutionCoordinator's docblock for why. If this order was an
    // idempotent replay (already existed before this call), matching was
    // already attempted for it the first time it was created; attempting
    // it again here is harmless (a no-op matching pass finds nothing new,
    // or — under genuine concurrent duplicate submission — safely
    // idempotent-replays any Fill it happens to regenerate).
    //
    // The funding transaction above has ALREADY committed by this point —
    // the order legitimately exists and is correctly reserved regardless
    // of what happens next, so a matching failure here can never strand or
    // corrupt funds. But it must also never be silently absorbed into an
    // ordinary success response: that would hide a real fault (the order
    // may have missed an immediately-crossable counterparty) behind what
    // looks like a normal "resting, nothing to cross" order. So this is
    // logged AND re-thrown as a distinct, typed exception carrying the
    // order id — never swallowed — so the caller (see TradingController)
    // can represent the outcome honestly (order accepted, matching
    // deferred) rather than either lying about success or discarding a
    // legitimately-placed, correctly-funded order as if it never happened.
    // Recovery is OrdersService.retryMatching, safe to call any number of
    // times (matchAndExecute's own per-instruction idempotency guarantees
    // a retry can never double-apply a fill).
    try {
      await this.executionCoordinator.matchAndExecute(order.id);
    } catch (error) {
      this.logger.error(`Matching failed after order ${order.id} was funded and created`, error as Error);
      throw new MatchingAttemptFailedException(order.id, error);
    }

    return this.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  }

  /**
   * Explicit, safe-to-repeat recovery path for an order whose placement-time
   * matching attempt failed (MatchingAttemptFailedException) — or, more
   * generally, for any OPEN/PARTIALLY_FILLED order that hasn't had a
   * matching pass run against the current book recently. A terminal order
   * (FILLED/CANCELLED/EXPIRED/REJECTED) is left untouched — nothing to
   * retry, not an error — so this can be called blindly without first
   * checking status. Safe to call any number of times: matchAndExecute's
   * own per-instruction idempotency (Fill.idempotencyKey, unique in the DB)
   * guarantees a repeated call can never double-apply an execution that
   * already went through.
   */
  async retryMatching(userId: string, orderId: string): Promise<OrderPlacementResult> {
    const order = await this.getOwnOrder(userId, orderId);
    if (order.status === OrderStatus.OPEN || order.status === OrderStatus.PARTIALLY_FILLED) {
      try {
        await this.executionCoordinator.matchAndExecute(orderId);
      } catch (error) {
        this.logger.error(`Retried matching attempt failed for order ${orderId}`, error as Error);
        throw new MatchingAttemptFailedException(orderId, error);
      }
    }
    return this.getPlacementSummary(userId, orderId);
  }

  /**
   * Richer, HTTP-facing view of an order placement: final status, fills
   * generated, average execution price, and how much of its own
   * reservation remains earmarked. Never exposes LedgerAccount/
   * FundReservation/PositionReservation rows directly.
   */
  async getPlacementSummary(userId: string, orderId: string): Promise<OrderPlacementResult> {
    const order = await this.getOwnOrder(userId, orderId);

    const fills = await this.prisma.fill.findMany({
      where: { OR: [{ buyOrderId: orderId }, { sellOrderId: orderId }] },
      orderBy: { executedAt: "asc" },
    });

    const totalFillQuantity = fills.reduce((sum, f) => sum.plus(f.quantity), new Prisma.Decimal(0));
    const averageExecutionPrice = totalFillQuantity.isZero()
      ? null
      : fills
          .reduce((sum, f) => sum.plus(f.price.times(f.quantity)), new Prisma.Decimal(0))
          .dividedBy(totalFillQuantity)
          .toString();

    const reservation =
      order.side === OrderSide.BUY
        ? await this.prisma.fundReservation.findFirst({ where: { referenceType: "Order", referenceId: orderId, status: "ACTIVE" } })
        : await this.prisma.positionReservation.findFirst({ where: { referenceType: "Order", referenceId: orderId, status: "ACTIVE" } });
    const reservedAmountRemaining = reservation ? reservation.amount.minus(reservation.consumedAmount).toString() : "0";

    return {
      orderId: order.id,
      status: order.status,
      side: order.side,
      quantity: order.quantity.toString(),
      filledQuantity: order.filledQuantity.toString(),
      remainingQuantity: order.remainingQuantity.toString(),
      fills: fills.map((f) => ({
        fillId: f.id,
        price: f.price.toString(),
        quantity: f.quantity.toString(),
        executedAt: f.executedAt.toISOString(),
      })),
      averageExecutionPrice,
      reservedAmountRemaining,
    };
  }

  async cancel(userId: string, orderId: string): Promise<Order> {
    return this.txRunner.run(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) {
        throw new NotFoundException("Order not found");
      }
      if (order.userId !== userId) {
        throw new ForbiddenException("Not your order");
      }

      const result = await tx.order.updateMany({
        where: { id: orderId, status: { in: [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED] } },
        data: { status: OrderStatus.CANCELLED },
      });
      if (result.count === 0) {
        throw new BadRequestException(`Cannot cancel an order in status ${order.status}`);
      }

      if (order.side === OrderSide.BUY) {
        const reservation = await this.reservations.findActiveByReference(tx, "Order", orderId);
        if (reservation) {
          await this.reservations.release(tx, reservation.id);
        }
      } else {
        const reservation = await this.positionReservations.findActiveByReference(tx, "Order", orderId);
        if (reservation) {
          await this.positionReservations.release(tx, reservation.id);
        }
      }

      return tx.order.findUniqueOrThrow({ where: { id: orderId } });
    });
  }

  async getOwnOrder(userId: string, orderId: string): Promise<Order> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException("Order not found");
    }
    if (order.userId !== userId) {
      throw new ForbiddenException("Not your order");
    }
    return order;
  }

  /**
   * Paginated, same convention as DepositsService.listMine: an account's
   * order history is unbounded over time, and page/pageSize are clamped so
   * a malformed or hostile query param can't force an unbounded scan.
   */
  async listMine(
    userId: string,
    options: { page?: number; pageSize?: number; marketId?: string; status?: OrderStatus } = {},
  ): Promise<PaginatedOrders> {
    const safePage = Number.isFinite(options.page) && (options.page as number) >= 1 ? Math.trunc(options.page as number) : 1;
    const requestedPageSize =
      Number.isFinite(options.pageSize) && (options.pageSize as number) >= 1 ? Math.trunc(options.pageSize as number) : DEFAULT_PAGE_SIZE;
    const safePageSize = Math.min(MAX_PAGE_SIZE, requestedPageSize);

    const where: Prisma.OrderWhereInput = { userId };
    if (options.marketId) where.marketId = options.marketId;
    if (options.status) where.status = options.status;

    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (safePage - 1) * safePageSize,
        take: safePageSize,
        include: { market: true, outcome: true },
      }),
      this.prisma.order.count({ where }),
    ]);

    return { items: rows.map((row) => toOrderView(row)), total, page: safePage, pageSize: safePageSize };
  }

  /**
   * Terminates every still-resting (OPEN/PARTIALLY_FILLED) order for a
   * market and releases whatever each one's own reservation still
   * earmarks. Called by MarketsService.close() inside the SAME
   * transaction as the OPEN/PAUSED -> CLOSED status transition (`tx` is
   * the caller's own transaction client, not a fresh one opened here) so
   * the book's termination is atomic with the market leaving OPEN for
   * good. EXPIRED (not CANCELLED) marks this as a system-driven
   * termination distinct from a user's own OrdersService.cancel().
   *
   * Bounded by the same composite order-book index OrderBookService
   * relies on (marketId, outcomeId, side, status, price, sequence) — this
   * is naturally bounded by how many orders were ever resting for one
   * market, not a full-table scan.
   */
  async expireRestingOrdersForMarket(tx: Prisma.TransactionClient, marketId: string): Promise<number> {
    const restingOrders = await tx.order.findMany({
      where: { marketId, status: { in: [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED] } },
    });

    for (const order of restingOrders) {
      const result = await tx.order.updateMany({
        where: { id: order.id, status: order.status },
        data: { status: OrderStatus.EXPIRED },
      });
      if (result.count === 0) continue; // already changed by something else — nothing to release

      if (order.side === OrderSide.BUY) {
        const reservation = await this.reservations.findActiveByReference(tx, "Order", order.id);
        if (reservation) await this.reservations.release(tx, reservation.id);
      } else {
        const reservation = await this.positionReservations.findActiveByReference(tx, "Order", order.id);
        if (reservation) await this.positionReservations.release(tx, reservation.id);
      }
    }

    return restingOrders.length;
  }
}
