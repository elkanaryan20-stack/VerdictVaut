-- Phase 10: worker-concurrency lease + operational observability columns
-- on the existing BlockchainWatchCursor row. Additive only -- existing
-- lastScannedPointer/updatedAt values and behavior are unaffected.
ALTER TABLE "blockchain_watch_cursors"
  ADD COLUMN "lockedAt" TIMESTAMP(3),
  ADD COLUMN "lockedBy" TEXT,
  ADD COLUMN "lastSuccessAt" TIMESTAMP(3),
  ADD COLUMN "lastError" TEXT,
  ADD COLUMN "lastErrorAt" TIMESTAMP(3);

-- Lets an admin/observability query cheaply find leases that look stale
-- (lockedAt older than some threshold) without a full table scan.
CREATE INDEX "blockchain_watch_cursors_lockedAt_idx" ON "blockchain_watch_cursors"("lockedAt");
