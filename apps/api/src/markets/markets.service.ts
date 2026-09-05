import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { MarketStatus } from "@prisma/client";
import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../prisma/prisma.service";
import { SerializableTransactionRunner } from "../prisma/serializable-transaction-runner";
import { CreateMarketDto } from "./dto/create-market.dto";

/**
 * Market lifecycle implemented in this phase: DRAFT -> OPEN -> CLOSED.
 * RESOLVING/RESOLVED/CANCELLED exist on MarketStatus for forward
 * compatibility with the (not-yet-built) resolution/settlement phase —
 * nothing here produces them. Trading is gated on status === OPEN (and
 * closeTime, defensively) in OrdersService, not by a DB constraint, since
 * that decision needs the current time and can't be expressed as a
 * static CHECK.
 */
@Injectable()
export class MarketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly txRunner: SerializableTransactionRunner,
    private readonly auditLog: AuditLogService,
  ) {}

  async listOpen() {
    return this.prisma.market.findMany({
      where: { status: MarketStatus.OPEN },
      include: { category: true, outcomes: { orderBy: { sortOrder: "asc" } } },
      orderBy: { createdAt: "desc" },
    });
  }

  async getBySlug(slug: string) {
    const market = await this.prisma.market.findUnique({
      where: { slug },
      include: { category: true, outcomes: { orderBy: { sortOrder: "asc" } } },
    });
    if (!market) {
      throw new NotFoundException(`Market '${slug}' not found`);
    }
    return market;
  }

  async listCategories() {
    return this.prisma.marketCategory.findMany({ orderBy: { name: "asc" } });
  }

  async create(dto: CreateMarketDto, createdById: string) {
    const category = await this.prisma.marketCategory.findUnique({ where: { slug: dto.categorySlug } });
    if (!category) {
      throw new BadRequestException(`Unknown category '${dto.categorySlug}'`);
    }

    const keys = dto.outcomes.map((o) => o.key);
    if (new Set(keys).size !== keys.length) {
      throw new BadRequestException("Outcome keys must be unique within a market");
    }

    return this.prisma.market.create({
      data: {
        slug: dto.slug,
        title: dto.title,
        description: dto.description,
        categoryId: category.id,
        openTime: dto.openTime ? new Date(dto.openTime) : null,
        closeTime: dto.closeTime ? new Date(dto.closeTime) : null,
        resolutionSource: dto.resolutionSource,
        resolutionCriteria: dto.resolutionCriteria,
        createdById,
        outcomes: {
          create: dto.outcomes.map((outcome, index) => ({
            key: outcome.key,
            label: outcome.label,
            sortOrder: index,
          })),
        },
      },
      include: { outcomes: true },
    });
  }

  async open(marketId: string, adminId: string) {
    return this.transitionStatus(marketId, adminId, [MarketStatus.DRAFT], MarketStatus.OPEN, "market.open");
  }

  async close(marketId: string, adminId: string) {
    return this.transitionStatus(
      marketId,
      adminId,
      [MarketStatus.OPEN, MarketStatus.PAUSED],
      MarketStatus.CLOSED,
      "market.close",
    );
  }

  private async transitionStatus(
    marketId: string,
    adminId: string,
    allowedFrom: MarketStatus[],
    nextStatus: MarketStatus,
    action: string,
  ) {
    const { market, previousStatus } = await this.txRunner.run(async (tx) => {
      const current = await tx.market.findUnique({ where: { id: marketId } });
      if (!current) {
        throw new NotFoundException("Market not found");
      }

      const result = await tx.market.updateMany({
        where: { id: marketId, status: { in: allowedFrom } },
        data: { status: nextStatus },
      });
      if (result.count === 0) {
        throw new ConflictException(
          `Market ${marketId} is in status ${current.status}, expected one of: ${allowedFrom.join(", ")}`,
        );
      }

      return { market: await tx.market.findUniqueOrThrow({ where: { id: marketId } }), previousStatus: current.status };
    });

    await this.auditLog.record({
      actorId: adminId,
      action,
      resourceType: "Market",
      resourceId: marketId,
      before: { status: previousStatus },
      after: { status: market.status },
    });

    return market;
  }
}
