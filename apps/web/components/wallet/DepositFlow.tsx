"use client";

import { useMemo, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";
import { useAssetNetworks, useDepositAddress } from "../../lib/wallet/hooks";
import { AssetSelector } from "./AssetSelector";
import { NetworkSelector } from "./NetworkSelector";
import { DepositAddressCard } from "./DepositAddressCard";

export function DepositFlow({ initialAsset }: { initialAsset?: string | null }) {
  const { data: assetNetworks, isLoading, isError, refetch } = useAssetNetworks();
  const [selectedAsset, setSelectedAsset] = useState<string | null>(initialAsset ?? null);
  const [selectedNetworkCode, setSelectedNetworkCode] = useState<string | null>(null);

  const assets = useMemo(() => {
    if (!assetNetworks) return [];
    const bySymbol = new Map<string, { symbol: string; name: string }>();
    for (const an of assetNetworks) {
      if (!bySymbol.has(an.asset.symbol)) {
        bySymbol.set(an.asset.symbol, { symbol: an.asset.symbol, name: an.asset.name });
      }
    }
    return [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }, [assetNetworks]);

  const networkOptions = useMemo(
    () => (assetNetworks ?? []).filter((an) => an.asset.symbol === selectedAsset),
    [assetNetworks, selectedAsset],
  );

  const selectedAssetNetwork = networkOptions.find((an) => an.network.code === selectedNetworkCode) ?? null;

  // Keyed by the current (asset, network) selection — see useDepositAddress
  // for why this is a query, not a mutation: switching networks changes
  // the key, so an earlier, now-abandoned selection's in-flight request
  // can never overwrite what's displayed for the current one.
  const addressQuery = useDepositAddress(selectedAssetNetwork?.asset.symbol ?? null, selectedAssetNetwork?.network.code ?? null);

  function handleSelectAsset(symbol: string) {
    setSelectedAsset(symbol);
    setSelectedNetworkCode(null);
  }

  function handleSelectNetwork(networkCode: string) {
    setSelectedNetworkCode(networkCode);
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Deposit</CardTitle>
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
          <CardTitle>Deposit</CardTitle>
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

  if (assets.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Deposit</CardTitle>
        </CardHeader>
        <CardBody className="text-sm text-white/60">No assets are currently available for deposit.</CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Deposit</CardTitle>
      </CardHeader>
      <CardBody className="space-y-6">
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/50">1. Choose an asset</p>
          <AssetSelector assets={assets} selected={selectedAsset} onSelect={handleSelectAsset} />
        </div>

        {selectedAsset && (
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/50">2. Choose a network</p>
            {networkOptions.length === 0 ? (
              <p className="text-sm text-white/50">No networks are currently available for {selectedAsset}.</p>
            ) : (
              <NetworkSelector options={networkOptions} selectedNetworkCode={selectedNetworkCode} onSelect={handleSelectNetwork} />
            )}
          </div>
        )}

        {selectedAssetNetwork && (
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/50">3. Your deposit address</p>

            {addressQuery.isLoading && (
              <div className="flex items-center gap-3">
                <Skeleton className="h-44 w-44 shrink-0" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-8 w-32" />
                </div>
              </div>
            )}

            {addressQuery.isError && (
              <div className="flex flex-col items-start gap-3 rounded-lg border border-vault-down/30 bg-vault-down/5 p-4 text-sm text-white/70">
                <p>
                  {addressQuery.error instanceof Error
                    ? addressQuery.error.message
                    : "Couldn't get a deposit address for this asset/network."}
                </p>
                <button
                  type="button"
                  onClick={() => addressQuery.refetch()}
                  className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5"
                >
                  Try again
                </button>
              </div>
            )}

            {addressQuery.isSuccess && addressQuery.data && (
              <DepositAddressCard assignment={addressQuery.data} assetNetwork={selectedAssetNetwork} />
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
