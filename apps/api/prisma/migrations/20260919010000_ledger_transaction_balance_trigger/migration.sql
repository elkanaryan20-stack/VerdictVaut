-- Phase 32 — DB-level enforcement that every LedgerTransaction's entries
-- sum to zero, closing the one gap left after auditing the double-entry
-- core: LedgerService.postTransaction already throws UnbalancedTransactionError
-- before writing anything (ledger.service.ts), but that is an
-- application-level guard only. Nothing at the database level stopped a
-- second write path (a script, a future repair tool, a migration) from
-- inserting an unbalanced set of ledger_entries directly — and one
-- already exists in this codebase (apps/api/scripts/backup-restore-drill.js,
-- fixed alongside this migration to insert its own entry pairs inside an
-- explicit transaction so it keeps passing under this new constraint).
-- Every other financial invariant in this schema that has an
-- application-level check (balance non-negativity, reservation bounds,
-- etc.) also has a DB-level CHECK backing it; this was the one exception.
--
-- A plain CHECK constraint cannot express "these rows, grouped by
-- transactionId, sum to zero" (CHECK is per-row only), so this uses a
-- CONSTRAINT TRIGGER instead — the standard Postgres mechanism for a
-- cross-row invariant. DEFERRABLE INITIALLY DEFERRED is required, not
-- optional: LedgerService.postTransaction() inserts N ledger_entries
-- for one transactionId one at a time inside a single SERIALIZABLE
-- transaction, so the sum is unbalanced after the first row and only
-- becomes zero once the last row of that transaction is written — an
-- immediate (non-deferred) trigger would reject every legitimate
-- multi-leg posting. Deferring to COMMIT time means the check only ever
-- sees the final, fully-written state of the enclosing transaction,
-- exactly matching how postTransaction already works.
--
-- ledger_entries is an append-only table in this codebase (no
-- UPDATE/DELETE call site exists anywhere in src/ or scripts/), so the
-- trigger only needs to fire on INSERT.
CREATE OR REPLACE FUNCTION check_ledger_transaction_balance() RETURNS TRIGGER AS $$
DECLARE
  entries_sum NUMERIC;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO entries_sum
  FROM "ledger_entries"
  WHERE "transactionId" = NEW."transactionId";

  IF entries_sum <> 0 THEN
    RAISE EXCEPTION 'ledger_entries for transactionId % do not sum to zero (sum=%)', NEW."transactionId", entries_sum
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_transaction_balance_check
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_ledger_transaction_balance();
