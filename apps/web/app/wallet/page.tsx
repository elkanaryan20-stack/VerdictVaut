import Link from "next/link";
import { BalanceSummaryCards } from "../../components/wallet/BalanceSummaryCards";
import { AssetBalanceTable } from "../../components/wallet/AssetBalanceTable";

export default function WalletOverviewPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-white">Wallet</h1>
          <p className="mt-1 text-sm text-white/50">Your real ledger balances — never simulated, always as reported by VerdictVaut.</p>
        </div>
        <Link
          href="/wallet/deposits"
          className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white/70 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vault-gold"
        >
          View deposit history
        </Link>
      </div>

      <BalanceSummaryCards />
      <AssetBalanceTable />
    </div>
  );
}
