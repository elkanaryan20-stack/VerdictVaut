import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { IsString } from "class-validator";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { CurrentUser, AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import { RequireActiveUser } from "../../common/decorators/require-active-user.decorator";
import { ActiveUserGuard } from "../../common/guards/active-user.guard";
import { DepositAddressService } from "../addresses/deposit-address.service";
import { DepositsService } from "./deposits.service";

class AssignAddressDto {
  @IsString()
  assetSymbol!: string;

  @IsString()
  networkCode!: string;
}

@Controller("wallet/deposits")
@UseGuards(JwtAuthGuard)
export class DepositsController {
  constructor(
    private readonly depositsService: DepositsService,
    private readonly depositAddressService: DepositAddressService,
  ) {}

  @Get()
  listMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.depositsService.listMine(user.id, page ? parseInt(page, 10) : undefined, pageSize ? parseInt(pageSize, 10) : undefined);
  }

  @Get("addresses")
  listMyAddresses(@CurrentUser() user: AuthenticatedUser) {
    return this.depositAddressService.listMine(user.id);
  }

  // Phase 20 security-gate audit finding — this was the one wallet
  // mutation with NO status check anywhere (unlike order creation and
  // withdrawal requests, which already had an inline ACTIVE check
  // inside their own services). Self-assigning a real deposit address
  // is exactly the kind of "obtain the means to move real value"
  // action the PENDING_VERIFICATION lifecycle is meant to gate — an
  // unverified account should not be able to provision a real address
  // to receive funds at any more than it can trade or withdraw them.
  @Post("addresses")
  @UseGuards(ActiveUserGuard)
  @RequireActiveUser()
  assignAddress(@CurrentUser() user: AuthenticatedUser, @Body() dto: AssignAddressDto) {
    return this.depositAddressService.getOrAssign(user.id, dto.assetSymbol, dto.networkCode);
  }

  // Registered after the "addresses" routes above — Nest matches literal
  // path segments in declaration order, so ":id" must come last or it
  // would swallow "GET /wallet/deposits/addresses" instead.
  @Get(":id")
  getMine(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.depositsService.getOwned(user.id, id);
  }
}
