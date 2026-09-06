import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { CurrentUser, AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import { BalancesService } from "./balances.service";

@Controller("wallet/balances")
@UseGuards(JwtAuthGuard)
export class BalancesController {
  constructor(private readonly balancesService: BalancesService) {}

  @Get()
  getMine(@CurrentUser() user: AuthenticatedUser) {
    return this.balancesService.getMyBalances(user.id);
  }
}
