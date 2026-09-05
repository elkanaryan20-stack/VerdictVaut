import { Inject, Injectable, Logger } from "@nestjs/common";
import { Fill, MarketStatus, OrderStatus, Prisma } from "@prisma/client";
import { AccountRef, LedgerService } from "../../ledger/ledger.service";
import { ReservationService } from "../../ledger/reservation.service";
import { createIdempotent } from "../../prisma/idempotent-create.util";
import { PrismaService } from "../../prisma/prisma.service";
import { SerializableTransactionRunner } from "../../prisma/serializable-transaction-runner";
import { FEE_CALCULATOR, FeeCalculator } from "../fees/fee-calculator.interface";
import { ExecutionInstruction, MATCHING_ENGINE, MatchCandidate, MatchingEngine } from "../matching/matching-engine.interface";
import { OrderBookService } from "../order-book/order-book.service";
import { PositionReservationService } from "../positions/position-reservation.service";

/**
 * Turns MatchingEngine output into real, atomic, accounting-correct state
 * changes. This is the ONLY place that consumes reservations, posts trade
 * ledger transactions, creates Fills, or updates Positions as a result of
 * matching — the matcher itself never touches any of that.
 *
 * Architecture: candidate generation (reading resting orders, calling the
 * pure matcher) happens OUTSIDE any transaction — it is advisory only.
 * Each proposed ExecutionInstruction is then applied in its OWN dedicated
 * SERIALIZABLE transaction (via SerializableTransactionRunner) that
 * re-fetches and re-validates both orders' CURRENT state before doing
 * anything: this is what makes a stale candidate safe rather than
 * dangerous. Two consequences of this split:
 *
 *  - Crash safety: if the process dies after an order is created/funded
 *    but before matching runs, the order is simply left resting, exactly
 *    like any other never-yet-matched order — not a broken state.
 *  - Bounded work: a single order submission performs ONE matching pass
 *    over ONE candidate snapshot. If a candidate is invalidated by
 *    concurrent activity between snapshot and execution, that specific
 *    instruction is skipped — never blindly retried — and the order
 *    simply rests with whatever quantity remains. A later order
 *    submission (from any user) will naturally re-discover and match any
 *    liquidity this pass missed. Genuine Postgres serialization conflicts
 *    (as opposed to "this candidate is now stale") ARE retried, bounded,
 *    with backoff — via the same SerializableTransactionRunner every
 *    other financial mutation in this codebase uses.
 */
@Injectable()
export class ExecutionCoordinator {
  private readonly logger = new Logger(ExecutionCoordinator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly txRunner: SerializableTransactionRunner,
    private readonly orderBook: OrderBookService,
    private readonly ledger: LedgerService,
    private readonly reservations: ReservationService,
    private readonly positionReservations: PositionReservationService,
    @Inject(MATCHING_ENGINE) private readonly matchingEngine: MatchingEngine,
    @Inject(FEE_CALCULATOR) private readonly feeCalculator: FeeCalculator,
  ) {}

  /**
   * Attempts to match one (just-placed, or otherwise still-resting)
   * order against the current opposite-side book, applying whatever
   * executions result. Safe to call on an order that turns out to be
   * already terminal or market-closed (returns an empty array, not an
   * error) — callers do not need to pre-check.
   */
  async matchAndExecute(orderId: string): Promise<Fill[]> {
    const incomingOrder = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    if (incomingOrder.status !== OrderStatus.OPEN && incomingOrder.status !== OrderStatus.PARTIALLY_FILLED) {
      return [];
    }
    if (!incomingOrder.price) {
      // MARKET orders are rejected at intake (OrdersService) — this is
      // defensive, not a reachable path today.
      return [];
    }

    const market = await this.prisma.market.findUniqueOrThrow({ where: { id: incomingOrder.marketId } });
    if (!isMarketExecutable(market)) {
      return [];
    }

    const oppositeSide = incomingOrder.side === "BUY" ? "SELL" : "BUY";
    const restingCandidates = await this.orderBook.getRestingCandidates(
      incomingOrder.marketId,
      incomingOrder.outcomeId,
      oppositeSide,
    );

    const incomingCandidate: MatchCandidate = {
      orderId: incomingOrder.id,
      userId: incomingOrder.userId,
      side: incomingOrder.side,
      price: incomingOrder.price,
      remainingQuantity: incomingOrder.remainingQuantity,
      sequence: incomingOrder.sequence,
    };

    const instructions = this.matchingEngine.match(
      incomingOrder.marketId,
      incomingOrder.outcomeId,
      incomingCandidate,
      restingCandidates,
    );

    const fills: Fill[] = [];
    for (const instruction of instructions) {
      const fill = await this.applyExecution(instruction);
      if (fill) fills.push(fill);
    }
    return fills;
  }

