import { PrismaService } from "../../../prisma/prisma.service";
import { ChainRpcConfigService } from "../../chain-adapters/rpc-config.service";
import { blockNumberToHex, ERC20_TRANSFER_TOPIC } from "../../chain-adapters/evm/evm-json-rpc.types";
import { EvmCustodyProvider } from "./evm-custody.provider";

/**
 * Requirement #12 ("verify transaction success") / adversarial test case
 * #9 ("EVM transaction reverted"): a mined transaction is NOT the same
 * as a successful one — these tests cover the receipt-status check that
 * distinguishes them for withdrawal confirmation, mirroring the same
 * check EvmDepositAdapter already had on the deposit side.
 */
describe("EvmCustodyProvider.getTransactionStatus", () => {
  const assetNetworkId = "an-1";
  let prisma: { assetNetwork: { findUnique: jest.Mock } };
  let fetchMock: jest.SpyInstance;
  let provider: EvmCustodyProvider;

  function jsonResponse(result: unknown) {
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as Response;
  }

  beforeEach(() => {
    prisma = {
      assetNetwork: {
        findUnique: jest.fn().mockResolvedValue({
          id: assetNetworkId,
          isNative: true,
          contractAddress: null,
          asset: { symbol: "ETH", decimals: 18 },
          network: { family: "EVM", code: "ethereum-sepolia" },
        }),
      },
    };
    provider = new EvmCustodyProvider(prisma as unknown as PrismaService, new ChainRpcConfigService());
    fetchMock = jest.spyOn(global, "fetch" as never);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it("reports 'failed' (never 'confirmed') for a mined native transfer whose receipt actually reverted", async () => {
    const tx = { hash: "0xabc", to: "0xdest", from: "0xsender", value: "0xde0b6b3a7640000", blockNumber: blockNumberToHex(100) };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(tx)) // eth_getTransactionByHash
      .mockResolvedValueOnce(jsonResponse(blockNumberToHex(110))) // eth_blockNumber
      .mockResolvedValueOnce(jsonResponse({ status: "0x0", blockNumber: blockNumberToHex(100), logs: [] })); // eth_getTransactionReceipt — reverted

    const status = await provider.getTransactionStatus("0xabc", assetNetworkId);

    expect(status.status).toBe("failed");
    expect(status.amount).toBe("0");
  });

  it("reports 'confirmed' with the real destination for a mined native transfer whose receipt succeeded", async () => {
    const tx = { hash: "0xabc", to: "0xdest", from: "0xsender", value: "0xde0b6b3a7640000", blockNumber: blockNumberToHex(100) };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(tx))
      .mockResolvedValueOnce(jsonResponse(blockNumberToHex(110)))
      .mockResolvedValueOnce(jsonResponse({ status: "0x1", blockNumber: blockNumberToHex(100), logs: [] }));

    const status = await provider.getTransactionStatus("0xabc", assetNetworkId);

    expect(status.status).toBe("confirmed");
    expect(status.destinationAddress).toBe("0xdest");
  });

  it("reports 'failed' for a reverted ERC-20 transfer even though the transaction itself was mined", async () => {
    prisma.assetNetwork.findUnique.mockResolvedValue({
      id: assetNetworkId,
      isNative: false,
      contractAddress: "0xcontract",
      asset: { symbol: "USDC", decimals: 6 },
      network: { family: "EVM", code: "ethereum-sepolia" },
    });
    const tx = { hash: "0xabc", to: "0xcontract", from: "0xsender", value: "0x0", blockNumber: blockNumberToHex(100) };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(tx))
      .mockResolvedValueOnce(jsonResponse(blockNumberToHex(110)))
      .mockResolvedValueOnce(jsonResponse({ status: "0x0", blockNumber: blockNumberToHex(100), logs: [] })); // reverted — no logs

    const status = await provider.getTransactionStatus("0xabc", assetNetworkId);
    expect(status.status).toBe("failed");
  });

  it("reports the real ERC-20 recipient as destinationAddress for a successful transfer", async () => {
    prisma.assetNetwork.findUnique.mockResolvedValue({
      id: assetNetworkId,
      isNative: false,
      contractAddress: "0xcontract",
      asset: { symbol: "USDC", decimals: 6 },
      network: { family: "EVM", code: "ethereum-sepolia" },
    });
    const recipient = `0x${"b".repeat(40)}`;
    const toTopic = `0x${"0".repeat(24)}${"b".repeat(40)}`;
    const tx = { hash: "0xabc", to: "0xcontract", from: "0xsender", value: "0x0", blockNumber: blockNumberToHex(100) };
    const log = {
      address: "0xcontract",
      topics: [ERC20_TRANSFER_TOPIC, `0x${"0".repeat(24)}${"a".repeat(40)}`, toTopic],
      data: "0x00000000000000000000000000000000000000000000000000000005f5e100",
      blockNumber: blockNumberToHex(100),
      transactionHash: "0xabc",
      logIndex: "0x0",
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(tx))
      .mockResolvedValueOnce(jsonResponse(blockNumberToHex(110)))
      .mockResolvedValueOnce(jsonResponse({ status: "0x1", blockNumber: blockNumberToHex(100), logs: [log] }));

    const status = await provider.getTransactionStatus("0xabc", assetNetworkId);

    expect(status.status).toBe("confirmed");
    expect(status.destinationAddress).toBe(recipient);
  });

  it("reports 'not_found' for a transaction the provider has no record of at all", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(null)); // eth_getTransactionByHash -> null
    const status = await provider.getTransactionStatus("0xmissing", assetNetworkId);
    expect(status.status).toBe("not_found");
  });
});
