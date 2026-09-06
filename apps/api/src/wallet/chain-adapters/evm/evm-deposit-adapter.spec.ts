import { AssetNetworkContext, WatchedAddress } from "../deposit-chain-adapter.interface";
import { ChainRpcConfigService } from "../rpc-config.service";
import { blockNumberToHex } from "./evm-json-rpc.types";
import { EvmDepositAdapter } from "./evm-deposit-adapter";

/**
 * Adapter-level tests (mocked fetch, no real network) covering behavior
 * that lives in the I/O layer rather than the pure mappers:
 *  - the receipt-status confirmation that stops a reverted transaction
 *    from being fabricated into a native-ETH deposit
 *  - the reorg-safety margin that stops the cursor from permanently
 *    skipping a chain-tip block a shallow reorg could still rewrite
 */
describe("EvmDepositAdapter.scanForDeposits (native)", () => {
  const watched: WatchedAddress = { walletAddressId: "wa-1", address: `0x${"1".repeat(39)}a`, destinationTag: null };
  const network: AssetNetworkContext = {
    assetNetworkId: "an-1",
    assetSymbol: "ETH",
    assetDecimals: 18,
    networkFamily: "EVM" as never,
    networkCode: "ethereum-sepolia",
    contractAddress: null,
    isNative: true,
    memoRequired: false,
  };

  let fetchMock: jest.SpyInstance;
  let adapter: EvmDepositAdapter;

  function jsonResponse(result: unknown) {
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as Response;
  }

  beforeEach(() => {
    adapter = new EvmDepositAdapter(new ChainRpcConfigService());
    fetchMock = jest.spyOn(global, "fetch" as never);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  // Tip (112) minus the reorg-safety margin (12) lands exactly on the
  // transaction's own block (100), which is also the first unscanned
  // block after cursor 99 — so the scan range is exactly [100, 100] and
  // these tests exercise the receipt-status check in isolation, not the
  // margin itself (see the "reorg-safety margin" tests below for that).
  function queueScan(receiptStatus: string) {
    const tx = { hash: "0xhash1", to: watched.address, from: "0xsender", value: "0xde0b6b3a7640000", blockNumber: blockNumberToHex(100) };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(blockNumberToHex(112))) // eth_blockNumber (scanForDeposits)
      .mockResolvedValueOnce(jsonResponse({ number: blockNumberToHex(100), transactions: [tx] })) // eth_getBlockByNumber
      .mockResolvedValueOnce(jsonResponse({ status: receiptStatus, blockNumber: blockNumberToHex(100), logs: [] })); // eth_getTransactionReceipt
  }

  it("excludes a candidate whose transaction actually reverted (receipt.status !== 0x1)", async () => {
    queueScan("0x0");
    const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor: "99" });
    expect(result.deposits).toHaveLength(0);
  });

  it("includes a candidate whose transaction succeeded (receipt.status === 0x1)", async () => {
    queueScan("0x1");
    const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor: "99" });
    expect(result.deposits).toEqual([expect.objectContaining({ walletAddressId: "wa-1", txHash: "0xhash1", amount: "1" })]);
  });

  describe("reorg-safety margin on cursor advancement", () => {
    it("never advances the cursor into the last 12 blocks below the chain tip", async () => {
      // Tip is only 5 blocks ahead of the cursor — entirely within the
      // margin, so nothing should be scanned or advanced yet.
      fetchMock.mockResolvedValueOnce(jsonResponse(blockNumberToHex(104)));
      const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor: "99" });

      expect(result.deposits).toHaveLength(0);
      expect(result.nextCursor).toBe("99"); // unchanged — must retry this same range next poll
      expect(fetchMock).toHaveBeenCalledTimes(1); // only eth_blockNumber — never even attempted eth_getBlockByNumber
    });

    it("only advances the cursor up to (tip - margin), never to the tip itself", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(blockNumberToHex(120))) // tip
        .mockResolvedValueOnce(jsonResponse({ number: blockNumberToHex(100), transactions: [] }))
        .mockResolvedValue(jsonResponse({ number: blockNumberToHex(999), transactions: [] })); // remaining blocks in range, no transactions

      const result = await adapter.scanForDeposits({ network, addresses: [watched], cursor: "99" });

      expect(result.nextCursor).toBe("108"); // 120 - 12, never "120"
    });
  });
});
