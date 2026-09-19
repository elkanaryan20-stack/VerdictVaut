import { Inject, Injectable, Logger } from "@nestjs/common";
import { CompleteSetMint, Fill, MarketStatus, OrderSide, OrderStatus, Prisma } from "@prisma/client";
import { AccountRef, LedgerService } from "../../ledger/ledger.service";
import { ReservationService } from "../../ledger/reservation.service";
import { createIdempotent } from "../../prisma/idempotent-create.util";
import { PrismaService } from "../../prisma/prisma.service";
import { SerializableTransactionRunner } from "../../prisma/serializable-transaction-runner";
import { COMPLETE_SET_MINT_ENGINE, CompleteSetMintEngine, MintInstruction } from "../matching/complete-set-mint-engine.interface";
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
    @Inject(COMPLETE_SET_MINT_ENGINE) private readonly mintEngine: CompleteSetMintEngine,
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

    // Complementary complete-set minting (Phase 12A) — only ever
    // attempted for the BUY side, and only once ordinary same-outcome
    // matching above has already had first crack at any existing
    // inventory (preserves every pre-existing behavior/test unchanged
    // when a real seller is available; minting only ever fills the
    // otherwise-impossible "no seller exists yet" gap). Re-reads the
    // order's CURRENT remaining quantity rather than trusting the
    // pre-loop snapshot, since the loop above may have just consumed
    // some of it.
    if (incomingOrder.side === "BUY") {
      await this.attemptComplementaryMint(orderId, market.id);
    }

    return fills;
  }

  /**
   * Attempts to mint complete sets against the current order's
   * complementary outcome, for whatever quantity same-outcome matching
   * (above) didn't already fill. No-ops (never throws) for a market that
   * isn't exactly binary — see CompleteSetMintEngine's docblock for why
   * that boundary exists — or once the order has no remaining quantity.
   */
  private async attemptComplementaryMint(orderId: string, marketId: string): Promise<CompleteSetMint[]> {
    const outcomes = await this.prisma.marketOutcome.findMany({ where: { marketId } });
    if (outcomes.length !== 2) {
      return [];
    }

    const current = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    if (!isOrderExecutable(current) || !current.price || current.remainingQuantity.lessThanOrEqualTo(0)) {
      return [];
    }

    const complementaryOutcome = outcomes.find((o) => o.id !== current.outcomeId);
    if (!complementaryOutcome) {
      return [];
    }

    const restingComplementary = await this.orderBook.getRestingCandidates(marketId, complementaryOutcome.id, "BUY");
    const incomingCandidate: MatchCandidate = {
      orderId: current.id,
      userId: current.userId,
      side: current.side,
      price: current.price,
      remainingQuantity: current.remainingQuantity,
      sequence: current.sequence,
    };

    const instructions = this.mintEngine.match(
      marketId,
      current.outcomeId,
      complementaryOutcome.id,
      incomingCandidate,
      restingComplementary,
    );

    const mints: CompleteSetMint[] = [];
    for (const instruction of instructions) {
      const mint = await this.applyMintExecution(instruction);
      if (mint) mints.push(mint);
    }
    return mints;
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
      // Phase 32 — the DB-level fills_fee_non_negative_check only
      // constrains the SUMMED fee column; it would silently accept a
      // buggy/malicious FeeCalculator returning e.g. buyerFee: -5,
      // sellerFee: +5 (totalFee 0 passes the check) while actually
      // discounting the buyer and shorting the seller by 5 each,
      // undetectable in aggregate. Reject either leg going negative at
      // the source, before it ever reaches a ledger posting.
      if (feeResult.buyerFee.isNegative() || feeResult.sellerFee.isNegative()) {
        throw new Error(
          `FeeCalculator returned a negative fee leg (buyerFee=${feeResult.buyerFee}, sellerFee=${feeResult.sellerFee}) for instruction ${instruction.idempotencyKey} — refusing to post trade ledger`,
        );
      }
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
      // Phase 31 fix — see releaseReservationIfOrderNowFilled's own
      // docblock for the real bug this closes: consumeReservations()
      // above only ever consumes the trade's actual cost, never the
      // reservation's FULL earmarked amount (which is sized off the
      // order's own limit price / fee buffer, both >= actual cost by
      // design) — so whenever price improvement or a fee buffer leaves
      // a nonzero unconsumed remainder AND this fill is what brings the
      // order to FILLED, that remainder was previously never released,
      // permanently locking part of the user's real balance as
      // phantom "reserved."
      await this.releaseReservationIfOrderNowFilled(tx, buyOrder, executedQuantity);
      await this.releaseReservationIfOrderNowFilled(tx, sellOrder, executedQuantity);

      this.logger.log(`Execution applied`, { ...this.logContext(instruction), fillId: fill.id, quantity: executedQuantity.toString() });
      return fill;
    });
  }

  /**
   * Releases whatever remains unconsumed in an order's own reservation
   * the instant that order reaches FILLED (remainingQuantity hits
   * zero) — a no-op (releases exactly 0) when the reservation was
   * already fully consumed, which is why this is safe to call
   * unconditionally on every execution rather than only when a
   * remainder is suspected. Still resting orders (remainingQuantity >
   * 0 after this fill) are correctly left untouched: the unconsumed
   * portion of their reservation legitimately still earmarks funds/
   * shares for whatever quantity remains open, exactly as
   * cancel()/expireRestingOrdersForMarket() already rely on.
   *
   * A genuine, previously-undiscovered bug (Phase 31 adversarial
   * certification): before this fix, a BUY order that filled at a
   * BETTER price than its own limit (ordinary price improvement — see
   * PriceTimePriorityMatchingEngine's own docblock, always uses the
   * MAKER's price) or whose fee-estimate buffer exceeded the real fee
   * charged, left its FundReservation permanently ACTIVE with a
   * nonzero unconsumed amount once FILLED — cancel() only accepts
   * OPEN/PARTIALLY_FILLED, so a FILLED order's reservation could never
   * reach RELEASED any other way. The user's real cachedBalance was
   * always correct (the ledger is authoritative and unaffected by
   * this bug), but their AVAILABLE balance was permanently understated
   * by the stuck remainder — real funds a user owned but could never
   * actually place a new order with. ZeroFeeCalculator (ceiling on
   * both fee buffer and fee itself) masked the fee-based half of this;
   * ordinary price improvement made the OTHER half reachable in
   * completely ordinary trading, unrelated to fees at all.
   */
  private async releaseReservationIfOrderNowFilled(
    tx: Prisma.TransactionClient,
    order: { id: string; side: OrderSide; remainingQuantity: Prisma.Decimal },
    executedQuantity: Prisma.Decimal,
  ): Promise<void> {
    if (!order.remainingQuantity.minus(executedQuantity).isZero()) {
      return;
    }
    if (order.side === "BUY") {
      const reservation = await this.reservations.findActiveByReference(tx, "Order", order.id);
      if (reservation) await this.reservations.release(tx, reservation.id);
    } else {
      const reservation = await this.positionReservations.findActiveByReference(tx, "Order", order.id);
      if (reservation) await this.positionReservations.release(tx, reservation.id);
    }
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

  /**
   * Increases (or creates) a user's position by `executedQuantity` at
   * `price`, maintaining a quantity-weighted average cost basis. Shared
   * by ordinary trade fills (a BUY acquiring shares from a seller) and
   * complete-set mints (Phase 12A — both buyers acquire their own
   * outcome's shares, created fresh rather than transferred) since the
   * position-side bookkeeping is identical either way; only the ledger
   * accounting and the counterparty differ, and both are handled by
   * each call site separately.
   */
  private async increaseBuyerPosition(
    tx: Prisma.TransactionClient,
    userId: string,
    marketId: string,
    outcomeId: string,
    executedQuantity: Prisma.Decimal,
    price: Prisma.Decimal,
  ): Promise<void> {
    const position = await tx.position.upsert({
      where: { userId_marketId_outcomeId: { userId, marketId, outcomeId } },
      create: { userId, marketId, outcomeId, quantity: 0, reservedQuantity: 0, avgPrice: 0, realizedPnl: 0 },
      update: {},
    });
    const newQuantity = position.quantity.plus(executedQuantity);
    const newAvgPrice = position.quantity.isZero()
      ? price
      : position.quantity.times(position.avgPrice).plus(executedQuantity.times(price)).dividedBy(newQuantity);
    await tx.position.update({
      where: { id: position.id },
      data: { quantity: newQuantity, avgPrice: newAvgPrice },
    });
  }

  private async updatePositions(
    tx: Prisma.TransactionClient,
    instruction: ExecutionInstruction,
    executedQuantity: Prisma.Decimal,
    executionPrice: Prisma.Decimal,
  ): Promise<void> {
    await this.increaseBuyerPosition(tx, instruction.buyerUserId, instruction.marketId, instruction.outcomeId, executedQuantity, executionPrice);

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

  /**
   * Applies exactly one MintInstruction, or safely does nothing — the
   * complete-set-mint counterpart to applyExecution, same shape and same
   * reasoning throughout (own dedicated SERIALIZABLE transaction,
   * re-fetches and re-validates both orders' CURRENT state, returns null
   * for a no-longer-valid instruction rather than throwing).
   */
  private async applyMintExecution(instruction: MintInstruction): Promise<CompleteSetMint | null> {
    return this.txRunner.run(async (tx) => {
      const [buyOrderA, buyOrderB, market] = await Promise.all([
        tx.order.findUniqueOrThrow({ where: { id: instruction.buyOrderAId } }),
        tx.order.findUniqueOrThrow({ where: { id: instruction.buyOrderBId } }),
        tx.market.findUniqueOrThrow({ where: { id: instruction.marketId } }),
      ]);

      if (!isMarketExecutable(market)) {
        this.logger.warn(`Skipping mint instruction — market no longer executable`, this.mintLogContext(instruction));
        return null;
      }
      if (!isOrderExecutable(buyOrderA) || !isOrderExecutable(buyOrderB)) {
        this.logger.warn(`Skipping stale mint instruction — an order is no longer executable`, this.mintLogContext(instruction));
        return null;
      }

      const instructionQuantity = new Prisma.Decimal(instruction.quantity);
      const executedQuantity = Prisma.Decimal.min(instructionQuantity, buyOrderA.remainingQuantity, buyOrderB.remainingQuantity);
      if (executedQuantity.lessThanOrEqualTo(0)) {
        this.logger.warn(`Skipping stale mint instruction — no executable quantity remains`, this.mintLogContext(instruction));
        return null;
      }

      const priceA = new Prisma.Decimal(instruction.priceA);
      const priceB = new Prisma.Decimal(instruction.priceB);

      const { row: mint, alreadyExisted } = await createIdempotent(
        tx,
        "idempotencyKey",
        () =>
          tx.completeSetMint.create({
            data: {
              marketId: instruction.marketId,
              outcomeAId: instruction.outcomeAId,
              outcomeBId: instruction.outcomeBId,
              buyOrderAId: instruction.buyOrderAId,
              buyOrderBId: instruction.buyOrderBId,
              buyerAUserId: instruction.buyerAUserId,
              buyerBUserId: instruction.buyerBUserId,
              priceA,
              priceB,
              quantity: executedQuantity,
              idempotencyKey: instruction.idempotencyKey,
            },
          }),
        () => tx.completeSetMint.findUniqueOrThrow({ where: { idempotencyKey: instruction.idempotencyKey } }),
      );

      if (alreadyExisted) {
        this.logger.debug(`Mint instruction already applied — idempotent no-op`, this.mintLogContext(instruction));
        return mint;
      }

      const buyerAReservation = await this.reservations.findActiveByReference(tx, "Order", buyOrderA.id);
      if (!buyerAReservation) {
        throw new Error(`No active FundReservation for buy order ${buyOrderA.id} — cannot mint`);
      }
      await this.reservations.consume(tx, buyerAReservation.id, executedQuantity.times(priceA));

      const buyerBReservation = await this.reservations.findActiveByReference(tx, "Order", buyOrderB.id);
      if (!buyerBReservation) {
        throw new Error(`No active FundReservation for buy order ${buyOrderB.id} — cannot mint`);
      }
      await this.reservations.consume(tx, buyerBReservation.id, executedQuantity.times(priceB));

      await this.postMintLedger(tx, mint, instruction, executedQuantity, priceA, priceB);
      await this.updateOrders(tx, buyOrderA, buyOrderB, executedQuantity);
      await this.increaseBuyerPosition(tx, instruction.buyerAUserId, instruction.marketId, instruction.outcomeAId, executedQuantity, priceA);
      await this.increaseBuyerPosition(tx, instruction.buyerBUserId, instruction.marketId, instruction.outcomeBId, executedQuantity, priceB);
      // Same Phase 31 fix as applyExecution's own — see
      // releaseReservationIfOrderNowFilled's docblock. A mint's price
      // improvement ("any gap is the incoming side's price improvement,
      // never destroyed" — complete-set-mint-engine.ts's own comment) is
      // exactly the same reservation-leak shape as an ordinary trade's.
      await this.releaseReservationIfOrderNowFilled(tx, buyOrderA, executedQuantity);
      await this.releaseReservationIfOrderNowFilled(tx, buyOrderB, executedQuantity);

      this.logger.log(`Complete set minted`, { ...this.mintLogContext(instruction), mintId: mint.id, quantity: executedQuantity.toString() });
      return mint;
    });
  }

  private async postMintLedger(
    tx: Prisma.TransactionClient,
    mint: CompleteSetMint,
    instruction: MintInstruction,
    executedQuantity: Prisma.Decimal,
    priceA: Prisma.Decimal,
    priceB: Prisma.Decimal,
  ): Promise<void> {
    const settlementAsset = await tx.asset.findFirstOrThrow({ where: { isSettlementCurrency: true } });
    const costA = executedQuantity.times(priceA);
    const costB = executedQuantity.times(priceB);

    // Balances to zero: -costA - costB + (costA + costB) = 0. This is the
    // one and only place real collateral is created — always exactly 1
    // unit of settlement currency per unit of quantity minted (priceA +
    // priceB = 1, enforced by complete_set_mints_price_sum_check), never
    // more, never less, never fabricated.
    await this.ledger.postTransaction(tx, {
      assetSymbol: settlementAsset.symbol,
      type: "MINT",
      referenceType: "CompleteSetMint",
      referenceId: mint.id,
      idempotencyKey: `mint:${mint.id}`,
      postings: [
        { account: { type: "USER", userId: instruction.buyerAUserId }, amount: costA.negated() },
        { account: { type: "USER", userId: instruction.buyerBUserId }, amount: costB.negated() },
        { account: { type: "MARKET", marketId: instruction.marketId }, amount: costA.plus(costB) },
      ],
    });
  }

  private mintLogContext(instruction: MintInstruction) {
    return {
      idempotencyKey: instruction.idempotencyKey,
      marketId: instruction.marketId,
      outcomeAId: instruction.outcomeAId,
      outcomeBId: instruction.outcomeBId,
      buyOrderAId: instruction.buyOrderAId,
      buyOrderBId: instruction.buyOrderBId,
    };
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
