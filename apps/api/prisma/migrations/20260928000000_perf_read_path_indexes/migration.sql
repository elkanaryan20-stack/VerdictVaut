-- Phase 38 — purely additive read-path indexes, each backed by an
-- EXPLAIN ANALYZE showing a full-table scan on a per-user / per-page query
-- (test/perf/data-volume.perf-spec.ts). No table, column, constraint or row
-- changes. Rollback = DROP INDEX (queries stay correct, only slower).
--
-- Plain CREATE INDEX (not CONCURRENTLY): Prisma runs each migration in a
-- transaction, where CONCURRENTLY is not allowed, and these tables are empty
-- before launch. On a large live table this would take a write lock for the
-- build — see docs/production-deployment-plan.md's migration guidance.

-- FillsService.listMine: WHERE buyerUserId = $1 OR sellerUserId = $1 ORDER BY executedAt DESC
CREATE INDEX "fills_buyerUserId_executedAt_idx" ON "fills"("buyerUserId", "executedAt");
CREATE INDEX "fills_sellerUserId_executedAt_idx" ON "fills"("sellerUserId", "executedAt");

-- AuditLogService.list: ORDER BY createdAt DESC LIMIT 200
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");
