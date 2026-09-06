import type { AssetNetworkView, DepositAddressAssignment } from "@verdictvaut/shared-types";
import { AlertTriangle } from "lucide-react";
import { CopyButton } from "../ui/CopyButton";
import { QrCode } from "../ui/QrCode";
import { formatExactAmount } from "../../lib/format";

export function DepositAddressCard({
  assignment,
  assetNetwork,
}: {
  assignment: DepositAddressAssignment;
  assetNetwork: AssetNetworkView;
}) {
  const address = assignment.walletAddress.address;
  const destinationTag = assignment.walletAddress.destinationTag;

  return (
    <div className="flex flex-col gap-5 sm:flex-row">
      <QrCode value={address} label={`Deposit address for ${assetNetwork.asset.symbol} on ${assetNetwork.network.name}`} />

      <div className="min-w-0 flex-1 space-y-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-white/50">Deposit address</p>
          <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-vault-border bg-black/30 px-3 py-2.5">
            <code className="min-w-0 flex-1 break-all font-mono text-sm text-white">{address}</code>
          </div>
          <div className="mt-2">
            <CopyButton value={address} label="Copy address" />
          </div>
        </div>

        {destinationTag && (
          <div className="rounded-lg border border-vault-gold/40 bg-vault-gold/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-vault-gold" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-vault-gold">Destination tag required</p>
                <p className="mt-0.5 text-xs text-white/60">
                  You must include this destination tag with your deposit, in addition to the address above. A deposit sent without
                  it — or with the wrong one — cannot be credited to your account.
                </p>
                <div className="mt-2 flex items-center gap-2 rounded-md border border-vault-border bg-black/30 px-3 py-2">
                  <code className="min-w-0 flex-1 font-mono text-sm text-white">{destinationTag}</code>
                </div>
                <div className="mt-2">
                  <CopyButton value={destinationTag} label="Copy destination tag" />
                </div>
              </div>
            </div>
          </div>
        )}

        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs text-white/40">Network</dt>
            <dd className="text-white">{assetNetwork.network.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-white/40">Confirmations required</dt>
            <dd className="text-white">{assetNetwork.minConfirmations}</dd>
          </div>
          {Number(assetNetwork.depositMinAmount) > 0 && (
            <div>
              <dt className="text-xs text-white/40">Minimum deposit</dt>
              <dd className="text-white">
                {formatExactAmount(assetNetwork.depositMinAmount)} {assetNetwork.asset.symbol}
              </dd>
            </div>
          )}
          {!assetNetwork.isNative && assetNetwork.contractAddress && (
            <div className="col-span-2">
              <dt className="text-xs text-white/40">Token contract</dt>
              <dd className="break-all font-mono text-xs text-white/70">{assetNetwork.contractAddress}</dd>
            </div>
          )}
        </dl>

        <p className="text-xs text-white/40">
          Only send {assetNetwork.asset.symbol} on {assetNetwork.network.name} to this address. Sending any other asset, or using a
          different network, may result in permanent loss of funds.
        </p>
      </div>
    </div>
  );
}
