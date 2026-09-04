import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
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
  listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.depositsService.listMine(user.id);
  }

  @Get("addresses")
  listMyAddresses(@CurrentUser() user: AuthenticatedUser) {
    return this.depositAddressService.listMine(user.id);
  }

  @Post("addresses")
  assignAddress(@CurrentUser() user: AuthenticatedUser, @Body() dto: AssignAddressDto) {
    return this.depositAddressService.getOrAssign(user.id, dto.assetSymbol, dto.networkCode);
  }
}
