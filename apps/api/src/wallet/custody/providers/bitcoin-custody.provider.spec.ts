import { PrismaService } from "../../../prisma/prisma.service";
import { ChainRpcConfigService } from "../../chain-adapters/rpc-config.service";
import { BitcoinCustodyProvider } from "./bitcoin-custody.provider";

/**
 * Phase 34: a real Bitcoin withdrawal almost always pays a change output
 * back to the sending wallet, so the transaction-wide total (`amount`)
 * can never be compared against a withdrawal's own amount. The per-output
 * breakdown is what WithdrawalsService's confirmation check uses instead.
 * No network access — fetch is mocked with Esplora-shaped responses.
 */
describe("BitcoinCustodyProvider.getTransactionStatus", () => {
  const assetNetworkId = "an-btc";
  let prisma: { assetNetwork: { findUnique: jest.Mock } };
  let fetchMock: jest.SpyInstance;
  let provider: BitcoinCustodyProvider;

  function esploraResponse(body: unknown) {
    return { ok: true, status: 200, json: async () => body } as Response;
  }

  beforeEach(() => {
    prisma = {
      assetNetwork: {
        findUnique: jest.fn().mockResolvedValue({
          id: assetNetworkId,
          isNative: true,
          contractAddress: null,
          asset: { symbol: "BTC", decimals: 8 },
          network: { family: "BITCOIN", code: "bitcoin-testnet" },
        }),
      },
    };
    provider = new BitcoinCustodyProvider(prisma as unknown as PrismaService, new ChainRpcConfigService());
    fetchMock = jest.spyOn(global, "fetch" as never);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it("reports each addressed output separately, alongside the transaction-wide total, and skips address-less outputs", async () => {
    fetchMock
      .mockResolvedValueOnce(
        esploraResponse({
          vout: [
            { value: 50_000_000, scriptpubkey_address: "tb1qrecipient" },
            { value: 120_000_000, scriptpubkey_address: "tb1qchange" },
            { value: 0 }, // OP_RETURN — no address
          ],
          status: { confirmed: true, block_height: 100 },
        }),
      )
      .mockResolvedValueOnce(esploraResponse(105));

    const status = await provider.getTransactionStatus("txid", assetNetworkId);

    expect(status.status).toBe("confirmed");
    expect(status.confirmations).toBe(6);
    expect(status.amount).toBe("1.7");
    expect(status.outputs).toEqual([
      { address: "tb1qrecipient", amount: "0.5" },
      { address: "tb1qchange", amount: "1.2" },
    ]);
  });

  it("includes the per-output breakdown for a still-unconfirmed transaction too", async () => {
    fetchMock.mockResolvedValueOnce(
      esploraResponse({ vout: [{ value: 1_000, scriptpubkey_address: "tb1qrecipient" }], status: { confirmed: false } }),
    );

    const status = await provider.getTransactionStatus("txid", assetNetworkId);

    expect(status.status).toBe("pending");
    expect(status.outputs).toEqual([{ address: "tb1qrecipient", amount: "0.00001" }]);
  });
});
