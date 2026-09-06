import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { IsString } from "class-validator";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { CurrentUser, AuthenticatedUser } from "../../common/decorators/current-user.decorator";
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

  @Post("addresses")
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
