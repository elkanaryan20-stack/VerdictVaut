import { WithdrawFlow } from "../../../components/wallet/WithdrawFlow";

export default function WithdrawPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-white">Withdraw</h1>
        <p className="mt-1 text-sm text-white/50">
          Withdrawals are reserved immediately, then reviewed by platform staff before any funds leave — VerdictVaut never
          broadcasts a transaction the moment you submit this form.
        </p>
      </div>
      <WithdrawFlow />
    </div>
  );
}