  /**
   * Applies exactly one ExecutionInstruction, or safely does nothing.
   * Returns null when the instruction is no longer valid (a resting order
   * was cancelled/fully consumed by something else between candidate
   * generation and now, or the market closed in the meantime) — this is
   * an expected outcome under concurrency, not an error.
   */
  private async applyExecution(instruction: ExecutionInstruction): Promise<Fill | null> {
    return this.txRunner.run(async (tx) => {
      const [buyOrder, sellOrder, market] = await Promise.all([
        tx.order.findUniqueOrThrow({ where: { id: instruction.buyOrderId } }),
        tx.order.findUniqueOrThrow({ where: { id: instruction.sellOrderId } }),
        tx.market.findUniqueOrThrow({ where: { id: instruction.marketId } }),
      ]);

      if (!isMarketExecutable(market)) {
        this.logger.warn(
          `Skipping execution instruction — market no longer executable`,
          this.logContext(instruction),
        );
        return null;
      }

      if (!isOrderExecutable(buyOrder) || !isOrderExecutable(sellOrder)) {
        this.logger.warn(
          `Skipping stale execution instruction — an order is no longer executable`,
          this.logContext(instruction),
        );
        return null;
      }

      const instructionQuantity = new Prisma.Decimal(instruction.quantity);
      const executedQuantity = Prisma.Decimal.min(
        instructionQuantity,
        buyOrder.remainingQuantity,
        sellOrder.remainingQuantity,
      );
      if (executedQuantity.lessThanOrEqualTo(0)) {
        this.logger.warn(
          `Skipping stale execution instruction — no executable quantity remains`,
          this.logContext(instruction),
        );
        return null;
      }

      const executionPrice = new Prisma.Decimal(instruction.price);
      const feeResult = this.feeCalculator.calculateFillFee({
        marketId: instruction.marketId,
        outcomeId: instruction.outcomeId,
        price: executionPrice,
        quantity: executedQuantity,
        makerUserId: instruction.makerOrderId === instruction.buyOrderId ? instruction.buyerUserId : instruction.sellerUserId,
        takerUserId: instruction.takerOrderId === instruction.buyOrderId ? instruction.buyerUserId : instruction.sellerUserId,
      });
      const totalFee = feeResult.buyerFee.plus(feeResult.sellerFee);

      const { row: fill, alreadyExisted } = await createIdempotent(
        tx,
        "idempotencyKey",
        () =>
          tx.fill.create({
            data: {
              marketId: instruction.marketId,
              outcomeId: instruction.outcomeId,
              buyOrderId: instruction.buyOrderId,
              sellOrderId: instruction.sellOrderId,
              makerOrderId: instruction.makerOrderId,
              takerOrderId: instruction.takerOrderId,
              buyerUserId: instruction.buyerUserId,
              sellerUserId: instruction.sellerUserId,
              price: executionPrice,
              quantity: executedQuantity,
              fee: totalFee,
              idempotencyKey: instruction.idempotencyKey,
            },
          }),
        () => tx.fill.findUniqueOrThrow({ where: { idempotencyKey: instruction.idempotencyKey } }),
      );

      if (alreadyExisted) {
        this.logger.debug(`Execution instruction already applied — idempotent no-op`, this.logContext(instruction));
        return fill;
      }

      await this.consumeReservations(tx, buyOrder.id, sellOrder.id, executedQuantity, executionPrice);
      await this.postTradeLedger(tx, fill, instruction, executedQuantity, executionPrice, feeResult);
      await this.updateOrders(tx, buyOrder, sellOrder, executedQuantity);
      await this.updatePositions(tx, instruction, executedQuantity, executionPrice);

      this.logger.log(`Execution applied`, { ...this.logContext(instruction), fillId: fill.id, quantity: executedQuantity.toString() });
      return fill;
    });
  }

