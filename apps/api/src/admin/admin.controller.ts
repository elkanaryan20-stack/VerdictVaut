import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser, AuthenticatedUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { AssetsNetworksService } from "../wallet/assets-networks/assets-networks.service";
import { DepositAddressService } from "../wallet/addresses/deposit-address.service";
import { DepositsService } from "../wallet/deposits/deposits.service";
import { ReconciliationService } from "../wallet/reconciliation/reconciliation.service";
import { DepositReprocessingService } from "../wallet/watchers/deposit-reprocessing.service";
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
    private readonly auditLogService: AuditLogService,
  ) {}

  // ── Asset / network configuration (SUPER_ADMIN only) ─────────────────
  @Post("asset-networks")
  @Roles(UserRole.SUPER_ADMIN)
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
  listDeposits() {
    return this.depositsService.listAll();
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
  async reprocessDeposit(@CurrentUser() admin: AuthenticatedUser, @Param("id") id: string) {
    return this.reprocessingService.reprocess(id, admin.id);
  }

  // ── Withdrawals (approval/broadcast — SUPER_ADMIN only) ───────────────
  @Get("withdrawals")
  listWithdrawals() {
    return this.withdrawalsService.listAll();
  }

  @Post("withdrawals/:id/approve")
  @Roles(UserRole.SUPER_ADMIN)
  async approveWithdrawal(@CurrentUser() admin: AuthenticatedUser, @Param("id") id: string) {
    const before = await this.withdrawalsService.getById(id);
    const updated = await this.withdrawalsService.approve(id);
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
  async rejectWithdrawal(
    @CurrentUser() admin: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: RejectWithdrawalDto,
  ) {
    const before = await this.withdrawalsService.getById(id);
    const updated = await this.withdrawalsService.reject(id, dto.reason);
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

  @Post("withdrawals/:id/broadcast")
  @Roles(UserRole.SUPER_ADMIN)
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

  // ── Audit log ────────────────────────────────────────────────────────
  @Get("audit-logs")
  listAuditLogs(@Query("resourceType") resourceType?: string, @Query("actorId") actorId?: string) {
    return this.auditLogService.list({ resourceType, actorId });
  }
}
