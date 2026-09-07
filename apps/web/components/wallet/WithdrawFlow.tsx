"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { generateClientOrderId } from "../../lib/trading/client-order-id";
import { ApiError } from "../../lib/api-client";
import { formatAmount, formatExactAmount } from "../../lib/format";
import { subtractDecimalStrings } from "../../lib/wallet/decimal";
import { useAssetNetworks, useBalances, useRequestWithdrawal } from "../../lib/wallet/hooks";
import { Button } from "../ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Dialog } from "../ui/Dialog";
import { Skeleton } from "../ui/Skeleton";
import { TextField } from "../ui/TextField";
import { AssetSelector } from "./AssetSelector";
import { NetworkSelector } from "./NetworkSelector";
import { WithdrawalStatusBadge } from "./WithdrawalStatusBadge";

const DECIMAL_STRING = /^\d+(\.\d+)?$/;

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Something went wrong submitting this withdrawal. Please try again.";
}

/**
 * Minimum withdrawal UI required to safely drive the backend: pick
 * asset + network explicitly (never inferred from the asset alone —
 * requirement #10), enter a destination (+ tag/memo when the network
 * requires one), review in a confirmation dialog, submit, then show the
 * real backend-returned status. No fee/estimated-received figure is
 * shown before submission — the platform has no fee-quote endpoint, and
 * inventing one client-side would be exactly the frontend financial
 * authority requirement #22 forbids; both figures are shown only once
 * the backend has actually computed and returned them.
 */
