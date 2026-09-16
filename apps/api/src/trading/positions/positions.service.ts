import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Read-only from this service's own perspective — it only lists a
 * user's positions, never mutates one. Position.quantity/avgPrice ARE
 * written elsewhere, by ExecutionCoordinator (../execution/execution-
 * coordinator.service.ts's updatePositions()/increaseBuyerPosition())
 * as fills and complete-set mints are applied — corrected here (Phase
 * 31) after this docblock was found to have gone stale once the
 * matching engine it originally described as "deliberately not built
 * yet" was actually built. Never fabricate a position or its values
 * outside that one real write path.
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
