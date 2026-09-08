import { PrismaService } from "../../../prisma/prisma.service";
import { ChainRpcConfigService } from "../../chain-adapters/rpc-config.service";
import { SolanaCustodyProvider } from "./solana-custody.provider";

/**
 * Requirement #12 ("verify transaction success"): a signature the RPC
 * has a status for is a real, final record — but `err` (Solana's failed-
 * transaction signal) is a DIFFERENT condition from "no such signature",
 * and must be reported distinctly rather than folded into "not_found".
 */
describe("SolanaCustodyProvider.getTransactionStatus", () => {
  const assetNetworkId = "an-1";
  let prisma: { assetNetwork: { findUnique: jest.Mock } };
  let fetchMock: jest.SpyInstance;
  let provider: SolanaCustodyProvider;

  function jsonRpcResponse(result: unknown) {
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as Response;
  }

  beforeEach(() => {
    prisma = {
      assetNetwork: {
        findUnique: jest.fn().mockResolvedValue({
          id: assetNetworkId,
          isNative: true,
          contractAddress: null,
          asset: { symbol: "SOL", decimals: 9 },
          network: { family: "SOLANA", code: "solana-devnet" },
        }),
      },
    };
    provider = new SolanaCustodyProvider(prisma as unknown as PrismaService, new ChainRpcConfigService());
    fetchMock = jest.spyOn(global, "fetch" as never);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it("reports 'failed' (never 'not_found') for a signature the RPC has a status for, but which carries an err", async () => {
    fetchMock.mockResolvedValueOnce(jsonRpcResponse({ value: [{ slot: 100, confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }] }));

    const status = await provider.getTransactionStatus("SIG1", assetNetworkId);

    expect(status.status).toBe("failed");
    expect(status.amount).toBe("0");
  });

  it("reports 'not_found' when the RPC has no status entry for the signature at all", async () => {
    fetchMock.mockResolvedValueOnce(jsonRpcResponse({ value: [null] }));
    const status = await provider.getTransactionStatus("SIG1", assetNetworkId);
    expect(status.status).toBe("not_found");
  });

  it("reports 'confirmed' for a successful, finalized signature", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRpcResponse({ value: [{ slot: 100, confirmationStatus: "finalized", err: null }] }))
      .mockResolvedValueOnce(jsonRpcResponse(110)) // getSlot
      .mockResolvedValueOnce(
        jsonRpcResponse({
          slot: 100,
          meta: { preBalances: [1000], postBalances: [2000] },
          transaction: { message: { accountKeys: ["addr1"] } },
        }),
      );

    const status = await provider.getTransactionStatus("SIG1", assetNetworkId);
    expect(status.status).toBe("confirmed");
  });
});
