import { DepositHistoryTable } from "../../../components/wallet/DepositHistoryTable";

export default function DepositHistoryPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-white">Deposit history</h1>
        <p className="mt-1 text-sm text-white/50">Every deposit VerdictVaut has observed for your account.</p>
      </div>
      <DepositHistoryTable />
    </div>
  );
}
