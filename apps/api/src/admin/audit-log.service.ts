import { Injectable } from "@nestjs/common";
import { AuditActorType } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export interface RecordAuditLogInput {
  actorId: string;
  actorType?: AuditActorType;
  action: string;
  resourceType: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

/**
 * Append-only trail for every administrative and financial-control
 * action. Nothing writes to AuditLog except through this service, and
 * this service never updates or deletes an existing row.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordAuditLogInput) {
    return this.prisma.auditLog.create({
      data: {
        actorId: input.actorId,
        actorType: input.actorType ?? AuditActorType.ADMIN,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        before: input.before as never,
        after: input.after as never,
        ip: input.ip,
      },
    });
  }

  async list(filters: { resourceType?: string; actorId?: string } = {}) {
    return this.prisma.auditLog.findMany({
      where: {
        resourceType: filters.resourceType,
        actorId: filters.actorId,
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }
}
