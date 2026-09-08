import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, UserRole, UserStatus, Withdrawal, WithdrawalComplianceDecision, WithdrawalStatus } from "@prisma/client";
import * as crypto from "crypto";
import { AuditLogService } from "../../audit/audit-log.service";
import { AccountRef, LedgerService } from "../../ledger/ledger.service";
import { ReservationService } from "../../ledger/reservation.service";
import { createIdempotent } from "../../prisma/idempotent-create.util";
import { PrismaService } from "../../prisma/prisma.service";
import { SerializableTransactionRunner } from "../../prisma/serializable-transaction-runner";
import { CustodyProviderFactory } from "../custody/custody-provider.factory";
import { WithdrawalExecutorFactory } from "../executors/withdrawal-executor.factory";
import {
  WITHDRAWAL_COMPLIANCE_GATE,
  WithdrawalComplianceGate,
} from "./compliance/withdrawal-compliance-gate.interface";
import { assertValidDestinationAddress } from "./destination-address.validator";
import { RequestWithdrawalDto } from "./dto/request-withdrawal.dto";
import { WITHDRAWAL_FEE_CALCULATOR, WithdrawalFeeCalculator } from "./fees/withdrawal-fee-calculator.interface";

/** Statuses where a broadcast withdrawal's reservation has NOT yet been released — see reconcile(). */
const RESERVATION_STILL_HELD_STATUSES = new Set<WithdrawalStatus>([
  WithdrawalStatus.BROADCAST,
  WithdrawalStatus.CONFIRMING,
  WithdrawalStatus.CONFIRMED,
  WithdrawalStatus.CREDITED,
]);

/** Statuses where the reservation has already been released back to the user — see reconcile(). */
const RESERVATION_RELEASED_STATUSES = new Set<WithdrawalStatus>([WithdrawalStatus.REJECTED, WithdrawalStatus.FAILED]);

// Pure floating/rounding slack, not a real discrepancy allowance — mirrors ReconciliationService's own RECONCILIATION_TOLERANCE.
const WITHDRAWAL_RECONCILE_AMOUNT_TOLERANCE = new Prisma.Decimal("0.000000000000000001");

/**
 * EVM hex addresses are case-insensitive (EIP-55 checksum casing is a
 * display convention, not a distinct address) — compared lowercased.
 * XRP base58 addresses ARE case-sensitive; compared exactly. Detecting
 * "looks like an EVM address" by its 0x prefix avoids needing to thread
 * the network family into reconcile() just for this comparison.
 */
function destinationsMatch(observed: string, recorded: string): boolean {
  if (observed.startsWith("0x") && recorded.startsWith("0x")) {
    return observed.toLowerCase() === recorded.toLowerCase();
  }
  return observed === recorded;
}

/**
 * Explicit withdrawal state machine:
 *
 *   REQUESTED -> RISK_REVIEW -> APPROVED -> BROADCASTING (execution lease — see approve())
 *     -> PENDING_MANUAL_BROADCAST -> BROADCAST   (sandbox / ManualBroadcastExecutor)
 *     -> BROADCAST                                (production / ProductionCustodyExecutor)
 *   BROADCAST -> CONFIRMING -> CONFIRMED -> CREDITED
 *   (REQUESTED/RISK_REVIEW only)          -> CANCELLED  — user-initiated, see cancel()
 *   (REQUESTED/RISK_REVIEW/APPROVED only) -> REJECTED   — admin-initiated, releases the reservation
 *   (APPROVED/PENDING_MANUAL_BROADCAST/BROADCASTING/BROADCAST/CONFIRMING) -> FAILED — system-initiated, releases the reservation
 *
 * BROADCASTING is deliberately NOT a valid reject() source — it exists
 * purely as approve()'s execution lease, held for exactly as long as the
 * executor.execute() call is in flight, so reject() can never race a
 * genuinely-in-progress broadcast (see approve()'s own docblock).
 *
 * Funds are RESERVED (not moved) at request time via FundReservation —
 * this immediately reduces what's available without touching total
 * balance, because nothing has actually left the system yet. The
 * reservation is only ever released (cancel/reject/fail) or captured
 * (confirmed — at which point a real LedgerTransaction finally moves the
 * total balance to the EXTERNAL_CHAIN house account, because that's the
 * point real funds left).
 *
 * Every state transition below is a guarded compare-and-swap: the DB
 * update's WHERE clause requires the row to still be in the expected
 * prior status, and a 0-row result means a concurrent call already
 * transitioned it — so two concurrent (or double-clicked/retried) calls
 * to approve/reject/fail/cancel/broadcast can never both succeed, and a
 * reservation can never be released or captured twice.
 *
 * Phase 9 additions: withdrawal creation is idempotent (clientWithdrawalId,
 * the counterpart to Order.clientOrderId — see request()); every request
 * is assessed by a WithdrawalComplianceGate and priced by a
 * WithdrawalFeeCalculator (both explicit, swappable seams — see their own
 * interfaces); approve()/reject() independently re-verify SUPER_ADMIN
 * (defense in depth behind RolesGuard, matching ResolutionService); and
 * WithdrawalWatcherService now actually calls recordConfirmation() with
 * real observed chain data (previously dead code — see the Phase 8 audit
 * note this replaces).
 */
