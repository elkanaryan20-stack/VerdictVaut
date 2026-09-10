-- Phase 14A: new enum value only, split into its own migration for the
-- same reason as prior enum-value additions in this repo — Postgres
-- forbids using a newly-added enum value inside the same transaction
-- that added it. Everything that actually USES 'EXECUTION_AMBIGUOUS'
-- lives in the next migration, 20260914000100_provider_config.

ALTER TYPE "WithdrawalStatus" ADD VALUE 'EXECUTION_AMBIGUOUS';
