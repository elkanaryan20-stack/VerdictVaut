import { BadRequestException, Controller, Get, Param, Post, Body, Query, UseGuards } from "@nestjs/common";
import { MarketStatus, UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser, AuthenticatedUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { SettlementService } from "../settlement/settlement.service";
import { CreateMarketDto } from "./dto/create-market.dto";
import { MarketsService } from "./markets.service";
import { ResolveMarketDto } from "./resolution/dto/resolve-market.dto";
import { ResolutionService } from "./resolution/resolution.service";

@Controller("markets")
export class MarketsController {
  constructor(
    private readonly marketsService: MarketsService,
    private readonly resolutionService: ResolutionService,
    private readonly settlementService: SettlementService,
  ) {}

  // ?status= restricts to a single lifecycle status (OPEN/CLOSED/RESOLVING/
  // RESOLVED); DRAFT is never a valid filter value here — it's not a
  // publicly-visible state (see MarketsService.list's docblock).
  @Get()
  list(@Query("status") status?: string) {
    if (status === undefined) {
      return this.marketsService.list();
    }
    if (!Object.values(MarketStatus).includes(status as MarketStatus) || status === MarketStatus.DRAFT) {
      throw new BadRequestException(`Invalid status filter '${status}'`);
    }
    return this.marketsService.list(status as MarketStatus);
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

  @Post(":id/open")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  open(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.marketsService.open(id, user.id);
  }

  @Post(":id/close")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  close(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.marketsService.close(id, user.id);
  }

  // Decides the winning outcome and attempts settlement immediately.
  // Market resolution moves real money (settlement payouts) and is a
  // platform-control action reserved to the single SUPER_ADMIN authority
  // (see the platform-control-model note) — not every ADMIN.
  // ResolutionService independently re-verifies the resolver's role
  // against the DB (defense in depth alongside RolesGuard here).
  @Post(":id/resolve")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  resolve(@Param("id") id: string, @Body() dto: ResolveMarketDto, @CurrentUser() user: AuthenticatedUser) {
    return this.resolutionService.resolve(id, user.id, dto.winningOutcomeId, dto.notes);
  }

  // Recovery path for a market whose settlement pass previously failed
  // or was left incomplete — safe to call any number of times. Same
  // SUPER_ADMIN restriction as resolve() — it moves the same money.
  @Post(":id/retry-settlement")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  retrySettlement(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.resolutionService.retrySettlement(id, user.id);
  }

  // Aggregate, public resolution/settlement status — no individual
  // user's payout amount (see settlement/mine below for that).
  @Get(":id/resolution")
  getResolutionStatus(@Param("id") id: string) {
    return this.resolutionService.getResolutionStatus(id);
  }

  // The calling user's own settlement result(s) for this market.
  @Get(":id/settlement/mine")
  @UseGuards(JwtAuthGuard)
  getMySettlement(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.settlementService.getUserSettlements(user.id, id);
  }
}
