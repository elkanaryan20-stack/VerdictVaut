"use client";

import { useState } from "react";
import { cn } from "../../lib/cn";
import { FillsTable } from "../../components/trading/FillsTable";
import { OpenOrdersTable } from "../../components/trading/OpenOrdersTable";
import { OrderHistoryTable } from "../../components/trading/OrderHistoryTable";
import { PositionsTable } from "../../components/trading/PositionsTable";
import { SettlementHistoryTable } from "../../components/trading/SettlementHistoryTable";

const TABS = [
  { value: "open-orders", label: "Open orders" },
  { value: "positions", label: "Positions" },
  { value: "history", label: "History" },
  { value: "fills", label: "Fills" },
  { value: "settlement", label: "Settlement" },
] as const;

type Tab = (typeof TABS)[number]["value"];

export default function PortfolioPage() {
  const [tab, setTab] = useState<Tab>("open-orders");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-white sm:text-2xl">Portfolio</h1>
        <p className="mt-1 text-sm text-white/50">Your orders, positions, and trade history.</p>
      </div>

      <div role="tablist" aria-label="Portfolio sections" className="flex flex-wrap gap-2 border-b border-vault-border pb-3">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            onClick={() => setTab(t.value)}
            className={cn(
              "rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vault-gold",
              tab === t.value ? "border-vault-gold bg-vault-gold/10 text-vault-gold" : "border-vault-border text-white/60 hover:bg-white/5 hover:text-white",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "open-orders" && <OpenOrdersTable />}
      {tab === "positions" && <PositionsTable />}
      {tab === "history" && <OrderHistoryTable />}
      {tab === "fills" && <FillsTable />}
      {tab === "settlement" && <SettlementHistoryTable />}
    </div>
  );
}