  private async consumeReservations(
    tx: Prisma.TransactionClient,
    buyOrderId: string,
    sellOrderId: string,
    executedQuantity: Prisma.Decimal,
    executionPrice: Prisma.Decimal,
  ): Promise<void> {
    const buyerReservation = await this.reservations.findActiveByReference(tx, "Order", buyOrderId);
    if (!buyerReservation) {
      throw new Error(`No active FundReservation for buy order ${buyOrderId} — cannot execute`);
    }
    // Consuming at the EXECUTION price (which may be better than the
    // buyer's own limit price) rather than the order's limit price is what
    // preserves price improvement: only the buyer's true cost is drawn
    // down, the rest of the reservation stays earmarked for the remaining
    // quantity (or is released in full when the order is later cancelled).
    await this.reservations.consume(tx, buyerReservation.id, executedQuantity.times(executionPrice));

    const sellerReservation = await this.positionReservations.findActiveByReference(tx, "Order", sellOrderId);
    if (!sellerReservation) {
      throw new Error(`No active PositionReservation for sell order ${sellOrderId} — cannot execute`);
    }
    await this.positionReservations.consume(tx, sellerReservation.id, executedQuantity);
  }

  private async postTradeLedger(
    tx: Prisma.TransactionClient,
    fill: Fill,
    instruction: ExecutionInstruction,
    executedQuantity: Prisma.Decimal,
    executionPrice: Prisma.Decimal,
    feeResult: { buyerFee: Prisma.Decimal; sellerFee: Prisma.Decimal },
  ): Promise<void> {
    const settlementAsset = await tx.asset.findFirstOrThrow({ where: { isSettlementCurrency: true } });
    const cost = executedQuantity.times(executionPrice);
    const buyerDebit = cost.plus(feeResult.buyerFee);
    const sellerCredit = cost.minus(feeResult.sellerFee);
    const totalFee = feeResult.buyerFee.plus(feeResult.sellerFee);

    const postings: Array<{ account: AccountRef; amount: Prisma.Decimal.Value }> = [
      { account: { type: "USER", userId: instruction.buyerUserId }, amount: buyerDebit.negated() },
      { account: { type: "USER", userId: instruction.sellerUserId }, amount: sellerCredit },
    ];
    if (!totalFee.isZero()) {
      postings.push({ account: { type: "HOUSE", key: "FEE_REVENUE" }, amount: totalFee });
    }

    await this.ledger.postTransaction(tx, {
      assetSymbol: settlementAsset.symbol,
      type: "TRADE",
      referenceType: "Fill",
      referenceId: fill.id,
      idempotencyKey: `trade:${fill.id}`,
      postings,
    });
  }

