import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser, AuthenticatedUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { ADMIN_MUTATION_THROTTLE } from "../common/throttle-presets";
import { AssetsNetworksService } from "../wallet/assets-networks/assets-networks.service";
import { DepositAddressService } from "../wallet/addresses/deposit-address.service";
import { DepositsService } from "../wallet/deposits/deposits.service";
import { ReconciliationService } from "../wallet/reconciliation/reconciliation.service";
import { DepositReprocessingService } from "../wallet/watchers/deposit-reprocessing.service";
import { DepositWatcherService } from "../wallet/watchers/deposit-watcher.service";
import { WithdrawalsService } from "../wallet/withdrawals/withdrawals.service";
import { BroadcastWithdrawalDto } from "../wallet/withdrawals/dto/broadcast-withdrawal.dto";
import { AuditLogService } from "../audit/audit-log.service";
import { CreateAssetNetworkDto, ProvisionAddressDto, RejectWithdrawalDto, SetActiveDto } from "./dto/admin.dto";

/**
 * Class-level @Roles(ADMIN, SUPER_ADMIN) is the baseline for read-only
 * operational visibility (listing deposits/withdrawals/audit logs).
 * Financial/platform-control actions override it with a method-level
 * @Roles(SUPER_ADMIN) — RolesGuard's reflector.getAllAndOverride prefers
 * the handler's own metadata over the class's, so this genuinely
 * narrows access rather than just documenting an intent. See the
 * platform-control-model note this phase introduced: this app has
 * exactly one SUPER_ADMIN authority for MVP, and an ordinary ADMIN must
 * never be able to reconfigure assets/networks, provision deposit
 * addresses, run reconciliation, reprocess a deposit, or move a
 * withdrawal through approval/broadcast.
 *
 * @Throttle(ADMIN_MUTATION_THROTTLE) is applied per-method on every
 * SUPER_ADMIN mutation below (deliberately NOT at the class level) — the
 * read-only listing endpoints stay on the ordinary global default so an
 * operational dashboard polling them is never throttled by a limit meant
 * for rare, high-stakes platform-control actions.
 */
