-- Phase 33 — an active AssetNetwork's contractAddress must uniquely
-- identify at most one asset on a given network. Without this, an admin
-- misconfiguration (e.g. copy-pasting the same EVM contract address into
-- two active AssetNetwork rows — say USDC and USDT on the same network)
-- would leave the watcher/reconciliation layer no way to tell which
-- asset a real on-chain Transfer event from that one contract belongs
-- to: the wrong asset could be credited with real economic impact. This
-- is the same class of human-error defense Phase 32 already added for
-- Withdrawal.txHash (an admin fat-fingering the same value twice).
--
-- Scoped to isActive rows only, and only where contractAddress is set
-- (native rows never have one, per asset_networks_active_token_requires_contract_check) —
-- a deactivated/superseded AssetNetwork row is legitimately allowed to
-- keep sharing a contractAddress with the active row that replaced it
-- (e.g. correcting an earlier misconfiguration without losing history).
-- A partial unique index, not a @@unique in schema.prisma, precisely
-- because Prisma cannot express a partial (WHERE-scoped) unique
-- constraint natively.
CREATE UNIQUE INDEX "asset_networks_active_contract_address_key"
  ON "asset_networks" ("networkId", "contractAddress")
  WHERE "isActive" = true AND "contractAddress" IS NOT NULL;
