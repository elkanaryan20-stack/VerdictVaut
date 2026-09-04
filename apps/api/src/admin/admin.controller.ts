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
import { WithdrawalsService } from "../wallet/withdrawals/withdrawals.service";
import { BroadcastWithdrawalDto } from "../wallet/withdrawals/dto/broadcast-withdrawal.dto";
import { AuditLogService } from "../audit/audit-log.service";
import { CreateAssetNetworkDto, ProvisionAddressDto, RejectWithdrawalDto, SetActiveDto } from "./dto/admin.dto";

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
    private readonly auditLogService: AuditLogService,
  ) {}

  // ── Asset / network configuration ───────────────────────────────────
  @Post("asset-networks")
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

  // ── Wallet addresses ─────────────────────────────────────────────────
  @Post("wallet-addresses")
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

  // ── Deposits (read-only) ─────────────────────────────────────────────
  @Get("deposits")
  listDeposits() {
    return this.depositsService.listAll();
  }

  // ── Withdrawals ──────────────────────────────────────────────────────
  @Get("withdrawals")
  listWithdrawals() {
    return this.withdrawalsService.listAll();
  }

  @Post("withdrawals/:id/approve")
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

  // ── Reconciliation ───────────────────────────────────────────────────
  @Post("reconciliation/:assetNetworkId/run")
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
