import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { MarketStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CreateMarketDto } from "./dto/create-market.dto";

@Injectable()
export class MarketsService {
  constructor(private readonly prisma: PrismaService) {}

  async listOpen() {
    return this.prisma.market.findMany({
      where: { status: MarketStatus.OPEN },
      include: { category: true, outcomes: true },
      orderBy: { createdAt: "desc" },
    });
  }

  async getBySlug(slug: string) {
    const market = await this.prisma.market.findUnique({
      where: { slug },
      include: { category: true, outcomes: true },
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
    if (dto.outcomeLabels.length < 2) {
      throw new BadRequestException("A market needs at least two outcomes");
    }

    return this.prisma.market.create({
      data: {
        slug: dto.slug,
        title: dto.title,
        description: dto.description,
        categoryId: category.id,
        closeTime: dto.closeTime ? new Date(dto.closeTime) : null,
        resolutionSource: dto.resolutionSource,
        createdById,
        outcomes: {
          create: dto.outcomeLabels.map((label) => ({ label })),
        },
      },
      include: { outcomes: true },
    });
  }
}
