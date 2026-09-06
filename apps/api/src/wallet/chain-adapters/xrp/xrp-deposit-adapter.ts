import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { NetworkFamily } from "@prisma/client";
import {
  AssetNetworkContext,
  BlockchainDepositAdapter,
  InspectTransactionParams,
  RawChainDeposit,
  ScanForDepositsParams,
  ScanForDepositsResult,
} from "../deposit-chain-adapter.interface";
import { ChainRpcConfigService } from "../rpc-config.service";
import { callRippled } from "./rippled-rpc.util";
import { mapXrplEntryToDeposit } from "./xrp-tx.mapper";
import { XrplAccountTxResult, XrplServerInfoResult, XrplTxMethodResult, toAccountTxEntry } from "./xrpl-rpc.types";

// Same idempotent-safe-rescan rationale as the Bitcoin/Solana adapters:
// re-checking the most recent page of an account's transaction history
// on every poll is always safe (dedup happens downstream), so there is
// no pagination cursor to get subtly wrong.
const RECENT_TX_LIMIT = 30;

/**
 * XRPL deposit adapter, backed by the standard `rippled` JSON-RPC API
 * (see rpc-config.service.ts for the default public testnet server).
 * XRP is the only XRPL asset supported (see seed.ts) — issued-currency
 * payments are explicitly out of scope and never mapped to a deposit
 * (see xrp-tx.mapper.ts).
 */
@Injectable()
export class XrpDepositAdapter implements BlockchainDepositAdapter {
  readonly family = NetworkFamily.XRPL;

  constructor(private readonly rpcConfig: ChainRpcConfigService) {}

  async validateNetwork(network: AssetNetworkContext): Promise<void> {
    const url = this.rpcConfig.getRpcUrl(network.networkCode);
    const info = await callRippled<XrplServerInfoResult>(url, "server_info", {});
    if (info.status === "error") {
      throw new ServiceUnavailableException(`XRPL server_info error for ${network.networkCode}: ${info.error}`);
    }
    if (!info.info.validated_ledger?.seq) {
      throw new BadRequestException(`XRPL provider for ${network.networkCode} has no validated ledger yet`);
    }
  }

  async scanForDeposits(params: ScanForDepositsParams): Promise<ScanForDepositsResult> {
    const url = this.rpcConfig.getRpcUrl(params.network.networkCode);
    const currentLedger = await this.getValidatedLedgerIndex(url);

    const deposits: RawChainDeposit[] = [];
    for (const watched of params.addresses) {
      const result = await callRippled<XrplAccountTxResult>(url, "account_tx", {
        account: watched.address,
        limit: RECENT_TX_LIMIT,
      });

      if (result.status === "error") {
        // A pre-provisioned deposit address that has never received
        // anything on-chain is a completely normal, expected state on
        // XRPL: an account with no incoming Payment has never been
        // "activated" (funded past the reserve) and rippled reports it
        // as actNotFound rather than an empty history — that is NOT a
        // provider failure and must not crash the scan for every other
        // watched address in this batch.
        if (result.error === "actNotFound") continue;
        throw new ServiceUnavailableException(`XRPL account_tx error for ${watched.address}: ${result.error}`);
      }

      for (const entry of result.transactions) {
        const mapped = mapXrplEntryToDeposit(entry, watched, currentLedger, params.network.assetDecimals);
        if (mapped) deposits.push(mapped);
      }
    }

    return { deposits, nextCursor: new Date().toISOString() };
  }

  async inspectTransaction(params: InspectTransactionParams): Promise<RawChainDeposit | null> {
    const url = this.rpcConfig.getRpcUrl(params.network.networkCode);
    const [currentLedger, tx] = await Promise.all([this.getValidatedLedgerIndex(url), this.fetchTxOrNull(url, params.txHash)]);
    if (!tx) return null;

    return mapXrplEntryToDeposit(toAccountTxEntry(tx), params.address, currentLedger, params.network.assetDecimals);
  }

  private async getValidatedLedgerIndex(url: string): Promise<number> {
    const info = await callRippled<XrplServerInfoResult>(url, "server_info", {});
    if (info.status === "error") {
      throw new ServiceUnavailableException(`XRPL server_info error: ${info.error}`);
    }
    return info.info.validated_ledger?.seq ?? 0;
  }

  /**
   * "txnNotFound" is the one specific, expected shape of "no such
   * transaction" and is the only rippled error mapped to null; any other
   * error propagates as a real failure rather than being silently
   * mistaken for "not found" (the same reasoning as the Bitcoin
   * adapter's fetchTxOrNull — a transient provider error must never look
   * like proof a deposit's transaction doesn't exist).
   */
  private async fetchTxOrNull(url: string, txHash: string): Promise<XrplTxMethodResult | null> {
    const result = await callRippled<XrplTxMethodResult>(url, "tx", { transaction: txHash });
    if (result.status === "error") {
      if (result.error === "txnNotFound") return null;
      throw new ServiceUnavailableException(`XRPL tx lookup error: ${result.error}`);
    }
    return result;
  }
}
