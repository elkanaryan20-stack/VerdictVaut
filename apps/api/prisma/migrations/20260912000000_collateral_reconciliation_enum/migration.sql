-- Phase 13: new enum value only, split into its own migration for the
-- same reason as 20260910000000_settlement_collateralization_enums —
-- Postgres forbids using a newly-added enum value inside the same
-- transaction that added it (each migration.sql runs as one
-- transaction). Everything that actually USES 'COLLATERAL_CHECK' lives
-- in the next migration, 20260912000100_collateral_reconciliation.

ALTER TYPE "ReconciliationRunType" ADD VALUE 'COLLATERAL_CHECK';