@Controller("admin")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
export class AdminController {
  constructor(
    private readonly assetsNetworksService: AssetsNetworksService,
    private readonly depositAddressService: DepositAddressService,
    private readonly depositsService: DepositsService,
    private readonly withdrawalsService: WithdrawalsService,
    private readonly reconciliationService: ReconciliationService,
    private readonly reprocessingService: DepositReprocessingService,
    private readonly depositWatcherService: DepositWatcherService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ── Asset / network configuration (SUPER_ADMIN only) ─────────────────
  @Post("asset-networks")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async createAssetNetwork(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateAssetNetworkDto) {
    const created = await this.assetsNetworksService.createAssetNetwork(dto);
    await this.auditLogService.record({
      actorId: admin.id,
      action: "asset_network.create",
      resourceType: "AssetNetwork",
      resourceId: created.id,
      after: {
        assetId: created.assetId,
        networkId: created.networkId,
        isNative: created.isNative,
        contractAddress: created.contractAddress,
        memoRequired: created.memoRequired,
        minConfirmations: created.minConfirmations,
        depositMinAmount: created.depositMinAmount.toString(),
        withdrawalMinAmount: created.withdrawalMinAmount.toString(),
        isActive: created.isActive,
      },
    });
    return created;
  }

  @Patch("asset-networks/:id/active")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async setAssetNetworkActive(
    @CurrentUser() admin: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: SetActiveDto,
  ) {
    const updated = await this.assetsNetworksService.setAssetNetworkActive(id, dto.isActive);
    await this.auditLogService.record({
      actorId: admin.id,
      action: "asset_network.set_active",
      resourceType: "AssetNetwork",
      resourceId: id,
      after: { isActive: dto.isActive },
    });
    return updated;
  }

  @Patch("assets/:id/active")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async setAssetActive(@CurrentUser() admin: AuthenticatedUser, @Param("id") id: string, @Body() dto: SetActiveDto) {
    const updated = await this.assetsNetworksService.setAssetActive(id, dto.isActive);
    await this.auditLogService.record({
      actorId: admin.id,
      action: "asset.set_active",
      resourceType: "Asset",
      resourceId: id,
      after: { isActive: dto.isActive },
    });
    return updated;
  }

  @Patch("networks/:id/active")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async setNetworkActive(@CurrentUser() admin: AuthenticatedUser, @Param("id") id: string, @Body() dto: SetActiveDto) {
    const updated = await this.assetsNetworksService.setNetworkActive(id, dto.isActive);
    await this.auditLogService.record({
      actorId: admin.id,
      action: "network.set_active",
      resourceType: "Network",
      resourceId: id,
      after: { isActive: dto.isActive },
    });
    return updated;
  }

  // ── Wallet addresses (address-pool administration — SUPER_ADMIN only) ─
  @Post("wallet-addresses")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async provisionAddress(@CurrentUser() admin: AuthenticatedUser, @Body() dto: ProvisionAddressDto) {
    const created = await this.depositAddressService.provisionAddress(dto);
    await this.auditLogService.record({
      actorId: admin.id,
      action: "wallet_address.provision",
      resourceType: "WalletAddress",
      resourceId: created.id,
      after: { assetNetworkId: dto.assetNetworkId, environment: dto.environment },
    });
    return created;
  }

  // ── Deposits ─────────────────────────────────────────────────────────
  // Listing/inspecting is read-only operational visibility (ADMIN or
  // SUPER_ADMIN). Reprocessing can end up posting a real ledger credit
  // (it re-derives everything from a live chain lookup — see
  // DepositReprocessingService — never from admin-supplied amount/status
  // input), so it is gated the same as the other financial-control
  // actions below: SUPER_ADMIN only. There is deliberately no endpoint
  // here that lets an admin directly set a deposit's status or amount.
  @Get("deposits")
  listDeposits(@Query("page") page?: string, @Query("pageSize") pageSize?: string) {
    return this.depositsService.listAll(page ? parseInt(page, 10) : undefined, pageSize ? parseInt(pageSize, 10) : undefined);
  }

  // Registered before "deposits/:id" — Nest matches literal path
  // segments in declaration order, so ":id" must come after "stale" or
  // it would swallow this route. Surfaces deposits that haven't been
  // re-checked recently (e.g. one that fell out of a chain watcher's
  // bounded "recent activity" page while still PENDING) so they're
  // discoverable and reprocessable rather than silently stuck forever.
  @Get("deposits/stale")
  listStaleDeposits(@Query("olderThanMs") olderThanMs?: string) {
    return this.depositsService.listStale(olderThanMs ? parseInt(olderThanMs, 10) : 60 * 60 * 1000);
  }

  @Get("deposits/:id")
  getDeposit(@Param("id") id: string) {
    return this.depositsService.getById(id);
  }

  @Post("deposits/:id/reprocess")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async reprocessDeposit(@CurrentUser() admin: AuthenticatedUser, @Param("id") id: string) {
    return this.reprocessingService.reprocess(id, admin.id);
  }

  // ── Withdrawals (approval/broadcast — SUPER_ADMIN only) ───────────────
  @Get("withdrawals")
  listWithdrawals(@Query("page") page?: string, @Query("pageSize") pageSize?: string) {
    return this.withdrawalsService.listAll(page ? parseInt(page, 10) : undefined, pageSize ? parseInt(pageSize, 10) : undefined);
  }

  // Registered before "withdrawals/:id/approve" etc. is unnecessary —
  // those are POST, this is GET, so there's no literal-segment ordering
  // conflict — but kept adjacent to listWithdrawals for readability.
  @Get("withdrawals/:id")
  getWithdrawal(@Param("id") id: string) {
    return this.withdrawalsService.getById(id);
  }

  @Post("withdrawals/:id/approve")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async approveWithdrawal(@CurrentUser() admin: AuthenticatedUser, @Param("id") id: string) {
    const before = await this.withdrawalsService.getById(id);
    const updated = await this.withdrawalsService.approve(id, admin.id);
    await this.auditLogService.record({
      actorId: admin.id,
      action: "withdrawal.approve",
      resourceType: "Withdrawal",
      resourceId: id,
      before: { status: before.status },
      after: { status: updated.status },
      idempotencyKey: id,
    });
    return updated;
  }

  @Post("withdrawals/:id/reject")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async rejectWithdrawal(
    @CurrentUser() admin: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: RejectWithdrawalDto,
  ) {
    const before = await this.withdrawalsService.getById(id);
    const updated = await this.withdrawalsService.reject(id, dto.reason, admin.id);
    await this.auditLogService.record({
      actorId: admin.id,
      action: "withdrawal.reject",
      resourceType: "Withdrawal",
      resourceId: id,
      before: { status: before.status },
      after: { status: updated.status },
      reason: dto.reason,
      idempotencyKey: id,
    });
    return updated;
  }

  // Read + audit only — never mutates the withdrawal, reservation, or
  // ledger. See WithdrawalsService.reconcile's docblock; this endpoint
  // is intentionally the ONLY way to compare a withdrawal's internal
  // state against fresh on-chain evidence, and it never auto-corrects
  // anything it finds.
  @Post("withdrawals/:id/reconcile")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  reconcileWithdrawal(@CurrentUser() admin: AuthenticatedUser, @Param("id") id: string) {
    return this.withdrawalsService.reconcile(id, admin.id);
  }

  @Post("withdrawals/:id/broadcast")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async broadcastWithdrawal(
    @CurrentUser() admin: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: BroadcastWithdrawalDto,
  ) {
    const before = await this.withdrawalsService.getById(id);
    const updated = await this.withdrawalsService.recordManualBroadcast(id, admin.id, dto.txHash);
    await this.auditLogService.record({
      actorId: admin.id,
      action: "withdrawal.manual_broadcast",
      resourceType: "Withdrawal",
      resourceId: id,
      before: { status: before.status },
      after: { status: updated.status, txHash: dto.txHash },
      idempotencyKey: id,
    });
    return updated;
  }

  // ── Reconciliation (settlement/reconciliation controls — SUPER_ADMIN only) ─
  @Post("reconciliation/:assetNetworkId/run")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async runReconciliation(@CurrentUser() admin: AuthenticatedUser, @Param("assetNetworkId") assetNetworkId: string) {
    const run = await this.reconciliationService.run(assetNetworkId);
    await this.auditLogService.record({
      actorId: admin.id,
      action: "reconciliation.run",
      resourceType: "AssetNetwork",
      resourceId: assetNetworkId,
      after: { status: run.status },
    });
    return run;
  }

  @Get("reconciliation/:assetNetworkId")
  listReconciliationRuns(@Param("assetNetworkId") assetNetworkId: string) {
    return this.reconciliationService.listRuns(assetNetworkId);
  }

  // ── Watcher / cursor operational visibility (requirement #15) ────────
  // Read-only for both ADMIN and SUPER_ADMIN (class-level default) — this
  // exposes cursor/lease/error state, never a control to force a scan,
  // mark something confirmed, or credit/complete anything.
  @Get("watchers")
  listWatcherStatus() {
    return this.depositWatcherService.listCursorStatus();
  }

  // ── Audit log ────────────────────────────────────────────────────────
  @Get("audit-logs")
  listAuditLogs(@Query("resourceType") resourceType?: string, @Query("actorId") actorId?: string) {
    return this.auditLogService.list({ resourceType, actorId });
  }
}
