import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ComplianceProviderCategory, DiscrepancyStatus, NetworkEnvironment, UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser, AuthenticatedUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { ADMIN_MUTATION_THROTTLE } from "../common/throttle-presets";
import { AssetsNetworksService } from "../wallet/assets-networks/assets-networks.service";
import { DepositAddressService } from "../wallet/addresses/deposit-address.service";
import { DepositsService } from "../wallet/deposits/deposits.service";
import { ReconciliationService } from "../wallet/reconciliation/reconciliation.service";
import { IndependentReconciliationService } from "../wallet/reconciliation/independent-reconciliation.service";
import { CollateralReconciliationService } from "../settlement/collateral-reconciliation.service";
import { DepositReprocessingService } from "../wallet/watchers/deposit-reprocessing.service";
import { DepositWatcherService } from "../wallet/watchers/deposit-watcher.service";
import { WithdrawalWatcherService } from "../wallet/watchers/withdrawal-watcher.service";
import { WithdrawalsService } from "../wallet/withdrawals/withdrawals.service";
import { BroadcastWithdrawalDto } from "../wallet/withdrawals/dto/broadcast-withdrawal.dto";
import { CustodyProviderConfigService } from "../wallet/provider-config/custody-provider-config.service";
import { ComplianceProviderConfigService } from "../wallet/provider-config/compliance-provider-config.service";
import { PROVIDER_CAPABILITY_MATRIX } from "../wallet/provider-config/provider-capability-matrix";
import { FireblocksWebhookService } from "../wallet/executors/fireblocks/fireblocks-webhook.service";
import { UsersService } from "../users/users.service";
import { AuditLogService } from "../audit/audit-log.service";
import {
  CreateAssetNetworkDto,
  CreateComplianceProviderConfigDto,
  CreateCustodyProviderConfigDto,
  ProvisionAddressDto,
  RejectWithdrawalDto,
  ResolveAmbiguousExecutionDto,
  ResolveDiscrepancyDto,
  SetActiveDto,
  SetWithdrawalExecutionConfigDto,
  StartIndependentRescanDto,
} from "./dto/admin.dto";

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
    private readonly independentReconciliationService: IndependentReconciliationService,
    private readonly collateralReconciliationService: CollateralReconciliationService,
    private readonly reprocessingService: DepositReprocessingService,
    private readonly depositWatcherService: DepositWatcherService,
    private readonly withdrawalWatcherService: WithdrawalWatcherService,
    private readonly custodyProviderConfigService: CustodyProviderConfigService,
    private readonly complianceProviderConfigService: ComplianceProviderConfigService,
    private readonly fireblocksWebhookService: FireblocksWebhookService,
    private readonly usersService: UsersService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ── User account lifecycle (Phase 18 remediation — SUPER_ADMIN only) ──
  // The operational escape hatch out of PENDING_VERIFICATION until a
  // real email-sending integration exists — see AuthService.register's
  // and UsersService.adminActivate's own docblocks for the full
  // reasoning. Idempotent (never errors on an already-ACTIVE user);
  // only audit-logged when it genuinely changed something, so repeated
  // no-op calls don't spam the audit trail.
  @Post("users/:id/activate")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async activateUser(@CurrentUser() admin: AuthenticatedUser, @Param("id") id: string) {
    const result = await this.usersService.adminActivate(id);
    if (result.changed) {
      await this.auditLogService.record({
        actorId: admin.id,
        action: "user.admin_activated",
        resourceType: "User",
        resourceId: id,
        before: { status: "PENDING_VERIFICATION" },
        after: { status: result.status },
      });
    }
    return result;
  }

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

  // Phase 14A — resolves an EXECUTION_AMBIGUOUS withdrawal (see
  // WithdrawalExecutionResult's "ambiguous" variant and
  // WithdrawalsService.resolveAmbiguousExecution's own docblock). Never
  // guesses: CONFIRMED_BROADCAST requires the real txHash the admin
  // actually found, CONFIRMED_NOT_EXECUTED requires no fabricated evidence.
  @Post("withdrawals/:id/resolve-ambiguous-execution")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  resolveAmbiguousExecution(@CurrentUser() admin: AuthenticatedUser, @Param("id") id: string, @Body() dto: ResolveAmbiguousExecutionDto) {
    const resolution =
      dto.outcome === "CONFIRMED_BROADCAST" ? ({ outcome: "CONFIRMED_BROADCAST", txHash: dto.txHash! } as const) : ({ outcome: "CONFIRMED_NOT_EXECUTED" } as const);
    return this.withdrawalsService.resolveAmbiguousExecution(id, admin.id, resolution, dto.notes);
  }

  // ── Custody provider configuration (Phase 14A — SUPER_ADMIN only to
  // configure; provider-neutral, never a real Fireblocks/BitGo/etc.
  // integration — see CustodyProviderConfigService's own docblock) ─────
  @Post("custody/providers")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async createCustodyProviderConfig(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateCustodyProviderConfigDto) {
    const created = await this.custodyProviderConfigService.createCustodyProviderConfig(dto);
    await this.auditLogService.record({
      actorId: admin.id,
      action: "custody_provider_config.create",
      resourceType: "CustodyProviderConfig",
      resourceId: created.id,
      after: { providerName: created.providerName, environment: created.environment },
    });
    return created;
  }

  @Get("custody/providers")
  listCustodyProviderConfigs() {
    return this.custodyProviderConfigService.listCustodyProviderConfigs();
  }

  @Post("custody/providers/:id/enable")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async enableCustodyProviderConfig(@CurrentUser() admin: AuthenticatedUser, @Param("id") id: string) {
    const updated = await this.custodyProviderConfigService.setCustodyProviderEnabled(id, true);
    await this.auditLogService.record({ actorId: admin.id, action: "custody_provider_config.enable", resourceType: "CustodyProviderConfig", resourceId: id });
    return updated;
  }

  @Post("custody/providers/:id/disable")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async disableCustodyProviderConfig(@CurrentUser() admin: AuthenticatedUser, @Param("id") id: string) {
    const updated = await this.custodyProviderConfigService.setCustodyProviderEnabled(id, false);
    await this.auditLogService.record({ actorId: admin.id, action: "custody_provider_config.disable", resourceType: "CustodyProviderConfig", resourceId: id });
    return updated;
  }

  @Post("custody/execution-config")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async setWithdrawalExecutionConfig(@CurrentUser() admin: AuthenticatedUser, @Body() dto: SetWithdrawalExecutionConfigDto) {
    const updated = await this.custodyProviderConfigService.setWithdrawalExecutionConfig(dto);
    await this.auditLogService.record({
      actorId: admin.id,
      action: "withdrawal_execution_config.set",
      resourceType: "WithdrawalExecutionConfig",
      resourceId: updated.id,
      after: { assetNetworkId: dto.assetNetworkId, executorType: dto.executorType, environment: dto.environment },
    });
    return updated;
  }

  @Get("custody/execution-config")
  listWithdrawalExecutionConfigs() {
    return this.custodyProviderConfigService.listWithdrawalExecutionConfigs();
  }

  // ── Compliance provider configuration (Phase 14A — SUPER_ADMIN only;
  // never a real Sumsub/Chainalysis/etc. integration, and never itself a
  // legal-compliance claim — see ComplianceProviderConfigService) ──────
  @Post("compliance/providers")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async createComplianceProviderConfig(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateComplianceProviderConfigDto) {
    const created = await this.complianceProviderConfigService.createComplianceProviderConfig(dto);
    await this.auditLogService.record({
      actorId: admin.id,
      action: "compliance_provider_config.create",
      resourceType: "ComplianceProviderConfig",
      resourceId: created.id,
      after: { category: created.category, providerName: created.providerName, environment: created.environment },
    });
    return created;
  }

  @Get("compliance/providers")
  listComplianceProviderConfigs(@Query("category") category?: ComplianceProviderCategory, @Query("environment") environment?: NetworkEnvironment) {
    return this.complianceProviderConfigService.listComplianceProviderConfigs({ category, environment });
  }

  @Post("compliance/providers/:id/enable")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async enableComplianceProviderConfig(@CurrentUser() admin: AuthenticatedUser, @Param("id") id: string) {
    const updated = await this.complianceProviderConfigService.setComplianceProviderEnabled(id, true);
    await this.auditLogService.record({ actorId: admin.id, action: "compliance_provider_config.enable", resourceType: "ComplianceProviderConfig", resourceId: id });
    return updated;
  }

  @Post("compliance/providers/:id/disable")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async disableComplianceProviderConfig(@CurrentUser() admin: AuthenticatedUser, @Param("id") id: string) {
    const updated = await this.complianceProviderConfigService.setComplianceProviderEnabled(id, false);
    await this.auditLogService.record({ actorId: admin.id, action: "compliance_provider_config.disable", resourceType: "ComplianceProviderConfig", resourceId: id });
    return updated;
  }

  // ── Provider capability matrix (Phase 14B — SUPER_ADMIN only; a
  // static, code-reviewed record of what has actually been verified/
  // implemented per provider/network family, never editable at runtime
  // — see provider-capability-matrix.ts's own docblock) ────────────────
  @Get("providers/capability-matrix")
  @Roles(UserRole.SUPER_ADMIN)
  getProviderCapabilityMatrix() {
    return PROVIDER_CAPABILITY_MATRIX;
  }

  // ── Provider webhook events (Phase 14B — SUPER_ADMIN only; inspection
  // and manual reprocessing of a delivery whose first processing attempt
  // failed. Reprocessing NEVER accepts new payload data from the
  // request — it re-reads and re-applies the event's own already-stored
  // payload, so an admin can retry delivery handling but never inject
  // different data than what the provider actually sent) ───────────────
  @Get("providers/webhook-events")
  @Roles(UserRole.SUPER_ADMIN)
  listProviderWebhookEvents(@Query("provider") provider?: string, @Query("resourceId") resourceId?: string) {
    return this.fireblocksWebhookService.listEvents({ provider, resourceId });
  }

  @Post("providers/webhook-events/:id/reprocess")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async reprocessProviderWebhookEvent(@CurrentUser() admin: AuthenticatedUser, @Param("id") id: string) {
    const outcome = await this.fireblocksWebhookService.reprocessEvent(id);
    await this.auditLogService.record({
      actorId: admin.id,
      action: "provider_webhook_event.reprocess",
      resourceType: "ProviderWebhookEvent",
      resourceId: id,
      after: { outcome },
    });
    return { outcome };
  }

  // ── Compliance decision signals (Phase 14B — SUPER_ADMIN only; the
  // per-category KYC/sanctions/address-risk findings underlying a
  // withdrawal's compliance decision, recorded on the "withdrawal.request"
  // audit entry — see WithdrawalComplianceSignals's own docblock. This
  // is read-only reviewer visibility, never itself a compliance action) ─
  @Get("withdrawals/:id/compliance-signals")
  @Roles(UserRole.SUPER_ADMIN)
  getWithdrawalComplianceSignals(@Param("id") id: string) {
    return this.auditLogService.list({ resourceType: "Withdrawal", resourceId: id, action: "withdrawal.request" });
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

  // Registered before "reconciliation/:assetNetworkId" — Nest matches
  // literal path segments in declaration order, so "discrepancies" must
  // come first or it would be swallowed as an :assetNetworkId value
  // (same literal-vs-param ordering rule as deposits/stale above).
  @Get("reconciliation/discrepancies")
  listDiscrepancies(
    @Query("assetNetworkId") assetNetworkId?: string,
    @Query("marketId") marketId?: string,
    @Query("status") status?: DiscrepancyStatus,
  ) {
    return this.independentReconciliationService.listDiscrepancies({ assetNetworkId, marketId, status });
  }

  // ── Collateral reconciliation (Phase 13 — market-scoped, SUPER_ADMIN
  // only to run; registered before "reconciliation/:assetNetworkId" so
  // "collateral" is never swallowed as an assetNetworkId value) ────────
  @Post("reconciliation/collateral/:marketId/run")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  runCollateralCheck(@CurrentUser() admin: AuthenticatedUser, @Param("marketId") marketId: string) {
    return this.collateralReconciliationService.checkMarket(marketId, admin.id);
  }

  @Get("reconciliation/collateral/:marketId")
  listCollateralRuns(@Param("marketId") marketId: string) {
    return this.collateralReconciliationService.listRuns(marketId);
  }

  @Post("reconciliation/collateral/check-all")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  runCollateralCheckAll(@CurrentUser() admin: AuthenticatedUser) {
    return this.collateralReconciliationService.checkAllMarkets(admin.id);
  }

  @Get("reconciliation/:assetNetworkId")
  listReconciliationRuns(@Param("assetNetworkId") assetNetworkId: string) {
    return this.reconciliationService.listRuns(assetNetworkId);
  }

  // ── Independent blockchain rescan (Phase 12A — SUPER_ADMIN only to
  // start; ADMIN+SUPER_ADMIN may read discrepancies, matching the
  // existing read/mutate split above) ────────────────────────────────
  @Post("reconciliation/:assetNetworkId/independent-rescan")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  runIndependentRescan(
    @CurrentUser() admin: AuthenticatedUser,
    @Param("assetNetworkId") assetNetworkId: string,
    @Body() dto: StartIndependentRescanDto,
  ) {
    return this.independentReconciliationService.runIndependentRescan(assetNetworkId, admin.id, dto.fromPointer);
  }

  @Get("reconciliation/:assetNetworkId/independent-rescan")
  listIndependentRescanRuns(@Param("assetNetworkId") assetNetworkId: string) {
    return this.independentReconciliationService.listRuns(assetNetworkId);
  }

  @Post("reconciliation/discrepancies/:id/acknowledge")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async acknowledgeDiscrepancy(@CurrentUser() admin: AuthenticatedUser, @Param("id") id: string) {
    const acknowledged = await this.independentReconciliationService.acknowledge(id, admin.id);
    if (!acknowledged) {
      throw new BadRequestException("Discrepancy not found or not currently OPEN");
    }
    return { acknowledged: true };
  }

  @Post("reconciliation/discrepancies/:id/resolve")
  @Roles(UserRole.SUPER_ADMIN)
  @Throttle(ADMIN_MUTATION_THROTTLE)
  async resolveDiscrepancy(@CurrentUser() admin: AuthenticatedUser, @Param("id") id: string, @Body() dto: ResolveDiscrepancyDto) {
    const resolved = await this.independentReconciliationService.resolve(id, admin.id, dto.notes, dto.outcome ?? "RESOLVED");
    if (!resolved) {
      throw new BadRequestException("Discrepancy not found or already resolved");
    }
    return { resolved: true };
  }

  // ── Watcher / cursor operational visibility (requirement #15) ────────
  // Read-only for both ADMIN and SUPER_ADMIN (class-level default) — this
  // exposes cursor/lease/error state, never a control to force a scan,
  // mark something confirmed, or credit/complete anything. Kept as its
  // own array-shaped response (never changed to an object wrapping both
  // watchers) to avoid an API-contract break, matching this codebase's
  // existing precedent (see AdminController's own listDeposits/
  // listWithdrawals pagination history) — the withdrawal watcher's
  // status is a new, separate endpoint below instead.
  @Get("watchers")
  listWatcherStatus() {
    return this.depositWatcherService.listCursorStatus();
  }

  // Phase 16 — WithdrawalWatcherService has no persistent per-item
  // cursor row (see its own docblock on why no cross-instance lease is
  // needed), so its status is in-memory per-process rather than a list
  // of DB rows like the deposit watcher above.
  @Get("watchers/withdrawals")
  getWithdrawalWatcherStatus() {
    return this.withdrawalWatcherService.getStatus();
  }

  // ── Audit log ────────────────────────────────────────────────────────
  @Get("audit-logs")
  listAuditLogs(@Query("resourceType") resourceType?: string, @Query("actorId") actorId?: string) {
    return this.auditLogService.list({ resourceType, actorId });
  }
}
