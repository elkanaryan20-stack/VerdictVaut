import { AssetNetworkContext, WatchedAddress } from "../deposit-chain-adapter.interface";
import { parsePerAddressCursor, serializePerAddressCursor } from "../per-address-cursor.util";
import { ChainRpcConfigService } from "../rpc-config.service";
import { BitcoinDepositAdapter } from "./bitcoin-deposit-adapter";
import { EsploraTx } from "./bitcoin-esplora.types";

/**
 * Phase 11 finding: the pre-fix adapter always fetched only Esplora's
 * single most-recent page (25 txs) per poll with a fabricated
 * (non-resumable) cursor — a burst of more than 25 transactions on one
 * watched address between two polls meant the oldest ones fell off the
 * page and were NEVER recorded, silently and permanently. These tests
 * cover the real per-address resume-cursor walk-back that replaces it.
 */
describe("BitcoinDepositAdapter.scanForDeposits pagination/catch-up", () => {
  const watched: WatchedAddress = { walletAddressId: "wa-1", address: "tb1qwatched", destinationTag: null };
  const network: AssetNetworkContext = {
    assetNetworkId: "an-1",
    assetSymbol: "BTC",
    assetDecimals: 8,
    networkFamily: "BITCOIN" as never,
    networkCode: "bitcoin-testnet",
    contractAddress: null,
    isNative: true,
    memoRequired: false,
  };

  let fetchMock: jest.SpyInstance;
  let adapter: BitcoinDepositAdapter;

  function jsonResponse(body: unknown) {
    return { ok: true, status: 200, json: async () => body } as Response;
  }

  function tx(txid: string): EsploraTx {
    return { txid, vout: [{ scriptpubkey_address: watched.address, value: 100000 }], status: { confirmed: true, block_height: 100 } };
  }

  function page(prefix: string, count = 25): EsploraTx[] {
    // Newest-first, matching Esplora's real ordering: index 0 is newest.
    return Array.from({ length: count }, (_, i) => tx(`${prefix}-${count - i}`));
  }

  beforeEach(() => {
    adapter = new BitcoinDepositAdapter(new ChainRpcConfigService());
    fetchMock = jest.spyOn(global, "fetch" as never);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it("first-ever scan (no cursor) fetches exactly one page and records the newest txid as that address's cursor", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(150)).mockResolvedValueOnce(jsonResponse(page("p1")));

    const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor: null });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(parsePerAddressCursor(result.nextCursor)[watched.address]).toBe("p1-25");
  });

  it("stops after one page once the previous cursor is found in it", async () => {
    const cursor = serializePerAddressCursor({ [watched.address]: "p1-20" });
    fetchMock.mockResolvedValueOnce(jsonResponse(150)).mockResolvedValueOnce(jsonResponse(page("p1")));

    const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor });

    expect(fetchMock).toHaveBeenCalledTimes(2); // tip + one page — no /txs/chain/ continuation needed
    expect(parsePerAddressCursor(result.nextCursor)[watched.address]).toBe("p1-25");
  });

  it("walks backward via /txs/chain/:txid when the previous cursor isn't in the first page, and stops once found", async () => {
    const cursor = serializePerAddressCursor({ [watched.address]: "p2-10" });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(150))
      .mockResolvedValueOnce(jsonResponse(page("p1"))) // full page, does not contain p2-10
      .mockResolvedValueOnce(jsonResponse(page("p2"))); // continuation page, contains p2-10

    const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toContain("/txs/chain/p1-1"); // continues from page 1's oldest txid
    expect(parsePerAddressCursor(result.nextCursor)[watched.address]).toBe("p1-25"); // advances to the true newest, not just where it caught up
  });

  it("never silently loses deposits: a backlog bigger than the page cap leaves the cursor UNCHANGED so the next poll resumes the same walk-back", async () => {
    const cursor = serializePerAddressCursor({ [watched.address]: "never-found" });
    fetchMock.mockResolvedValueOnce(jsonResponse(150));
    for (let i = 0; i < 20; i += 1) {
      fetchMock.mockResolvedValueOnce(jsonResponse(page(`p${i}`))); // 20 full pages (MAX_PAGES_PER_ADDRESS), cursor never found
    }

    const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor });

    expect(fetchMock).toHaveBeenCalledTimes(21); // tip + 20 pages, then it stops rather than scanning forever
    expect(parsePerAddressCursor(result.nextCursor)[watched.address]).toBe("never-found"); // NOT advanced past the unscanned gap
  });

  it("treats a short final page as proof history is exhausted, and safely advances even though the old cursor's txid is gone", async () => {
    const cursor = serializePerAddressCursor({ [watched.address]: "dropped-tx" });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(150))
      .mockResolvedValueOnce(jsonResponse(page("p1"))) // full page, no match
      .mockResolvedValueOnce(jsonResponse(page("p2", 5))); // short final page (end of history), no match

    const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor });

    expect(parsePerAddressCursor(result.nextCursor)[watched.address]).toBe("p1-25");
  });

  it("a pre-Phase-11 cursor (bare ISO timestamp, not JSON) is treated as no history yet rather than crashing the scan", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(150)).mockResolvedValueOnce(jsonResponse(page("p1")));

    const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor: "2026-01-01T00:00:00.000Z" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(parsePerAddressCursor(result.nextCursor)[watched.address]).toBe("p1-25");
  });
});
