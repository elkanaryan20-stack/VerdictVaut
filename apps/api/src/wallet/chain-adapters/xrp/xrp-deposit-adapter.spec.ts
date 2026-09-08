import { AssetNetworkContext, WatchedAddress } from "../deposit-chain-adapter.interface";
import { parsePerAddressCursor, serializePerAddressCursor } from "../per-address-cursor.util";
import { ChainRpcConfigService } from "../rpc-config.service";
import { XrpDepositAdapter } from "./xrp-deposit-adapter";
import { XrplAccountTxEntry } from "./xrpl-rpc.types";

/**
 * Phase 11 finding: the pre-fix adapter always fetched only the single
 * most-recent page of an account's transaction history (30 entries) per
 * poll with a fabricated (non-resumable) cursor — a burst of more than 30
 * transactions on one watched address between two polls meant the oldest
 * ones fell off the page and were NEVER recorded, silently and
 * permanently. These tests cover the real per-address resume-cursor
 * `marker`-based walk-back that replaces it. Unlike Bitcoin/Solana,
 * rippled's own `marker` field (not page length) is the sole signal for
 * "more history exists", so pages here can be small — the adapter's
 * continuation logic doesn't depend on hitting a fixed page size.
 */
describe("XrpDepositAdapter.scanForDeposits pagination/catch-up", () => {
  const watched: WatchedAddress = { walletAddressId: "wa-1", address: "rWatchedAddr1111111111111111111", destinationTag: null };
  const network: AssetNetworkContext = {
    assetNetworkId: "an-1",
    assetSymbol: "XRP",
    assetDecimals: 6,
    networkFamily: "XRPL" as never,
    networkCode: "xrpl-testnet",
    contractAddress: null,
    isNative: true,
    memoRequired: false,
  };

  let fetchMock: jest.SpyInstance;
  let adapter: XrpDepositAdapter;

  function rippledResponse(result: unknown) {
    return { ok: true, status: 200, json: async () => ({ result }) } as Response;
  }

  function entry(hash: string): XrplAccountTxEntry {
    return {
      tx: { TransactionType: "Payment", Destination: watched.address, Amount: "1000000", hash, ledger_index: 100 },
      meta: { TransactionResult: "tesSUCCESS" },
      validated: true,
    };
  }

  function page(prefix: string, count = 3): XrplAccountTxEntry[] {
    // Newest-first, matching account_tx's default ordering.
    return Array.from({ length: count }, (_, i) => entry(`${prefix}-${count - i}`));
  }

  /** Chains pages by rippled's real `marker` continuation token. */
  function buildChain(
    specs: { name: string; count?: number; hasMore?: boolean }[],
  ): Map<string | undefined, { transactions: XrplAccountTxEntry[]; marker?: string }> {
    const chain = new Map<string | undefined, { transactions: XrplAccountTxEntry[]; marker?: string }>();
    let key: string | undefined;
    specs.forEach((spec, i) => {
      const nextMarker = (spec.hasMore ?? true) ? `marker-${i + 1}` : undefined;
      chain.set(key, { transactions: page(spec.name, spec.count), marker: nextMarker });
      key = nextMarker;
    });
    return chain;
  }

  function installFetchMock(chain: Map<string | undefined, { transactions: XrplAccountTxEntry[]; marker?: string }>) {
    fetchMock.mockImplementation(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { method: string; params: [Record<string, unknown>] };
      if (body.method === "server_info") return rippledResponse({ info: { validated_ledger: { seq: 500 } } });
      if (body.method === "account_tx") {
        const marker = body.params[0].marker as string | undefined;
        const page = chain.get(marker);
        if (!page) throw new Error(`Unexpected account_tx marker in test: ${String(marker)}`);
        return rippledResponse(page);
      }
      throw new Error(`Unexpected RPC method in test: ${body.method}`);
    });
  }

  function accountTxCallCount(): number {
    return fetchMock.mock.calls.filter(([, init]: [unknown, { body: string }]) => JSON.parse(init.body).method === "account_tx").length;
  }

  beforeEach(() => {
    adapter = new XrpDepositAdapter(new ChainRpcConfigService());
    fetchMock = jest.spyOn(global, "fetch" as never);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it("first-ever scan (no cursor) fetches exactly one page and records the newest hash as that address's cursor", async () => {
    installFetchMock(buildChain([{ name: "p1", hasMore: false }]));

    const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor: null });

    expect(accountTxCallCount()).toBe(1);
    expect(parsePerAddressCursor(result.nextCursor)[watched.address]).toBe("p1-3");
  });

  it("stops after one page once the previous cursor is found in it, even if a marker for more pages exists", async () => {
    installFetchMock(buildChain([{ name: "p1", hasMore: true }])); // marker present but must never be followed
    const cursor = serializePerAddressCursor({ [watched.address]: "p1-2" });

    const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor });

    expect(accountTxCallCount()).toBe(1);
    expect(parsePerAddressCursor(result.nextCursor)[watched.address]).toBe("p1-3");
  });

  it("walks backward via `marker` when the previous cursor isn't in the first page, and stops once found", async () => {
    installFetchMock(buildChain([{ name: "p1" }, { name: "p2", hasMore: false }]));
    const cursor = serializePerAddressCursor({ [watched.address]: "p2-2" });

    const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor });

    expect(accountTxCallCount()).toBe(2);
    expect(parsePerAddressCursor(result.nextCursor)[watched.address]).toBe("p1-3"); // advances to the true newest, not just where it caught up
  });

  it("never silently loses deposits: a backlog bigger than the page cap leaves the cursor UNCHANGED so the next poll resumes the same walk-back", async () => {
    installFetchMock(buildChain(Array.from({ length: 20 }, (_, i) => ({ name: `p${i}`, hasMore: true })))); // 20 pages (MAX_PAGES_PER_ADDRESS), still more after
    const cursor = serializePerAddressCursor({ [watched.address]: "never-found" });

    const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor });

    expect(accountTxCallCount()).toBe(20); // stops at the cap rather than following `marker` forever
    expect(parsePerAddressCursor(result.nextCursor)[watched.address]).toBe("never-found"); // NOT advanced past the unscanned gap
  });

  it("treats an absent `marker` as proof history is exhausted, and safely advances even though the old cursor's hash is gone", async () => {
    installFetchMock(buildChain([{ name: "p1" }, { name: "p2", hasMore: false }]));
    const cursor = serializePerAddressCursor({ [watched.address]: "dropped-hash" });

    const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor });

    expect(parsePerAddressCursor(result.nextCursor)[watched.address]).toBe("p1-3");
  });

  it("an actNotFound account (never received anything on-chain) is treated as normal, not a failure", async () => {
    fetchMock.mockImplementation(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { method: string };
      if (body.method === "server_info") return rippledResponse({ info: { validated_ledger: { seq: 500 } } });
      if (body.method === "account_tx") return rippledResponse({ status: "error", error: "actNotFound" });
      throw new Error(`Unexpected RPC method in test: ${body.method}`);
    });

    const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor: null });

    expect(result.deposits).toHaveLength(0);
  });
});