  private async updateOrders(
    tx: Prisma.TransactionClient,
    buyOrder: { id: string; filledQuantity: Prisma.Decimal; remainingQuantity: Prisma.Decimal },
    sellOrder: { id: string; filledQuantity: Prisma.Decimal; remainingQuantity: Prisma.Decimal },
    executedQuantity: Prisma.Decimal,
  ): Promise<void> {
    for (const order of [buyOrder, sellOrder]) {
      const newFilled = order.filledQuantity.plus(executedQuantity);
      const newRemaining = order.remainingQuantity.minus(executedQuantity);
      const result = await tx.order.updateMany({
        where: { id: order.id, remainingQuantity: order.remainingQuantity },
        data: {
          filledQuantity: newFilled,
          remainingQuantity: newRemaining,
          status: newRemaining.isZero() ? OrderStatus.FILLED : OrderStatus.PARTIALLY_FILLED,
        },
      });
      if (result.count === 0) {
        // Should be unreachable under SERIALIZABLE (a concurrent writer
        // would instead abort this whole transaction with a serialization
        // failure) — this CAS is a defensive backstop, not the primary
        // concurrency guard.
        throw new Error(`Order ${order.id} changed unexpectedly mid-execution`);
      }
    }
  }

  private async updatePositions(
    tx: Prisma.TransactionClient,
    instruction: ExecutionInstruction,
    executedQuantity: Prisma.Decimal,
    executionPrice: Prisma.Decimal,
  ): Promise<void> {
    const buyerPosition = await tx.position.upsert({
      where: {
        userId_marketId_outcomeId: {
          userId: instruction.buyerUserId,
          marketId: instruction.marketId,
          outcomeId: instruction.outcomeId,
        },
      },
      create: {
        userId: instruction.buyerUserId,
        marketId: instruction.marketId,
        outcomeId: instruction.outcomeId,
        quantity: 0,
        reservedQuantity: 0,
        avgPrice: 0,
        realizedPnl: 0,
      },
      update: {},
    });
    const newBuyerQuantity = buyerPosition.quantity.plus(executedQuantity);
    const newBuyerAvgPrice = buyerPosition.quantity.isZero()
      ? executionPrice
      : buyerPosition.quantity
          .times(buyerPosition.avgPrice)
          .plus(executedQuantity.times(executionPrice))
          .dividedBy(newBuyerQuantity);
    await tx.position.update({
      where: { id: buyerPosition.id },
      data: { quantity: newBuyerQuantity, avgPrice: newBuyerAvgPrice },
    });

    // The seller's Position must already exist — a SELL order can only be
    // placed by reserving shares out of an existing Position (see
    // PositionReservationService.reserve), never fabricated here.
    const sellerPosition = await tx.position.findUniqueOrThrow({
      where: {
        userId_marketId_outcomeId: {
          userId: instruction.sellerUserId,
          marketId: instruction.marketId,
          outcomeId: instruction.outcomeId,
        },
      },
    });
    // Standard realized-P&L on disposal: (sale price - average cost basis)
    // * quantity sold. This is ordinary trading P&L, computed the instant
    // shares change hands — entirely independent of, and not a substitute
    // for, market settlement/resolution payouts (out of scope this phase).
    const realizedPnlDelta = executionPrice.minus(sellerPosition.avgPrice).times(executedQuantity);
    await tx.position.update({
      where: { id: sellerPosition.id },
      data: {
        quantity: sellerPosition.quantity.minus(executedQuantity),
        realizedPnl: sellerPosition.realizedPnl.plus(realizedPnlDelta),
      },
    });
  }

  private logContext(instruction: ExecutionInstruction) {
    return {
      idempotencyKey: instruction.idempotencyKey,
      marketId: instruction.marketId,
      outcomeId: instruction.outcomeId,
      buyOrderId: instruction.buyOrderId,
      sellOrderId: instruction.sellOrderId,
    };
  }
}

function isMarketExecutable(market: { status: MarketStatus; closeTime: Date | null }): boolean {
  if (market.status !== MarketStatus.OPEN) return false;
  if (market.closeTime && market.closeTime.getTime() <= Date.now()) return false;
  return true;
}

function isOrderExecutable(order: { status: OrderStatus }): boolean {
  return order.status === OrderStatus.OPEN || order.status === OrderStatus.PARTIALLY_FILLED;
}
