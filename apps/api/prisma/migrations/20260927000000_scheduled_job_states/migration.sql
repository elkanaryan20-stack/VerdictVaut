-- Phase 35 -- purely additive: one new table, no change to any existing
-- table, column, constraint, or row. Holds scheduling/lease/heartbeat
-- state for worker background jobs (see ScheduledJobState in
-- schema.prisma); never financial state. Rolling back = dropping this
-- table, which only resets job scheduling (every job simply becomes
-- "due" again, and every reconciliation job it drives is read-only).
CREATE TABLE "scheduled_job_states" (
    "jobKey" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastStartedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastSummary" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_job_states_pkey" PRIMARY KEY ("jobKey")
);