export function WithdrawFlow() {
  const { data: assetNetworks, isLoading, isError, refetch } = useAssetNetworks();
  const balancesQuery = useBalances();
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [selectedNetworkCode, setSelectedNetworkCode] = useState<string | null>(null);
  const [destinationAddress, setDestinationAddress] = useState("");
  const [destinationTag, setDestinationTag] = useState("");
  const [amount, setAmount] = useState("");
  const [clientWithdrawalId, setClientWithdrawalId] = useState(() => generateClientOrderId());
  const [localError, setLocalError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const requestMutation = useRequestWithdrawal();

  const networkOptions = useMemo(
    () => (assetNetworks ?? []).filter((an) => an.asset.symbol === selectedAsset),
    [assetNetworks, selectedAsset],
  );
  const selectedAssetNetwork = networkOptions.find((an) => an.network.code === selectedNetworkCode) ?? null;
  const balance = balancesQuery.data?.find((b) => b.symbol === selectedAsset);

  const assets = useMemo(() => {
    if (!assetNetworks) return [];
    const bySymbol = new Map<string, { symbol: string; name: string }>();
    for (const an of assetNetworks) {
      if (!bySymbol.has(an.asset.symbol)) bySymbol.set(an.asset.symbol, { symbol: an.asset.symbol, name: an.asset.name });
    }
    return [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }, [assetNetworks]);

  function resetForNewAttempt() {
    setClientWithdrawalId(generateClientOrderId());
    requestMutation.reset();
  }

  function handleSelectAsset(symbol: string) {
    setSelectedAsset(symbol);
    setSelectedNetworkCode(null);
    resetForNewAttempt();
  }

  function validate(): string | null {
    if (!selectedAssetNetwork) return "Choose an asset and network.";
    if (!destinationAddress.trim()) return "Enter a destination address.";
    if (selectedAssetNetwork.memoRequired && !destinationTag.trim()) return "This network requires a destination tag/memo.";
    if (!DECIMAL_STRING.test(amount) || Number(amount) <= 0) return "Enter a valid amount greater than zero.";
    if (Number(amount) <= Number(selectedAssetNetwork.withdrawalMinAmount)) {
      return `Amount must be greater than the minimum withdrawal of ${formatExactAmount(selectedAssetNetwork.withdrawalMinAmount)} ${selectedAssetNetwork.asset.symbol}.`;
    }
    if (balance && Number(amount) > Number(balance.availableBalance)) {
      return `Amount exceeds your available balance of ${formatExactAmount(balance.availableBalance)} ${selectedAssetNetwork.asset.symbol}.`;
    }
    return null;
  }

  function handleReview(e: React.FormEvent) {
    e.preventDefault();
    const error = validate();
    if (error) {
      setLocalError(error);
      return;
    }
    setLocalError(null);
    setConfirmOpen(true);
  }

  function handleConfirm() {
    if (!selectedAssetNetwork) return;
    requestMutation.mutate(
      {
        assetSymbol: selectedAssetNetwork.asset.symbol,
        networkCode: selectedAssetNetwork.network.code,
        amount,
        destinationAddress,
        destinationTag: selectedAssetNetwork.memoRequired ? destinationTag : undefined,
        clientWithdrawalId,
      },
      { onSuccess: () => setConfirmOpen(false) },
    );
  }

  function handleNewWithdrawal() {
    setDestinationAddress("");
    setDestinationTag("");
    setAmount("");
    setLocalError(null);
    resetForNewAttempt();
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Withdraw</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </CardBody>
      </Card>
    );
  }

  if (isError || !assetNetworks) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Withdraw</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col items-start gap-3 text-sm text-white/60">
          <p>Couldn&apos;t load supported assets and networks.</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5"
          >
            Retry
          </button>
        </CardBody>
      </Card>
    );
  }

  const result = requestMutation.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Withdraw</CardTitle>
      </CardHeader>
      <CardBody className="space-y-6">
        {!result && (
          <>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/50">1. Choose an asset</p>
              <AssetSelector assets={assets} selected={selectedAsset} onSelect={handleSelectAsset} ariaLabel="Select an asset to withdraw" />
            </div>

            {selectedAsset && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/50">2. Choose a network</p>
                {networkOptions.length === 0 ? (
                  <p className="text-sm text-white/50">No networks are currently available for {selectedAsset} withdrawals.</p>
                ) : (
                  <NetworkSelector
                    options={networkOptions}
                    selectedNetworkCode={selectedNetworkCode}
                    onSelect={(code) => {
                      setSelectedNetworkCode(code);
                      resetForNewAttempt();
                    }}
                  />
                )}
              </div>
            )}

            {selectedAssetNetwork && (
              <div className="space-y-4">
                <p className="text-xs font-medium uppercase tracking-wide text-white/50">3. Destination &amp; amount</p>

                <div className="rounded-lg border border-vault-border bg-white/[0.02] px-3 py-2 text-xs text-white/50">
                  {balancesQuery.isLoading ? (
                    "Loading available balance…"
                  ) : balance ? (
                    <>
                      Available: <span className="font-medium text-white">{formatAmount(balance.availableBalance)} {balance.symbol}</span>
                    </>
                  ) : (
                    "Available balance unavailable."
                  )}
                </div>

                <form onSubmit={handleReview} className="space-y-4">
                  <TextField
                    label="Destination address"
                    value={destinationAddress}
                    onChange={(e) => {
                      setDestinationAddress(e.target.value);
                      resetForNewAttempt();
                    }}
                    placeholder={`Your ${selectedAssetNetwork.network.name} address`}
                  />

                  {selectedAssetNetwork.memoRequired && (
                    <TextField
                      label="Destination tag / memo"
                      hint="Required for this network — an incorrect or missing tag can result in lost funds."
                      value={destinationTag}
                      onChange={(e) => {
                        setDestinationTag(e.target.value);
                        resetForNewAttempt();
                      }}
                    />
                  )}

                  <TextField
                    label={`Amount (${selectedAssetNetwork.asset.symbol})`}
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      resetForNewAttempt();
                    }}
                    hint={`Minimum withdrawal: ${formatExactAmount(selectedAssetNetwork.withdrawalMinAmount)} ${selectedAssetNetwork.asset.symbol}`}
                  />

                  {localError && (
                    <p role="alert" className="text-xs text-vault-down">
                      {localError}
                    </p>
                  )}

                  <Button type="submit" className="w-full">
                    Review withdrawal
                  </Button>
                </form>
              </div>
            )}
          </>
        )}

        {result && (
          <div className="space-y-3 rounded-lg border border-vault-border bg-white/[0.02] p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-white">Withdrawal submitted</p>
              <WithdrawalStatusBadge status={result.status} />
            </div>
            <dl className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-white/50">Amount</dt>
                <dd className="tabular-nums text-white">{formatExactAmount(result.amount)}</dd>
              </div>
              {Number(result.fee) > 0 && (
                <div className="flex justify-between">
                  <dt className="text-white/50">Fee</dt>
                  <dd className="tabular-nums text-white">{formatExactAmount(result.fee)}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-white/50">Estimated received</dt>
                <dd className="tabular-nums text-white">{formatExactAmount(subtractDecimalStrings(result.amount, result.fee))}</dd>
              </div>
            </dl>
            <p className="text-xs text-white/40">
              Your funds are reserved and this withdrawal is pending platform review. Track its progress on the{" "}
              <Link href="/wallet/withdrawals" className="text-vault-gold hover:underline">
                withdrawal history
              </Link>{" "}
              page.
            </p>
            <Button type="button" variant="secondary" size="sm" onClick={handleNewWithdrawal}>
              Start another withdrawal
            </Button>
          </div>
        )}
      </CardBody>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!requestMutation.isPending) setConfirmOpen(open);
        }}
        title="Confirm withdrawal"
        description="Review carefully — sending to the wrong address or network can result in permanent loss of funds."
      >
        {selectedAssetNetwork && (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-2 rounded-lg border border-vault-down/30 bg-vault-down/5 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-vault-down" aria-hidden="true" />
              <p className="text-xs text-white/70">This action cannot be undone once approved and broadcast. Double-check the destination.</p>
            </div>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-white/50">Asset</dt>
                <dd className="text-white">{selectedAssetNetwork.asset.symbol}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-white/50">Network</dt>
                <dd className="text-white">{selectedAssetNetwork.network.name}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="shrink-0 text-white/50">Destination</dt>
                <dd className="break-all text-right font-mono text-xs text-white">{destinationAddress}</dd>
              </div>
              {selectedAssetNetwork.memoRequired && (
                <div className="flex justify-between">
                  <dt className="text-white/50">Destination tag</dt>
                  <dd className="text-white">{destinationTag}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-white/50">Amount</dt>
                <dd className="tabular-nums text-white">
                  {formatExactAmount(amount)} {selectedAssetNetwork.asset.symbol}
                </dd>
              </div>
            </dl>

            {requestMutation.isError && (
              <p role="alert" className="text-xs text-vault-down">
                {errorMessage(requestMutation.error)}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setConfirmOpen(false)} disabled={requestMutation.isPending}>
                Cancel
              </Button>
              <Button type="button" onClick={handleConfirm} isLoading={requestMutation.isPending}>
                Confirm withdrawal
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </Card>
  );
}
