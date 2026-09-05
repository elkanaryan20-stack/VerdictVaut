import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Read-only for now — nothing writes a Position's quantity/avgPrice yet
 * (that happens when fills are applied, which requires the matching
 * engine this phase deliberately does not build). Never fabricate a
 * position or its values ahead of that.
 */
@Injectable()
export class PositionsService {
  constructor(private readonly prisma: PrismaService) {}

  async listMine(userId: string) {
    return this.prisma.position.findMany({
      where: { userId },
      include: { outcome: { include: { market: true } } },
      orderBy: { updatedAt: "desc" },
    });
  }

  async getOne(userId: string, marketId: string, outcomeId: string) {
    return this.prisma.position.findUnique({
      where: { userId_marketId_outcomeId: { userId, marketId, outcomeId } },
      include: { outcome: { include: { market: true } } },
    });
  }
}
