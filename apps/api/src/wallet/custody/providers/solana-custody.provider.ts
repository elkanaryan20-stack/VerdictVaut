import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { resolveAssetNetworkContext } from "../../chain-adapters/asset-network-context.util";
import { fetchJsonRpc } from "../../chain-adapters/chain-http.util";
import { rawUnitsToDecimalString } from "../../chain-adapters/decimal-units.util";
import { ChainRpcConfigService } from "../../chain-adapters/rpc-config.service";
import { SolanaTransaction } from "../../chain-adapters/solana/solana-rpc.types";
import { ChainBalance, ChainTransactionStatus, CustodyProvider } from "../custody-provider.interface";

interface SignatureStatus {
  slot: number;
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
  err: unknown | null;
}

@Injectable()
export class SolanaCustodyProvider implements CustodyProvider {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rpcConfig: ChainRpcConfigService,
  ) {}

  async getAddressBalance(address: string, assetNetworkId: string): Promise<ChainBalance> {
    const network = await resolveAssetNetworkContext(this.prisma, assetNetworkId);
    const url = this.rpcConfig.getRpcUrl(network.networkCode);

    if (network.isNative) {
      const result = await fetchJsonRpc<{ value: number }>(url, "getBalance", [address]);
      return { address, assetNetworkId, balance: rawUnitsToDecimalString(BigInt(result.value), network.assetDecimals), asOf: new Date() };
    }

    const result = await fetchJsonRpc<{ value: { amount: string; decimals: number } }>(url, "getTokenAccountBalance", [address]);
    return {
      address,
      assetNetworkId,
      balance: rawUnitsToDecimalString(result.value.amount, result.value.decimals),
      asOf: new Date(),
    };
  }

  async getTransactionStatus(txHash: string, assetNetworkId: string): Promise<ChainTransactionStatus> {
    const network = await resolveAssetNetworkContext(this.prisma, assetNetworkId);
    const url = this.rpcConfig.getRpcUrl(network.networkCode);

    const statuses = await fetchJsonRpc<{ value: (SignatureStatus | null)[] }>(url, "getSignatureStatuses", [
      [txHash],
      { searchTransactionHistory: true },
    ]);
    const status = statuses.value[0];
    if (!status) {
      return { txHash, assetNetworkId, confirmations: 0, amount: "0", status: "not_found" };
    }
    // A signature the RPC actually returned a status for is a real,
    // final record on-chain — `err` (Solana's failed-transaction signal,
    // e.g. a program error) is a DIFFERENT condition from "no such
    // signature at all" and must be reported distinctly (requirement
    // #12, "verify transaction success") rather than folded into
    // "not_found", which previously made a genuinely-failed withdrawal
    // broadcast indistinguishable from one that simply never happened.
    if (status.err) {
      return { txHash, assetNetworkId, confirmations: 0, amount: "0", status: "failed" };
    }

    const currentSlot = await fetchJsonRpc<number>(url, "getSlot", []);
    const confirmations = Math.max(currentSlot - status.slot, 0);
    const chainStatus: ChainTransactionStatus["status"] = status.confirmationStatus == null ? "pending" : "confirmed";

    // Coarse total-inflow figure (not tied to one specific recipient — the
    // interface has no address parameter here) — sum of every positive
    // balance delta in the transaction, native or matching this mint.
    const tx = await fetchJsonRpc<SolanaTransaction | null>(url, "getTransaction", [txHash, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
    const amount = tx ? this.sumPositiveDeltas(tx, network.isNative, network.contractAddress, network.assetDecimals) : "0";

    return { txHash, assetNetworkId, confirmations, amount, status: chainStatus };
  }

  private sumPositiveDeltas(tx: SolanaTransaction, isNative: boolean, mint: string | null, decimals: number): string {
    if (!tx.meta) return "0";

    if (isNative) {
      let total = 0n;
      tx.meta.postBalances.forEach((post, i) => {
        const delta = post - tx.meta!.preBalances[i];
        if (delta > 0) total += BigInt(delta);
      });
      return rawUnitsToDecimalString(total, decimals);
    }

    const preByIndex = new Map((tx.meta.preTokenBalances ?? []).map((b) => [b.accountIndex, b]));
    let total = 0n;
    for (const post of tx.meta.postTokenBalances ?? []) {
      if (post.mint !== mint) continue;
      const pre = preByIndex.get(post.accountIndex);
      const delta = BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? "0");
      if (delta > 0n) total += delta;
    }
    return rawUnitsToDecimalString(total, decimals);
  }
}
