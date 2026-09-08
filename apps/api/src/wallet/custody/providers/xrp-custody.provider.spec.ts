import { PrismaService } from "../../../prisma/prisma.service";
import { ChainRpcConfigService } from "../../chain-adapters/rpc-config.service";
import { XrpCustodyProvider } from "./xrp-custody.provider";

/**
 * Requirement #12 ("verify transaction success"): a transaction landing
 * in a validated (final) XRPL ledger is not the same as it succeeding —
 * `tec*`-class result codes are validated but did not deliver funds.
 * Mirrors xrp-tx.mapper.ts's own TransactionResult check, which already
 * existed on the deposit side.
 */
describe("XrpCustodyProvider.getTransactionStatus", () => {
  const assetNetworkId = "an-1";
  let prisma: { assetNetwork: { findUnique: jest.Mock } };
  let fetchMock: jest.SpyInstance;
  let provider: XrpCustodyProvider;

  function rippledResponse(result: unknown) {
    return { ok: true, status: 200, json: async () => ({ result }) } as Response;
  }

  beforeEach(() => {
    prisma = {
      assetNetwork: {
        findUnique: jest.fn().mockResolvedValue({
          id: assetNetworkId,
          isNative: true,
          contractAddress: null,
          asset: { symbol: "XRP", decimals: 6 },
          network: { family: "XRPL", code: "xrpl-testnet" },
        }),
      },
    };
    provider = new XrpCustodyProvider(prisma as unknown as PrismaService, new ChainRpcConfigService());
    fetchMock = jest.spyOn(global, "fetch" as never);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it("reports 'failed' (never 'confirmed') for a validated transaction whose TransactionResult is not tesSUCCESS", async () => {
    fetchMock.mockResolvedValueOnce(
      rippledResponse({
        TransactionType: "Payment",
        Destination: "rDest",
        Amount: "1000000",
        hash: "TXHASH1",
        ledger_index: 100,
        meta: { TransactionResult: "tecUNFUNDED_PAYMENT" },
        validated: true,
      }),
    );

    const status = await provider.getTransactionStatus("TXHASH1", assetNetworkId);

    expect(status.status).toBe("failed");
    expect(status.amount).toBe("0");
  });

  it("reports 'confirmed' with the real destination for a validated, successful payment", async () => {
    fetchMock
      .mockResolvedValueOnce(
        rippledResponse({
          TransactionType: "Payment",
          Destination: "rDest",
          Amount: "1000000",
          hash: "TXHASH1",
          ledger_index: 100,
          meta: { TransactionResult: "tesSUCCESS", delivered_amount: "1000000" },
          validated: true,
        }),
      )
      .mockResolvedValueOnce(rippledResponse({ info: { validated_ledger: { seq: 105 } } })); // server_info

    const status = await provider.getTransactionStatus("TXHASH1", assetNetworkId);

    expect(status.status).toBe("confirmed");
    expect(status.destinationAddress).toBe("rDest");
    expect(status.confirmations).toBe(6);
  });

  it("reports 'pending' (not yet validated) without checking TransactionResult", async () => {
    fetchMock.mockResolvedValueOnce(
      rippledResponse({
        TransactionType: "Payment",
        Destination: "rDest",
        Amount: "1000000",
        hash: "TXHASH1",
        ledger_index: 100,
        meta: { TransactionResult: "tesSUCCESS" },
        validated: false,
      }),
    );

    const status = await provider.getTransactionStatus("TXHASH1", assetNetworkId);
    expect(status.status).toBe("pending");
  });

  it("reports 'not_found' for txnNotFound", async () => {
    fetchMock.mockResolvedValueOnce(rippledResponse({ status: "error", error: "txnNotFound" }));
    const status = await provider.getTransactionStatus("TXHASH1", assetNetworkId);
    expect(status.status).toBe("not_found");
  });
});
