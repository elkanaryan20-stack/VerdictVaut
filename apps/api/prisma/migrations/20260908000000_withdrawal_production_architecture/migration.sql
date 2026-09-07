-- Phase 9: withdrawal production architecture. Additive only — no
-- existing column is dropped, renamed, or narrowed, and no existing row
-- can violate any new constraint here (no real withdrawal data exists
-- yet; APP_ENVIRONMENT=production still cannot boot — see
-- env.validation.ts).

-- AlterEnum: user-initiated cancellation, distinct from admin-initiated
-- REJECTED. Additive only, and not referenced later in this same
-- migration/transaction, which is required for ALTER TYPE ... ADD VALUE
-- to be transaction-safe on Postgres (see the DepositStatus.REJECTED
-- precedent, 20260906120000_deposit_watcher_infrastructure).
ALTER TYPE "WithdrawalStatus" ADD VALUE 'CANCELLED';

-- CreateEnum
CREATE TYPE "WithdrawalComplianceDecision" AS ENUM ('PASS', 'BLOCKED', 'DEFERRED');

-- AlterTable: new withdrawal columns. clientWithdrawalId gets a
-- temporary generated default so the NOT NULL + backfill can apply to
-- any pre-existing rows in one step, then the default is dropped so
-- every future insert must supply one explicitly (mirrors how
-- orders.clientOrderId is never silently auto-generated at the DB
-- layer either).
ALTER TABLE "withdrawals" ADD COLUMN "clientWithdrawalId" TEXT NOT NULL DEFAULT (gen_random_uuid()::text);
ALTER TABLE "withdrawals" ALTER COLUMN "clientWithdrawalId" DROP DEFAULT;
ALTER TABLE "withdrawals" ADD COLUMN "custodyReference" TEXT;
ALTER TABLE "withdrawals" ADD COLUMN "complianceDecision" "WithdrawalComplianceDecision";
ALTER TABLE "withdrawals" ADD COLUMN "complianceNote" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "withdrawals_userId_clientWithdrawalId_key" ON "withdrawals"("userId", "clientWithdrawalId");

-- CheckConstraint: a withdrawal fee can never consume the whole (or
-- more than the whole) requested amount — the user must always receive
-- something positive on-chain. Additional to the existing
-- withdrawals_fee_non_negative_check (fee >= 0).
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_fee_less_than_amount_check" CHECK ("fee" < "amount");

-- CheckConstraint: once a withdrawal has genuinely reached the
-- broadcast stage or later, it must carry real transaction evidence —
-- never marked BROADCAST/CONFIRMING/CONFIRMED/CREDITED on an admin's
-- word alone with no txHash recorded. Deliberately one-directional
-- (does NOT constrain earlier states, and does NOT constrain
-- REJECTED/FAILED, which are legitimately reachable both before and
-- after a txHash was recorded — see Phase 8's audit note on why a
-- two-directional constraint here would be incorrect).
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_broadcast_requires_txhash_check" CHECK (
  status NOT IN ('BROADCAST', 'CONFIRMING', 'CONFIRMED', 'CREDITED') OR "txHash" IS NOT NULL
);
