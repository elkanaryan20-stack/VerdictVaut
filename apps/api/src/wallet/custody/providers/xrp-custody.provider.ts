import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { resolveAssetNetworkContext } from "../../chain-adapters/asset-network-context.util";
import { rawUnitsToDecimalString } from "../../chain-adapters/decimal-units.util";
import { ChainRpcConfigService } from "../../chain-adapters/rpc-config.service";
import { callRippled } from "../../chain-adapters/xrp/rippled-rpc.util";
import { XrplServerInfoResult, XrplTxMethodResult } from "../../chain-adapters/xrp/xrpl-rpc.types";
import { ChainBalance, ChainTransactionStatus, CustodyProvider } from "../custody-provider.interface";

interface XrplAccountInfoResult {
  account_data: { Balance: string };
}

@Injectable()
export class XrpCustodyProvider implements CustodyProvider {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rpcConfig: ChainRpcConfigService,
  ) {}

  async getAddressBalance(address: string, assetNetworkId: string): Promise<ChainBalance> {
    const network = await resolveAssetNetworkContext(this.prisma, assetNetworkId);
    const url = this.rpcConfig.getRpcUrl(network.networkCode);

    const result = await callRippled<XrplAccountInfoResult>(url, "account_info", { account: address });
    if (result.status === "error") {
      // An unfunded/never-activated address genuinely has zero balance —
      // not a provider failure.
      if (result.error === "actNotFound") {
        return { address, assetNetworkId, balance: "0", asOf: new Date() };
      }
      throw new ServiceUnavailableException(`XRPL account_info error: ${result.error}`);
    }

    return {
      address,
      assetNetworkId,
      balance: rawUnitsToDecimalString(result.account_data.Balance, network.assetDecimals),
      asOf: new Date(),
    };
  }

  async getTransactionStatus(txHash: string, assetNetworkId: string): Promise<ChainTransactionStatus> {
    const network = await resolveAssetNetworkContext(this.prisma, assetNetworkId);
    const url = this.rpcConfig.getRpcUrl(network.networkCode);

    const tx = await callRippled<XrplTxMethodResult>(url, "tx", { transaction: txHash });
    if (tx.status === "error") {
      if (tx.error === "txnNotFound") {
        return { txHash, assetNetworkId, confirmations: 0, amount: "0", status: "not_found" };
      }
      throw new ServiceUnavailableException(`XRPL tx lookup error: ${tx.error}`);
    }

    const amountRaw = tx.meta.delivered_amount ?? tx.Amount;
    const amount = typeof amountRaw === "string" ? rawUnitsToDecimalString(amountRaw, network.assetDecimals) : "0";

    if (!tx.validated) {
      return { txHash, assetNetworkId, confirmations: 0, amount, status: "pending" };
    }

    const info = await callRippled<XrplServerInfoResult>(url, "server_info", {});
    const currentLedger = info.status === "error" ? tx.ledger_index : info.info.validated_ledger?.seq ?? tx.ledger_index;
    const confirmations = Math.max(currentLedger - tx.ledger_index + 1, 0);

    return { txHash, assetNetworkId, confirmations, amount, status: "confirmed" };
  }
}
