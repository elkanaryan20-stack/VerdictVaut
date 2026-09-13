import { Controller, Get, Param, Post, Body, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { CurrentUser, AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import { RequireActiveUser } from "../../common/decorators/require-active-user.decorator";
import { ActiveUserGuard } from "../../common/guards/active-user.guard";
import { WITHDRAWAL_REQUEST_THROTTLE } from "../../common/throttle-presets";
import { RequestWithdrawalDto } from "./dto/request-withdrawal.dto";
import { WithdrawalsService } from "./withdrawals.service";

@Controller("wallet/withdrawals")
@UseGuards(JwtAuthGuard)
export class WithdrawalsController {
  constructor(private readonly withdrawalsService: WithdrawalsService) {}

  // Phase 20 security-gate remediation — see ActiveUserGuard's own
  // docblock; the pre-existing check inside WithdrawalsService.request()
  // itself remains as defense-in-depth.
  @Post()
  @UseGuards(ActiveUserGuard)
  @RequireActiveUser()
  @Throttle(WITHDRAWAL_REQUEST_THROTTLE)
  request(@CurrentUser() user: AuthenticatedUser, @Body() dto: RequestWithdrawalDto) {
    return this.withdrawalsService.request(user.id, dto);
  }

  @Get()
  listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.withdrawalsService.listMine(user.id);
  }

  // Registered after the bare listing route above — Nest matches
  // literal path segments in declaration order, and ":id" would
  // otherwise swallow nothing here since there's no other literal
  // sub-path on this controller, but kept consistent with
  // DepositsController's own ordering convention regardless.
  @Get(":id")
  getMine(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.withdrawalsService.getOwned(user.id, id);
  }

  // Deliberately NOT @RequireActiveUser() — cancellation only reduces
  // existing exposure, and a non-ACTIVE user could never legitimately
  // have a withdrawal to cancel in the first place, since request()
  // above is gated (see Phase 20 security-gate audit).
  @Post(":id/cancel")
  @Throttle(WITHDRAWAL_REQUEST_THROTTLE)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.withdrawalsService.cancel(user.id, id);
  }
}