@Injectable()
export class WithdrawalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly reservations: ReservationService,
    private readonly executorFactory: WithdrawalExecutorFactory,
    private readonly custodyProviderFactory: CustodyProviderFactory,
    private readonly txRunner: SerializableTransactionRunner,
    private readonly auditLog: AuditLogService,
    @Inject(WITHDRAWAL_FEE_CALCULATOR) private readonly feeCalculator: WithdrawalFeeCalculator,
    @Inject(WITHDRAWAL_COMPLIANCE_GATE) private readonly complianceGate: WithdrawalComplianceGate,
  ) {}

  async request(userId: string, dto: RequestWithdrawalDto) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException("Account must be verified (ACTIVE) before withdrawing funds");
    }

    const asset = await this.prisma.asset.findUnique({ where: { symbol: dto.assetSymbol } });
    const network = await this.prisma.network.findUnique({ where: { code: dto.networkCode } });
    if (!asset || !network) {
      throw new BadRequestException("Unknown asset symbol or network code");
    }

    const assetNetwork = await this.prisma.assetNetwork.findUnique({
      where: { assetId_networkId: { assetId: asset.id, networkId: network.id } },
    });
    if (!assetNetwork || !assetNetwork.isActive) {
      throw new BadRequestException(`${dto.assetSymbol} withdrawals are not currently supported on ${dto.networkCode}`);
    }

    const amount = new Prisma.Decimal(dto.amount);
    if (amount.lessThanOrEqualTo(assetNetwork.withdrawalMinAmount)) {
      throw new BadRequestException(`Amount must be greater than the minimum withdrawal of ${assetNetwork.withdrawalMinAmount}`);
    }

    if (assetNetwork.memoRequired && !dto.destinationTag) {
      throw new BadRequestException(`${dto.networkCode} requires a destination tag/memo`);
    }

    assertValidDestinationAddress(network.family, dto.destinationAddress);

    // Deducted FROM `amount` (never added on top) — see
    // WithdrawalFeeCalculator's docblock. Pure computation, no DB
    // access, so safe to run before the transaction — always zero today
    // (ZeroWithdrawalFeeCalculator), but the reservation/ledger math
    // below is already correct for when it isn't.
    const { fee } = this.feeCalculator.calculateWithdrawalFee({ assetSymbol: asset.symbol, networkCode: network.code, amount });
    if (fee.greaterThanOrEqualTo(amount)) {
      throw new BadRequestException("The configured withdrawal fee would consume the entire withdrawal amount");
    }

    // The explicit compliance integration boundary — see
    // WithdrawalComplianceGate's docblock. Never silently skipped, never
    // silently treated as passed: the decision (PASS/BLOCKED/DEFERRED) is
    // always recorded on the row itself. Run outside the SERIALIZABLE
    // transaction below for the same reason the fee calculator is: today's
    // DeferredComplianceGate is pure computation, but this is the real
    // integration seam for a future network-bound KYC/AML/sanctions call,
    // and a call like that must never sit inside SerializableTransactionRunner's
    // retry loop — a serialization conflict elsewhere in the transaction
    // (e.g. the risk-limit read below) would otherwise silently re-issue an
    // external compliance call and hold the DB transaction open across an
    // HTTP round-trip on every retry.
    const compliance = await this.complianceGate.assess({
      userId,
      assetSymbol: asset.symbol,
      networkCode: network.code,
      amount,
      destinationAddress: dto.destinationAddress,
    });
    if (compliance.decision === WithdrawalComplianceDecision.BLOCKED) {
      throw new ForbiddenException(compliance.reason ?? "This withdrawal was blocked by compliance policy.");
    }

    // Idempotency key — the withdrawal counterpart to
    // CreateOrderDto.clientOrderId. A retried or genuinely concurrent
    // duplicate submission is detected via the same SAVEPOINT-based
    // createIdempotent primitive OrdersService.create() uses, and
    // returns the original withdrawal rather than creating a second one
    // or reserving funds twice.
    const clientWithdrawalId = dto.clientWithdrawalId ?? crypto.randomUUID();

    const withdrawal = await this.txRunner.run(async (tx) => {
      const { row: created, alreadyExisted } = await createIdempotent(
        tx,
        "clientWithdrawalId",
        async () => {
          // RiskLimit.maxDailyWithdrawal is opt-in (null = unlimited, same
          // convention as OrderRiskValidator) — when configured, it caps this
          // asset's own withdrawal volume (requested, in-flight, or already
          // moved — everything except REJECTED/FAILED/CANCELLED, which never
          // happened economically — see cancel()'s own docblock) over a
          // trailing 24h window. Read and enforced INSIDE this same
          // SERIALIZABLE transaction, before the new row is created, so two
          // concurrent requests that would each individually fit under the cap
          // but jointly exceed it are caught by Postgres's own serializable
          // conflict detection (the same phantom-read protection
          // OrderRiskValidator.checkMarketExposure relies on) rather than by
          // an application-level lock.
          const riskLimit = await tx.riskLimit.findUnique({ where: { userId } });
          if (riskLimit?.maxDailyWithdrawal) {
            const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const recent = await tx.withdrawal.findMany({
              where: {
                userId,
                assetNetwork: { assetId: asset.id },
                status: { notIn: [WithdrawalStatus.REJECTED, WithdrawalStatus.FAILED, WithdrawalStatus.CANCELLED] },
                createdAt: { gte: since },
              },
              select: { amount: true },
            });
            const alreadyRequested = recent.reduce((sum, w) => sum.plus(w.amount), new Prisma.Decimal(0));
            if (alreadyRequested.plus(amount).greaterThan(riskLimit.maxDailyWithdrawal)) {
              throw new BadRequestException(
                `This withdrawal would exceed your configured daily withdrawal limit of ${riskLimit.maxDailyWithdrawal.toString()} ${asset.symbol} ` +
                  `(already requested ${alreadyRequested.toString()} in the last 24 hours)`,
              );
            }
          }

          return tx.withdrawal.create({
            data: {
              userId,
              assetNetworkId: assetNetwork.id,
              destinationAddress: dto.destinationAddress,
              destinationTag: dto.destinationTag,
              amount,
              fee,
              clientWithdrawalId,
              complianceDecision: compliance.decision,
              complianceNote: compliance.reason,
              status: WithdrawalStatus.REQUESTED,
            },
          });
        },
        () => tx.withdrawal.findUniqueOrThrow({ where: { userId_clientWithdrawalId: { userId, clientWithdrawalId } } }),
      );

      if (alreadyExisted) {
        return created;
      }

      // Earmarks the funds (reservedBalance) — total balance is untouched
      // until the withdrawal is actually confirmed on-chain. Reserves
      // exactly `amount` (not amount + fee) — the fee is deducted from
      // what's sent on-chain, never added on top of the user's own debit.
      await this.reservations.reserve(tx, {
        userId,
        assetSymbol: asset.symbol,
        amount,
        referenceType: "Withdrawal",
        referenceId: created.id,
        idempotencyKey: `withdrawal-reserve:${created.id}`,
      });

      return tx.withdrawal.update({ where: { id: created.id }, data: { status: WithdrawalStatus.RISK_REVIEW } });
    });

    await this.auditLog.record({
      actorId: userId,
      actorType: "USER",
      action: "withdrawal.request",
      resourceType: "Withdrawal",
      resourceId: withdrawal.id,
      after: {
        status: withdrawal.status,
        amount: withdrawal.amount.toString(),
        fee: withdrawal.fee.toString(),
        assetSymbol: asset.symbol,
        networkCode: network.code,
        complianceDecision: withdrawal.complianceDecision,
      },
      idempotencyKey: withdrawal.id,
    });

    return withdrawal;
  }

  /**
   * Admin-facing single-withdrawal read (also used internally for
   * before/after audit snapshots around approve/reject/broadcast).
   * Includes the asset/network join so a caller never has to resolve a
   * bare assetNetworkId itself, matching DepositsService.getById's own
   * shape.
   */
  async getById(withdrawalId: string) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
      include: { user: { select: { id: true, email: true } }, assetNetwork: { include: { asset: true, network: true } } },
    });
    if (!withdrawal) {
      throw new NotFoundException("Withdrawal not found");
    }
    return withdrawal;
  }

  /** Owner-scoped read — IDOR-safe: a mismatched userId is reported as NotFound, never Forbidden (never confirms the withdrawal exists at all to a non-owner). */
  async getOwned(userId: string, withdrawalId: string) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
      include: { assetNetwork: { include: { asset: true, network: true } } },
    });
    if (!withdrawal || withdrawal.userId !== userId) {
      throw new NotFoundException("Withdrawal not found");
    }
    return withdrawal;
  }

  /**
   * User-initiated cancellation — the counterpart to admin-initiated
   * reject(). Only reachable before SUPER_ADMIN review has acted (once
   * APPROVED, the withdrawal may already be mid-execution; only an admin
   * can reject/fail it from there). IDOR-safe the same way OrdersService
   * .cancel() is: ownership is checked before the CAS, and a mismatched
   * owner sees the same NotFoundException a genuinely-missing withdrawal
   * would, never confirming another user's withdrawal exists.
   */
  async cancel(userId: string, withdrawalId: string) {
    const owned = await this.getOrThrow(withdrawalId);
    if (owned.userId !== userId) {
      throw new NotFoundException("Withdrawal not found");
    }

    const withdrawal = await this.txRunner.run(async (tx) => {
      const result = await this.casTransition(tx, withdrawalId, [WithdrawalStatus.REQUESTED, WithdrawalStatus.RISK_REVIEW], {
        status: WithdrawalStatus.CANCELLED,
      });

      const reservation = await this.reservations.findActiveByReference(tx, "Withdrawal", withdrawalId);
      if (reservation) {
        await this.reservations.release(tx, reservation.id);
      }

      return result;
    });

    await this.auditLog.record({
      actorId: userId,
      actorType: "USER",
      action: "withdrawal.cancel",
      resourceType: "Withdrawal",
      resourceId: withdrawalId,
      before: { status: owned.status },
      after: { status: withdrawal.status },
    });

    return withdrawal;
  }

  /**
   * BROADCAST SAFETY (requirement #16): TWO CASes together form the
   * execution lease, not one. RISK_REVIEW -> APPROVED is the human
   * decision; APPROVED -> BROADCASTING (immediately after, before the
   * executor is ever called) is what actually gives exactly one caller
   * exclusive ownership of "may call the executor for this withdrawal".
   * This second CAS matters because reject() is a valid transition FROM
   * APPROVED (an admin can still reject an approved-but-not-yet-executed
   * withdrawal) — without it, reject() could race a genuinely in-flight
   * executor.execute() call and win, releasing the reservation and
   * marking the withdrawal REJECTED at the exact moment a real custody
   * provider actually broadcasts, with no record of the broadcast ever
   * persisted (its follow-up CAS would fail against the by-then-REJECTED
   * row). BROADCASTING is not in reject()'s allowedFrom set, so once this
   * lease is acquired, reject() cannot touch the row until execute()
   * itself has fully settled.
   *
   * If execute() throws, the withdrawal is moved back to APPROVED (lease
   * released, reservation still intact) and the original error is
   * rethrown — reject() becomes reachable again, exactly the recovery
   * path this method has always documented. If execute() never settles
   * at all (a hang, not a throw — the one case this lease cannot
   * distinguish from "still genuinely broadcasting"), the row is left
   * stuck in BROADCASTING with no automatic recovery: that is the
   * intended fail-safe per the platform's own broadcast-safety rule ("if
   * custody times out after a possible broadcast, do NOT blindly retry —
   * query/reconcile instead"), not a bug — a stuck lease requires
   * explicit investigation, never an accidental reject() or re-approve().
   *
   * A real ProductionCustodyExecutor should still treat the
   * `idempotencyKey` passed below as a belt-and-suspenders guard against
   * ITS OWN retries at the network/HTTP layer (see that interface's
   * docblock) — this lease only prevents WithdrawalsService itself from
   * calling execute() twice for the same withdrawal, not a provider-side
   * retry mid-call.
   */
  async approve(withdrawalId: string, actorId: string) {
    await this.assertSuperAdmin(actorId);

    await this.txRunner.run((tx) =>
      this.casTransition(tx, withdrawalId, [WithdrawalStatus.RISK_REVIEW], { status: WithdrawalStatus.APPROVED }),
    );
    await this.txRunner.run((tx) =>
      this.casTransition(tx, withdrawalId, [WithdrawalStatus.APPROVED], { status: WithdrawalStatus.BROADCASTING }),
    );

    // The executor call happens outside the DB transaction (it may be a
    // slow external call once a real custody provider exists) — that's
    // safe because the CAS above already gave exactly one caller
    // exclusive ownership of this transition; a concurrent approve() call
    // would have failed the CAS and never reached here, and reject() is
    // now locked out until this settles (see docblock above).
    const withdrawal = await this.getOrThrow(withdrawalId);
    const executor = await this.executorFactory.resolve(withdrawal.assetNetworkId);
    let result;
    try {
      result = await executor.execute({
        withdrawalId: withdrawal.id,
        assetNetworkId: withdrawal.assetNetworkId,
        destinationAddress: withdrawal.destinationAddress,
        destinationTag: withdrawal.destinationTag,
        amount: withdrawal.amount.toString(),
        idempotencyKey: withdrawal.id,
      });
    } catch (err) {
      // Release the lease back to APPROVED so reject() is reachable again
      // — see docblock. If this CAS itself fails (the row somehow isn't
      // BROADCASTING any more), that's surfaced instead of the original
      // executor error, since it means the state is no longer what this
      // method believes it is and needs its own investigation.
      await this.txRunner.run((tx) =>
        this.casTransition(tx, withdrawalId, [WithdrawalStatus.BROADCASTING], { status: WithdrawalStatus.APPROVED }),
      );
      throw err;
    }

    if (result.status === "broadcast") {
      const broadcast = await this.txRunner.run((tx) =>
        this.casTransition(tx, withdrawalId, [WithdrawalStatus.BROADCASTING], {
          status: WithdrawalStatus.BROADCAST,
          txHash: result.txHash,
          custodyReference: result.custodyReference,
          broadcastAt: new Date(),
        }),
      );
      // Distinct from AdminController.approveWithdrawal's own
      // "withdrawal.approve" audit row (the human decision) — this
      // records the SYSTEM-side outcome of actually calling the
      // executor, which requirement #19 calls out as its own auditable
      // event ("custody execution attempted... broadcast confirmed").
      await this.auditLog.record({
        actorId,
        action: "withdrawal.broadcast",
        resourceType: "Withdrawal",
        resourceId: withdrawalId,
        after: { status: broadcast.status, txHash: result.txHash },
        idempotencyKey: `withdrawal-broadcast:${withdrawalId}`,
      });
      return broadcast;
    }

    return this.txRunner.run((tx) =>
      this.casTransition(tx, withdrawalId, [WithdrawalStatus.BROADCASTING], {
        status: WithdrawalStatus.PENDING_MANUAL_BROADCAST,
        custodyReference: result.custodyReference,
      }),
    );
  }

  /**
   * Admin submits the tx hash after broadcasting a sandbox withdrawal
   * themselves with their own wallet tooling. This method RECORDS the
   * admin's claim — it never itself broadcasts anything, and it does not
   * verify the txHash on-chain before this transition (see the Phase 8
   * audit note on ManualBroadcastExecutor for why that's a known,
   * accepted gap: the caller here is already the platform's single
   * fully-trusted SUPER_ADMIN authority, and the confirmation watcher
   * will surface any mismatch as soon as it polls the real chain state
   * for this txHash — see WithdrawalWatcherService). Only a SUPER_ADMIN
   * may call this — an ordinary user can never self-report a tx hash to
   * complete their own withdrawal.
   */
  async recordManualBroadcast(withdrawalId: string, adminId: string, txHash: string) {
    await this.assertSuperAdmin(adminId);
    // Audit logging for this action is the caller's responsibility (see
    // AdminController.broadcastWithdrawal) — same convention every other
    // admin-HTTP-triggered mutation in this codebase follows, so there is
    // exactly one "withdrawal.manual_broadcast" row per call, not two.
    return this.txRunner.run((tx) =>
      this.casTransition(tx, withdrawalId, [WithdrawalStatus.PENDING_MANUAL_BROADCAST], {
        status: WithdrawalStatus.BROADCAST,
        txHash,
        broadcastByAdminId: adminId,
        broadcastAt: new Date(),
      }),
    );
  }

  /**
   * Called by WithdrawalWatcherService with real, observed on-chain
   * confirmation counts (via CustodyProvider.getTransactionStatus() — see
   * that watcher). Safe to call repeatedly with the same or stale data —
   * insufficient confirmations just re-affirms CONFIRMING, and a
   * withdrawal that's already CONFIRMED/CREDITED is left untouched rather
   * than erroring, since watchers naturally re-poll and redeliver. Never
   * called from any HTTP endpoint — a withdrawal can only reach CREDITED
   * from genuine blockchain evidence, never from an admin's word alone.
   */
  async recordConfirmation(withdrawalId: string, confirmations: number, requiredConfirmations: number) {
    if (confirmations < requiredConfirmations) {
      return this.txRunner.run(async (tx) => {
        const result = await tx.withdrawal.updateMany({
          where: { id: withdrawalId, status: { in: [WithdrawalStatus.BROADCAST, WithdrawalStatus.CONFIRMING] } },
          data: { status: WithdrawalStatus.CONFIRMING },
        });
        if (result.count === 0) {
          return this.getOrThrow(withdrawalId, tx);
        }
        return tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
      });
    }

    const { withdrawal: settled, justCredited } = await this.txRunner.run(async (tx) => {
      const result = await tx.withdrawal.updateMany({
        where: { id: withdrawalId, status: { in: [WithdrawalStatus.BROADCAST, WithdrawalStatus.CONFIRMING] } },
        data: { status: WithdrawalStatus.CONFIRMED, confirmedAt: new Date() },
      });

      if (result.count === 0) {
        // Already confirmed/credited by an earlier or concurrent call —
        // idempotent no-op, not an error.
        return { withdrawal: await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } }), justCredited: false };
      }

      const withdrawal = await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
      const assetNetwork = await tx.assetNetwork.findUniqueOrThrow({
        where: { id: withdrawal.assetNetworkId },
        include: { asset: true },
      });

      const reservation = await this.reservations.findActiveByReference(tx, "Withdrawal", withdrawalId);
      if (reservation) {
        await this.reservations.capture(tx, reservation.id);
      }

      // The real, total-balance-moving posting — this is the point actual
      // funds left the platform, so it's the point the ledger moves money,
      // not the earlier reservation. The user is debited the FULL
      // `amount` (matching what was reserved at request time); the fee
      // (if any — always 0 today, see ZeroWithdrawalFeeCalculator) is
      // carved out of what actually left via EXTERNAL_CHAIN and credited
      // to FEE_REVENUE instead, mirroring ExecutionCoordinator
      // .postTradeLedger's identical 2-leg/3-leg pattern for trade fees.
      const netAmount = withdrawal.amount.minus(withdrawal.fee);
      const postings: Array<{ account: AccountRef; amount: Prisma.Decimal.Value }> = [
        { account: { type: "USER", userId: withdrawal.userId }, amount: withdrawal.amount.negated() },
        { account: { type: "HOUSE", key: "EXTERNAL_CHAIN" }, amount: netAmount },
      ];
      if (!withdrawal.fee.isZero()) {
        postings.push({ account: { type: "HOUSE", key: "FEE_REVENUE" }, amount: withdrawal.fee });
      }

      await this.ledger.postTransaction(tx, {
        assetSymbol: assetNetwork.asset.symbol,
        type: "WITHDRAWAL",
        referenceType: "Withdrawal",
        referenceId: withdrawalId,
        idempotencyKey: `withdrawal-capture:${withdrawalId}`,
        postings,
      });

      const credited = await tx.withdrawal.update({
        where: { id: withdrawalId },
        data: { status: WithdrawalStatus.CREDITED },
      });

      return { withdrawal: credited, justCredited: true };
    });

    if (justCredited) {
      await this.auditLog.record({
        actorType: "SYSTEM",
        action: "withdrawal.confirmed",
        resourceType: "Withdrawal",
        resourceId: settled.id,
        before: { status: "BROADCAST_OR_CONFIRMING" },
        after: { status: settled.status },
        idempotencyKey: `withdrawal-capture:${settled.id}`,
      });
    }

    return settled;
  }

  /**
   * Read + audit only — the withdrawal counterpart to
   * ReconciliationService.run() for deposits. Compares this withdrawal's
   * internal state against a fresh, real on-chain lookup of its own
   * recorded txHash (via CustodyProvider, never a cached figure) and
   * reports what it finds. NEVER mutates the withdrawal, the reservation,
   * or the ledger — a genuine discrepancy in EITHER direction (internal
   * state still holds the reservation but the chain shows no such
   * transaction, OR the reservation was already released back to the
   * user but the chain shows the transaction genuinely exists) is
   * flagged for the SUPER_ADMIN to act on explicitly, not silently
   * "fixed" here.
   */
  async reconcile(withdrawalId: string, actorId: string) {
    await this.assertSuperAdmin(actorId);
    const withdrawal = await this.getOrThrow(withdrawalId);

    if (!withdrawal.txHash) {
      const report = {
        withdrawal,
        chainStatus: null,
        discrepancy: false,
        note: "No transaction hash recorded yet — nothing to check against the chain.",
      };
      await this.auditLog.record({
        actorId,
        action: "withdrawal.reconcile",
        resourceType: "Withdrawal",
        resourceId: withdrawalId,
        after: { discrepancy: false, note: report.note },
      });
      return report;
    }

    const provider = await this.custodyProviderFactory.resolve(withdrawal.assetNetworkId);
    const chainStatus = await provider.getTransactionStatus(withdrawal.txHash, withdrawal.assetNetworkId);

    // Several honest, narrow discrepancy signals, checked in priority
    // order (only the first that applies is reported — the return shape
    // carries one note, matching the existing frontend/API contract).
    // Subtler mismatches (e.g. a confirmation-count that looks stale) are
    // deliberately NOT auto-classified as a "discrepancy" here — that
    // judgment is left to the SUPER_ADMIN reviewer, who sees the raw
    // comparison either way.
    //
    // "chain shows real activity" deliberately excludes both "not_found"
    // (no chain record at all) AND "failed" (the chain DOES have a
    // record, but it's a final, unsuccessful one, e.g. an EVM revert or
    // XRPL tec-class result) — an internally-FAILED withdrawal whose
    // chain transaction also genuinely failed is the CORRECT, consistent
    // outcome, not a discrepancy (see WithdrawalWatcherService, which is
    // what drives a withdrawal to FAILED from real chain evidence in the
    // first place).
    const chainShowsRealActivity = chainStatus.status === "confirmed" || chainStatus.status === "pending";

    let discrepancy = false;
    let note: string | null = null;

    if (RESERVATION_STILL_HELD_STATUSES.has(withdrawal.status) && chainStatus.status === "not_found") {
      // Internal state still holds the reservation (or, for CREDITED, has
      // already captured it) believing this transaction broadcast — but
      // the chain shows no trace of it. Maybe it never really went out.
      discrepancy = true;
      note = "Internal state claims this transaction broadcast, but it was not found on-chain.";
    } else if (RESERVATION_RELEASED_STATUSES.has(withdrawal.status) && chainShowsRealActivity) {
      // The more dangerous direction: this withdrawal's reservation was
      // already released back to the user (REJECTED/FAILED), but the
      // chain shows the transaction genuinely exists and is succeeding or
      // in flight — real funds may already have left while the user's
      // balance was also restored internally.
      discrepancy = true;
      note = "This withdrawal's reservation was released, but the chain shows the transaction actually exists — funds may already have left.";
    } else if (chainShowsRealActivity && chainStatus.destinationAddress && !destinationsMatch(chainStatus.destinationAddress, withdrawal.destinationAddress)) {
      // Requirement #12/#13: "verify destination where practical". Only
      // checked when the provider actually reports one (EVM/XRP today —
      // see ChainTransactionStatus's own docblock for why Bitcoin/Solana
      // don't) — a genuine mismatch here would mean the broadcast paid a
      // DIFFERENT address than the one this withdrawal recorded.
      discrepancy = true;
      note = "The broadcast transaction's on-chain destination does not match this withdrawal's recorded destination address.";
    } else if (chainShowsRealActivity) {
      // The amount actually delivered on-chain should equal amount - fee
      // (see request()'s own accounting docblock) — never `amount` alone.
      const expectedNet = withdrawal.amount.minus(withdrawal.fee);
      const observed = new Prisma.Decimal(chainStatus.amount);
      if (observed.minus(expectedNet).abs().greaterThan(WITHDRAWAL_RECONCILE_AMOUNT_TOLERANCE)) {
        discrepancy = true;
        note = `The broadcast transaction's on-chain amount (${chainStatus.amount}) does not match the expected net amount (${expectedNet.toString()}).`;
      }
    }

    await this.auditLog.record({
      actorId,
      action: "withdrawal.reconcile",
      resourceType: "Withdrawal",
      resourceId: withdrawalId,
      after: {
        internalStatus: withdrawal.status,
        chainStatus: chainStatus.status,
        chainConfirmations: chainStatus.confirmations,
        discrepancy,
      },
    });

    return { withdrawal, chainStatus, discrepancy, note };
  }

  async reject(withdrawalId: string, reason: string, actorId: string) {
    await this.assertSuperAdmin(actorId);
    return this.releaseReservation(withdrawalId, reason, WithdrawalStatus.REJECTED, [
      WithdrawalStatus.REQUESTED,
      WithdrawalStatus.RISK_REVIEW,
      WithdrawalStatus.APPROVED,
    ]);
  }

  /**
   * System-initiated (no admin HTTP caller wraps this — see
   * WithdrawalWatcherService, which calls this when a chain adapter
   * reports a withdrawal's broadcast transaction as genuinely "failed",
   * e.g. an EVM revert or an XRPL tec-class result), so unlike
   * reject()/recordManualBroadcast (whose audit rows the *caller*
   * records — see those methods' own docblocks), this method audits
   * itself, the same reasoning approve()'s own "withdrawal.broadcast"
   * branch already uses for a system-side outcome with no controller to
   * do it instead.
   */
  async fail(withdrawalId: string, reason: string) {
    const withdrawal = await this.releaseReservation(withdrawalId, reason, WithdrawalStatus.FAILED, [
      WithdrawalStatus.APPROVED,
      WithdrawalStatus.PENDING_MANUAL_BROADCAST,
      WithdrawalStatus.BROADCASTING,
      WithdrawalStatus.BROADCAST,
      WithdrawalStatus.CONFIRMING,
    ]);
    await this.auditLog.record({
      actorType: "SYSTEM",
      action: "withdrawal.failed",
      resourceType: "Withdrawal",
      resourceId: withdrawalId,
      after: { status: withdrawal.status, reason },
      idempotencyKey: `withdrawal-fail:${withdrawalId}`,
    });
    return withdrawal;
  }

  private async releaseReservation(
    withdrawalId: string,
    reason: string,
    terminalStatus: WithdrawalStatus,
    allowedFrom: WithdrawalStatus[],
  ) {
    return this.txRunner.run(async (tx) => {
      const withdrawal = await this.casTransition(tx, withdrawalId, allowedFrom, {
        status: terminalStatus,
        failureReason: reason,
      });

      const reservation = await this.reservations.findActiveByReference(tx, "Withdrawal", withdrawalId);
      if (reservation) {
        await this.reservations.release(tx, reservation.id);
      }

      return withdrawal;
    });
  }

  async listMine(userId: string) {
    return this.prisma.withdrawal.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: { assetNetwork: { include: { asset: true, network: true } } },
    });
  }

  async listAll() {
    return this.prisma.withdrawal.findMany({
      orderBy: { createdAt: "desc" },
      include: { user: { select: { id: true, email: true } }, assetNetwork: { include: { asset: true, network: true } } },
    });
  }

  /**
   * Independent, defense-in-depth re-verification of SUPER_ADMIN — the
   * same pattern ResolutionService.assertAuthorized() uses for market
   * resolution, another single-platform-owner financial-control action.
   * RolesGuard already gates the HTTP route this arrives through, but
   * re-checking here means this stays correct even if ever invoked from
   * a future non-HTTP caller, and it re-reads the actor's CURRENT role
   * from the DB rather than trusting a JWT claim that could be stale.
   */
  private async assertSuperAdmin(actorId: string): Promise<void> {
    const actor = await this.prisma.user.findUnique({ where: { id: actorId } });
    if (!actor) {
      throw new ForbiddenException("Unknown user");
    }
    if (actor.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException("Only a SUPER_ADMIN may approve or reject a withdrawal");
    }
  }

  private async getOrThrow(withdrawalId: string, client: Prisma.TransactionClient | PrismaService = this.prisma) {
    const withdrawal = await client.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal) {
      throw new NotFoundException("Withdrawal not found");
    }
    return withdrawal;
  }

  /**
   * Atomic compare-and-swap: only succeeds if the row is currently in one
   * of `allowedFrom`. Throws ConflictException (409) on a 0-row result —
   * the caller was not first, whether because of a genuine race or a
   * double-click/retry.
   */
  private async casTransition(
    tx: Prisma.TransactionClient,
    withdrawalId: string,
    allowedFrom: WithdrawalStatus[],
    data: Prisma.WithdrawalUpdateManyMutationInput,
  ): Promise<Withdrawal> {
    const result = await tx.withdrawal.updateMany({
      where: { id: withdrawalId, status: { in: allowedFrom } },
      data,
    });

    if (result.count === 0) {
      const current = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
      if (!current) {
        throw new NotFoundException("Withdrawal not found");
      }
      throw new ConflictException(
        `Withdrawal ${withdrawalId} is in status ${current.status}, expected one of: ${allowedFrom.join(", ")}`,
      );
    }

    return tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
  }
}
