-- Phase 12A: new enum values only, split into their own migration
-- because Postgres forbids using a newly-added enum value inside the
-- same transaction that added it (each migration.sql runs as one
-- transaction) — see the DepositStatus.REJECTED precedent
-- (20260906120000_deposit_watcher_infrastructure) for the same pattern.
-- Everything that actually USES 'MARKET'/'MINT' lives in the next
-- migration, 20260910000100_settlement_collateralization.

-- A third LedgerAccount owner type, alongside USER/HOUSE — a market's
-- own locked collateral, real cash already debited from users at
-- complete-set mint time.
ALTER TYPE "LedgerAccountOwnerType" ADD VALUE 'MARKET';

-- Locks collateral for a newly-minted complete set — see
-- CompleteSetMint and ExecutionCoordinator.applyMintExecution.
ALTER TYPE "LedgerTransactionType" ADD VALUE 'MINT';
