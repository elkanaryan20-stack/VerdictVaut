import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { resolveAssetNetworkContext } from "../../chain-adapters/asset-network-context.util";
import { fetchJsonRpc } from "../../chain-adapters/chain-http.util";
import { rawUnitsToDecimalString } from "../../chain-adapters/decimal-units.util";
import { addressToTopic, ERC20_TRANSFER_TOPIC, EvmTransaction, EvmTransactionReceipt, hexToBlockNumber } from "../../chain-adapters/evm/evm-json-rpc.types";
import { ChainRpcConfigService } from "../../chain-adapters/rpc-config.service";
import { ChainBalance, ChainTransactionStatus, CustodyProvider } from "../custody-provider.interface";

/** `balanceOf(address)` selector — keccak256("balanceOf(address)").slice(0,4). */
const BALANCE_OF_SELECTOR = "0x70a08231";

@Injectable()
export class EvmCustodyProvider implements CustodyProvider {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rpcConfig: ChainRpcConfigService,
  ) {}

  async getAddressBalance(address: string, assetNetworkId: string): Promise<ChainBalance> {
    const network = await resolveAssetNetworkContext(this.prisma, assetNetworkId);
    const url = this.rpcConfig.getRpcUrl(network.networkCode);

    const raw = network.isNative
      ? await fetchJsonRpc<string>(url, "eth_getBalance", [address, "latest"])
      : await fetchJsonRpc<string>(url, "eth_call", [
          { to: network.contractAddress, data: `${BALANCE_OF_SELECTOR}${addressToTopic(address).slice(2)}` },
          "latest",
        ]);

    return { address, assetNetworkId, balance: rawUnitsToDecimalString(BigInt(raw), network.assetDecimals), asOf: new Date() };
  }

  async getTransactionStatus(txHash: string, assetNetworkId: string): Promise<ChainTransactionStatus> {
    const network = await resolveAssetNetworkContext(this.prisma, assetNetworkId);
    const url = this.rpcConfig.getRpcUrl(network.networkCode);

    const tx = await fetchJsonRpc<EvmTransaction | null>(url, "eth_getTransactionByHash", [txHash]);
    if (!tx) {
      return { txHash, assetNetworkId, confirmations: 0, amount: "0", status: "not_found" };
    }
    if (!tx.blockNumber) {
      return { txHash, assetNetworkId, confirmations: 0, amount: rawUnitsToDecimalString(BigInt(tx.value), network.assetDecimals), status: "pending" };
    }

    const currentBlock = hexToBlockNumber(await fetchJsonRpc<string>(url, "eth_blockNumber", []));
    const confirmations = Math.max(currentBlock - hexToBlockNumber(tx.blockNumber) + 1, 0);

    if (network.isNative) {
      return {
        txHash,
        assetNetworkId,
        confirmations,
        amount: rawUnitsToDecimalString(BigInt(tx.value), network.assetDecimals),
        status: "confirmed",
      };
    }

    const receipt = await fetchJsonRpc<EvmTransactionReceipt | null>(url, "eth_getTransactionReceipt", [txHash]);
    const transferLog = receipt?.logs.find(
      (log) => log.address.toLowerCase() === network.contractAddress?.toLowerCase() && log.topics[0] === ERC20_TRANSFER_TOPIC,
    );
    const amount = transferLog ? rawUnitsToDecimalString(BigInt(transferLog.data), network.assetDecimals) : "0";
    return { txHash, assetNetworkId, confirmations, amount, status: "confirmed" };
  }
}
