"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { DepositFlow } from "../../../components/wallet/DepositFlow";

function DepositPageContent() {
  const searchParams = useSearchParams();
  const initialAsset = searchParams.get("asset");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-white">Deposit</h1>
        <p className="mt-1 text-sm text-white/50">
          VerdictVaut never generates addresses in your browser — every deposit address below comes directly from your account on
          our servers.
        </p>
      </div>
      <DepositFlow initialAsset={initialAsset} />
    </div>
  );
}

export default function DepositPage() {
  return (
    <Suspense fallback={null}>
      <DepositPageContent />
    </Suspense>
  );
}
