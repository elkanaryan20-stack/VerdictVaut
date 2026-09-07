import { WithdrawalHistoryTable } from "../../../components/wallet/WithdrawalHistoryTable";

export default function WithdrawalHistoryPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-white">Withdrawal history</h1>
        <p className="mt-1 text-sm text-white/50">Every withdrawal you&apos;ve requested, with its real, current status.</p>
      </div>
      <WithdrawalHistoryTable />
    </div>
  );
}
