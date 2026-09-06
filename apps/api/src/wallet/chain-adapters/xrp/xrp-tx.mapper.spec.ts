import { WatchedAddress } from "../deposit-chain-adapter.interface";
import { mapXrplEntryToDeposit } from "./xrp-tx.mapper";
import { XrplAccountTxEntry } from "./xrpl-rpc.types";

const watched: WatchedAddress = { walletAddressId: "wa-1", address: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", destinationTag: "12345" };

function entry(overrides: Partial<XrplAccountTxEntry> = {}): XrplAccountTxEntry {
  return {
    tx: {
      TransactionType: "Payment",
      Destination: watched.address,
      Amount: "1000000",
      DestinationTag: 12345,
      hash: "HASH1",
      ledger_index: 1000,
    },
    meta: { TransactionResult: "tesSUCCESS", delivered_amount: "1000000" },
    validated: true,
    ...overrides,
  };
}

describe("mapXrplEntryToDeposit", () => {
  it("maps a validated Payment to a deposit with the destination tag preserved", () => {
    const deposit = mapXrplEntryToDeposit(entry(), watched, 1010, 6);
    expect(deposit).toEqual(
      expect.objectContaining({ walletAddressId: "wa-1", txHash: "HASH1", eventIndex: 0, amount: "1", confirmations: 11, destinationTag: "12345" }),
    );
  });

  it("prefers meta.delivered_amount over tx.Amount (partial-payment safety)", () => {
    const deposit = mapXrplEntryToDeposit(
      entry({ tx: { ...entry().tx, Amount: "1000000" }, meta: { TransactionResult: "tesSUCCESS", delivered_amount: "400000" } }),
      watched,
      1010,
      6,
    );
    expect(deposit!.amount).toBe("0.4");
  });

  it("reports zero confirmations for a not-yet-validated transaction", () => {
    const deposit = mapXrplEntryToDeposit(entry({ validated: false }), watched, 1010, 6);
    expect(deposit!.confirmations).toBe(0);
  });

  it("returns null for a non-Payment transaction type", () => {
    const deposit = mapXrplEntryToDeposit(entry({ tx: { ...entry().tx, TransactionType: "TrustSet" } }), watched, 1010, 6);
    expect(deposit).toBeNull();
  });

  it("returns null for a failed payment", () => {
    const deposit = mapXrplEntryToDeposit(entry({ meta: { TransactionResult: "tecPATH_PARTIAL" } }), watched, 1010, 6);
    expect(deposit).toBeNull();
  });

  it("returns null when the destination does not match the watched address", () => {
    const deposit = mapXrplEntryToDeposit(entry({ tx: { ...entry().tx, Destination: "rSomeoneElse111111111111111111111" } }), watched, 1010, 6);
    expect(deposit).toBeNull();
  });

  it("returns null for an issued-currency (non-native-XRP) payment", () => {
    const deposit = mapXrplEntryToDeposit(
      entry({ meta: { TransactionResult: "tesSUCCESS", delivered_amount: { currency: "USD", issuer: "rIssuer", value: "10" } } }),
      watched,
      1010,
      6,
    );
    expect(deposit).toBeNull();
  });

  it("omits destinationTag when the transaction did not carry one — never fabricates it", () => {
    const deposit = mapXrplEntryToDeposit(entry({ tx: { ...entry().tx, DestinationTag: undefined } }), watched, 1010, 6);
    expect(deposit!.destinationTag).toBeUndefined();
  });

  it("always uses eventIndex 0 — a native XRP Payment has exactly one destination", () => {
    const deposit = mapXrplEntryToDeposit(entry(), watched, 1010, 6);
    expect(deposit!.eventIndex).toBe(0);
  });
});
