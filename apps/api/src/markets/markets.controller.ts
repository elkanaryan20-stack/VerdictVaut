import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser, AuthenticatedUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { CreateMarketDto } from "./dto/create-market.dto";
import { MarketsService } from "./markets.service";

@Controller("markets")
export class MarketsController {
  constructor(private readonly marketsService: MarketsService) {}

  @Get()
  list() {
    return this.marketsService.listOpen();
  }

  @Get("categories")
  categories() {
    return this.marketsService.listCategories();
  }

  @Get(":slug")
  getOne(@Param("slug") slug: string) {
    return this.marketsService.getBySlug(slug);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  create(@Body() dto: CreateMarketDto, @CurrentUser() user: AuthenticatedUser) {
    return this.marketsService.create(dto, user.id);
  }
}
