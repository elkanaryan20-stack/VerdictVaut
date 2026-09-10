import { Injectable } from "@nestjs/common";
import { AuditActorType, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export interface RecordAuditLogInput {
  /** Who initiated it — a user/admin id, or omitted for a SYSTEM actor (e.g. an automated watcher). */
  actorId?: string;
  actorType?: AuditActorType;
  /** What happened, e.g. "withdrawal.approve", "deposit.credit". */
  action: string;
  /** What entity changed. */
  resourceType: string;
  resourceId?: string;
  /** Previous state, JSON-serializable (e.g. { status: "RISK_REVIEW" }). */
  before?: Prisma.InputJsonValue;
  /** New state, JSON-serializable (e.g. { status: "APPROVED" }). */
  after?: Prisma.InputJsonValue;
  /** Why, when applicable (e.g. a rejection/failure reason). */
  reason?: string;
  /** The ledger/reservation idempotency key or other stable reference tying this record to the underlying financial event. */
  idempotencyKey?: string;
  ip?: string;
}

/**
 * Append-only trail for every administrative and financial-control
 * action — including automated ones (deposit crediting, watcher-driven
 * withdrawal confirmation), not just admin-initiated HTTP requests.
 * Nothing writes to AuditLog except through this service, and this
 * service never updates or deletes an existing row.
 *
 * Never pass secrets, private keys, JWTs, or other credentials in
 * `before`/`after`/`reason` — this table is meant to be readable by
 * anyone with audit-log access, not treated as a secret store.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordAuditLogInput) {
    return this.prisma.auditLog.create({
      data: {
        actorId: input.actorId,
        actorType: input.actorType ?? (input.actorId ? AuditActorType.ADMIN : AuditActorType.SYSTEM),
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        before: input.before,
        after: input.after,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        ip: input.ip,
      },
    });
  }

  async list(filters: { resourceType?: string; actorId?: string; resourceId?: string; action?: string } = {}) {
    return this.prisma.auditLog.findMany({
      where: {
        resourceType: filters.resourceType,
        actorId: filters.actorId,
        resourceId: filters.resourceId,
        action: filters.action,
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }
}
