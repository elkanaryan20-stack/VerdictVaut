import { AssetNetworkContext, WatchedAddress } from "../deposit-chain-adapter.interface";
import { parsePerAddressCursor, serializePerAddressCursor } from "../per-address-cursor.util";
import { ChainRpcConfigService } from "../rpc-config.service";
import { SolanaDepositAdapter } from "./solana-deposit-adapter";
import { SolanaSignatureInfo } from "./solana-rpc.types";

/**
 * Phase 11 finding: the pre-fix adapter always fetched only the single
 * most-recent page of signatures (25) per poll with a fabricated
 * (non-resumable) cursor — a burst of more than 25 transactions on one
 * watched address between two polls meant the oldest ones fell off the
 * page and were NEVER recorded, silently and permanently. These tests
 * cover the real per-address resume-cursor walk-back that replaces it.
 *
 * getTransaction is mocked to always return null (transaction not found)
 * so these tests can focus purely on the getSignaturesForAddress
 * pagination/cursor logic without needing valid transaction fixtures —
 * deposit-mapping correctness is covered by solana-tx.mapper.spec.ts.
 */
describe("SolanaDepositAdapter.scanForDeposits pagination/catch-up", () => {
  const watched: WatchedAddress = { walletAddressId: "wa-1", address: "SolWatchedAddr111111111111111111111111111", destinationTag: null };
  const network: AssetNetworkContext = {
    assetNetworkId: "an-1",
    assetSymbol: "SOL",
    assetDecimals: 9,
    networkFamily: "SOLANA" as never,
    networkCode: "solana-devnet",
    contractAddress: null,
    isNative: true,
    memoRequired: false,
  };

  let fetchMock: jest.SpyInstance;
  let adapter: SolanaDepositAdapter;

  function jsonRpcResponse(result: unknown) {
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as Response;
  }

  function page(prefix: string, count = 25): SolanaSignatureInfo[] {
    // Newest-first, matching getSignaturesForAddress's real ordering.
    return Array.from({ length: count }, (_, i) => ({ signature: `${prefix}-${count - i}` }));
  }

  /** Chains pages together by their real `before` continuation key (each page's oldest signature). */
  function buildChain(prefixes: { name: string; count?: number }[]): Map<string | undefined, SolanaSignatureInfo[]> {
    const chain = new Map<string | undefined, SolanaSignatureInfo[]>();
    let beforeKey: string | undefined;
    for (const { name, count } of prefixes) {
      const p = page(name, count);
      chain.set(beforeKey, p);
      beforeKey = p.length > 0 ? p[p.length - 1].signature : beforeKey;
    }
    return chain;
  }

  function installFetchMock(chain: Map<string | undefined, SolanaSignatureInfo[]>) {
    fetchMock.mockImplementation(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { method: string; params: unknown[] };
      if (body.method === "getSlot") return jsonRpcResponse(500);
      if (body.method === "getTransaction") return jsonRpcResponse(null);
      if (body.method === "getSignaturesForAddress") {
        const opts = body.params[1] as { before?: string };
        return jsonRpcResponse(chain.get(opts.before) ?? []);
      }
      throw new Error(`Unexpected RPC method in test: ${body.method}`);
    });
  }

  function signatureCallCount(): number {
    return fetchMock.mock.calls.filter(([, init]: [unknown, { body: string }]) => JSON.parse(init.body).method === "getSignaturesForAddress")
      .length;
  }

  beforeEach(() => {
    adapter = new SolanaDepositAdapter(new ChainRpcConfigService());
    fetchMock = jest.spyOn(global, "fetch" as never);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it("first-ever scan (no cursor) fetches exactly one page and records the newest signature as that address's cursor", async () => {
    installFetchMock(buildChain([{ name: "p1" }]));

    const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor: null });

    expect(signatureCallCount()).toBe(1);
    expect(parsePerAddressCursor(result.nextCursor)[watched.address]).toBe("p1-25");
  });

  it("stops after one page once the previous cursor is found in it", async () => {
    installFetchMock(buildChain([{ name: "p1" }]));
    const cursor = serializePerAddressCursor({ [watched.address]: "p1-20" });

    const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor });

    expect(signatureCallCount()).toBe(1);
    expect(parsePerAddressCursor(result.nextCursor)[watched.address]).toBe("p1-25");
  });

  it("walks backward via `before` when the previous cursor isn't in the first page, and stops once found", async () => {
    installFetchMock(buildChain([{ name: "p1" }, { name: "p2" }]));
    const cursor = serializePerAddressCursor({ [watched.address]: "p2-10" });

    const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor });

    expect(signatureCallCount()).toBe(2);
    expect(parsePerAddressCursor(result.nextCursor)[watched.address]).toBe("p1-25"); // advances to the true newest, not just where it caught up
  });

  it("never silently loses deposits: a backlog bigger than the page cap leaves the cursor UNCHANGED so the next poll resumes the same walk-back", async () => {
    installFetchMock(buildChain(Array.from({ length: 20 }, (_, i) => ({ name: `p${i}` })))); // 20 full pages (MAX_PAGES_PER_ADDRESS)
    const cursor = serializePerAddressCursor({ [watched.address]: "never-found" });

    const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor });

    expect(signatureCallCount()).toBe(20); // stops at the cap rather than scanning forever
    expect(parsePerAddressCursor(result.nextCursor)[watched.address]).toBe("never-found"); // NOT advanced past the unscanned gap
  });

  it("treats a short final page as proof history is exhausted, and safely advances even though the old cursor's signature is gone", async () => {
    installFetchMock(buildChain([{ name: "p1" }, { name: "p2", count: 5 }]));
    const cursor = serializePerAddressCursor({ [watched.address]: "dropped-sig" });

    const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor });

    expect(parsePerAddressCursor(result.nextCursor)[watched.address]).toBe("p1-25");
  });
});
