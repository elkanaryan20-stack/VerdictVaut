import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { NetworkFamily } from "@prisma/client";
import {
  AssetNetworkContext,
  BlockchainDepositAdapter,
  InspectTransactionParams,
  RawChainDeposit,
  ScanForDepositsParams,
  ScanForDepositsResult,
} from "../deposit-chain-adapter.interface";
import { PerAddressCursor, parsePerAddressCursor, serializePerAddressCursor } from "../per-address-cursor.util";
import { ChainRpcConfigService } from "../rpc-config.service";
import { callRippled } from "./rippled-rpc.util";
import { mapXrplEntryToDeposit } from "./xrp-tx.mapper";
import { XrplAccountTxEntry, XrplAccountTxResult, XrplServerInfoResult, XrplTxMethodResult, toAccountTxEntry } from "./xrpl-rpc.types";

const RECENT_TX_LIMIT = 30;
// Bounds worst-case RPC calls per watched address per poll (Phase 11 fix —
// see per-address-cursor.util.ts and the Bitcoin adapter's matching
// comment for the full rationale: a scan that can't fully catch up within
// this cap simply leaves that address's cursor unchanged rather than
// advancing past unscanned history, so nothing is ever silently lost).
const MAX_PAGES_PER_ADDRESS = 20;

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
  private readonly logger = new Logger(XrpDepositAdapter.name);

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
    const previousCursors = parsePerAddressCursor(params.cursor);
    const nextCursors: PerAddressCursor = { ...previousCursors };

    const deposits: RawChainDeposit[] = [];
    for (const watched of params.addresses) {
      const previousLastSeenHash = previousCursors[watched.address] ?? null;
      const { entries, caughtUp } = await this.fetchAccountHistory(url, watched.address, previousLastSeenHash);

      for (const entry of entries) {
        const mapped = mapXrplEntryToDeposit(entry, watched, currentLedger, params.network.assetDecimals);
        if (mapped) deposits.push(mapped);
      }

      if (entries.length === 0) continue;
      if (caughtUp) {
        nextCursors[watched.address] = entries[0].tx.hash;
      } else {
        this.logger.warn(
          `XRP address ${watched.address} has more unscanned history than fits in ${MAX_PAGES_PER_ADDRESS} pages — cursor left unchanged, will resume next poll.`,
        );
      }
    }

    return { deposits, nextCursor: serializePerAddressCursor(nextCursors) };
  }

  /**
   * Fetches newest-first (rippled's `account_tx` default order), paginating
   * backward via the `marker` continuation token until either
   * `previousLastSeenHash` is found among the results (caughtUp) or
   * MAX_PAGES_PER_ADDRESS is reached — see the Bitcoin adapter's
   * fetchAddressHistory for the identical, fully-commented rationale.
   * A pre-provisioned address with no on-chain history yet (`actNotFound`)
   * is a normal, expected state, not a provider failure.
   */
  private async fetchAccountHistory(
    url: string,
    account: string,
    previousLastSeenHash: string | null,
  ): Promise<{ entries: XrplAccountTxEntry[]; caughtUp: boolean }> {
    const collected: XrplAccountTxEntry[] = [];
    let marker: unknown;
    let caughtUp = previousLastSeenHash == null;
    let pagesFetched = 0;

    do {
      const result = await callRippled<XrplAccountTxResult & { marker?: unknown }>(
        url,
        "account_tx",
        marker ? { account, limit: RECENT_TX_LIMIT, marker } : { account, limit: RECENT_TX_LIMIT },
      );

      if (result.status === "error") {
        if (result.error === "actNotFound") return { entries: collected, caughtUp: true };
        throw new ServiceUnavailableException(`XRPL account_tx error for ${account}: ${result.error}`);
      }

      collected.push(...result.transactions);
      pagesFetched += 1;
      caughtUp = result.transactions.some((entry) => entry.tx.hash === previousLastSeenHash);
      marker = result.marker;
    } while (!caughtUp && marker !== undefined && pagesFetched < MAX_PAGES_PER_ADDRESS);

    // No further `marker` proves there's no more history to walk back
    // through — the previous cursor's hash being absent then means it's
    // genuinely gone, not that the walk-back stopped early.
    const exhaustedAllHistory = marker === undefined;
    return { entries: collected, caughtUp: caughtUp || exhaustedAllHistory };
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
