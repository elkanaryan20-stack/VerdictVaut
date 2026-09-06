import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { resolveAssetNetworkContext } from "../../chain-adapters/asset-network-context.util";
import { fetchJson } from "../../chain-adapters/chain-http.util";
import { rawUnitsToDecimalString } from "../../chain-adapters/decimal-units.util";
import { ChainRpcConfigService } from "../../chain-adapters/rpc-config.service";
import { PrismaService } from "../../../prisma/prisma.service";
import { ChainBalance, ChainTransactionStatus, CustodyProvider } from "../custody-provider.interface";

interface EsploraAddressStats {
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
}

interface EsploraTxLite {
  vout: { value: number }[];
  status: { confirmed: boolean; block_height?: number };
}

@Injectable()
export class BitcoinCustodyProvider implements CustodyProvider {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rpcConfig: ChainRpcConfigService,
  ) {}

  async getAddressBalance(address: string, assetNetworkId: string): Promise<ChainBalance> {
    const network = await resolveAssetNetworkContext(this.prisma, assetNetworkId);
    const baseUrl = this.rpcConfig.getRpcUrl(network.networkCode);
    const stats = await fetchJson<EsploraAddressStats>(`${baseUrl}/address/${address}`);
    // Confirmed balance only — mempool activity is deliberately excluded,
    // consistent with never treating an unconfirmed observation as final.
    const balance = stats.chain_stats.funded_txo_sum - stats.chain_stats.spent_txo_sum;
    return { address, assetNetworkId, balance: rawUnitsToDecimalString(BigInt(balance), network.assetDecimals), asOf: new Date() };
  }

  async getTransactionStatus(txHash: string, assetNetworkId: string): Promise<ChainTransactionStatus> {
    const network = await resolveAssetNetworkContext(this.prisma, assetNetworkId);
    const baseUrl = this.rpcConfig.getRpcUrl(network.networkCode);
    const response = await fetch(`${baseUrl}/tx/${txHash}`);
    if (response.status === 404) {
      return { txHash, assetNetworkId, confirmations: 0, amount: "0", status: "not_found" };
    }
    if (!response.ok) {
      throw new ServiceUnavailableException(`Bitcoin provider request failed: GET /tx/${txHash} -> ${response.status}`);
    }
    const tx = (await response.json()) as EsploraTxLite;
    const totalOut = tx.vout.reduce((sum, o) => sum + o.value, 0);

    if (!tx.status.confirmed) {
      return { txHash, assetNetworkId, confirmations: 0, amount: rawUnitsToDecimalString(BigInt(totalOut), network.assetDecimals), status: "pending" };
    }
    const tipHeight = await fetchJson<number>(`${baseUrl}/blocks/tip/height`);
    const confirmations = Math.max(tipHeight - (tx.status.block_height ?? tipHeight) + 1, 0);
    return {
      txHash,
      assetNetworkId,
      confirmations,
      amount: rawUnitsToDecimalString(BigInt(totalOut), network.assetDecimals),
      status: "confirmed",
    };
  }
}
