import { WatchedAddress } from "../deposit-chain-adapter.interface";
import { SolanaTransaction } from "./solana-rpc.types";
import { mapNativeSolTransactionToDeposits, mapSplTokenTransactionToDeposits } from "./solana-tx.mapper";

const watched: WatchedAddress = { walletAddressId: "wa-1", address: "RecipientAddr11111111111111111111111111111", destinationTag: null };
const sender = "SenderAddr111111111111111111111111111111111";

describe("mapNativeSolTransactionToDeposits", () => {
  function tx(overrides: Partial<SolanaTransaction> = {}): SolanaTransaction {
    return {
      slot: 100,
      transaction: { message: { accountKeys: [sender, watched.address] } },
      meta: { err: null, preBalances: [5_000_000_000, 1_000_000_000], postBalances: [3_999_995_000, 2_000_000_000] },
      ...overrides,
    };
  }

  it("maps a positive balance delta on a watched account using its accountKeys index as eventIndex", () => {
    const deposits = mapNativeSolTransactionToDeposits("sig1", tx(), [watched], 132, 9);
    expect(deposits).toEqual([
      expect.objectContaining({ walletAddressId: "wa-1", txHash: "sig1", eventIndex: 1, amount: "1", confirmations: 32 }),
    ]);
  });

  it("ignores a negative delta (the sender/fee-payer side)", () => {
    const deposits = mapNativeSolTransactionToDeposits(
      "sig1",
      tx({ transaction: { message: { accountKeys: [sender] } }, meta: { err: null, preBalances: [5_000_000_000], postBalances: [3_999_995_000] } }),
      [{ ...watched, address: sender }],
      132,
      9,
    );
    expect(deposits).toHaveLength(0);
  });

  it("returns nothing for a failed transaction", () => {
    const deposits = mapNativeSolTransactionToDeposits("sig1", tx({ meta: { err: { InstructionError: [] }, preBalances: [0, 0], postBalances: [0, 0] } }), [watched], 132, 9);
    expect(deposits).toHaveLength(0);
  });

  it("uses exact case-sensitive base58 matching (never lowercases a Solana address)", () => {
    const deposits = mapNativeSolTransactionToDeposits("sig1", tx(), [{ ...watched, address: watched.address.toLowerCase() }], 132, 9);
    expect(deposits).toHaveLength(0);
  });

  describe("v0 transactions using an Address Lookup Table", () => {
    // A watched account resolved via an ALT never appears in
    // transaction.message.accountKeys — only in meta.loadedAddresses —
    // yet preBalances/postBalances ARE indexed against the combined
    // list [message.accountKeys, ...loadedAddresses.writable,
    // ...loadedAddresses.readonly]. A mapper that only looked at
    // message.accountKeys would silently miss this deposit entirely.
    function altTx(): SolanaTransaction {
      return {
        slot: 100,
        transaction: { message: { accountKeys: [sender] } }, // watched.address is NOT here
        meta: {
          err: null,
          preBalances: [5_000_000_000, 1_000_000_000],
          postBalances: [3_999_995_000, 2_000_000_000],
          loadedAddresses: { writable: [watched.address], readonly: [] },
        },
      };
    }

    it("still detects a deposit landing on an ALT-resolved (loadedAddresses.writable) account", () => {
      const deposits = mapNativeSolTransactionToDeposits("sig1", altTx(), [watched], 132, 9);
      expect(deposits).toEqual([expect.objectContaining({ walletAddressId: "wa-1", eventIndex: 1, amount: "1" })]);
    });

    it("places a readonly-loaded address after writable-loaded ones in the combined index space", () => {
      const t = altTx();
      t.transaction.message.accountKeys = [sender, "OtherWritable1111111111111111111111111111"];
      t.meta = {
        err: null,
        preBalances: [5_000_000_000, 1_000_000_000, 1_000_000_000],
        postBalances: [3_999_995_000, 1_000_000_000, 2_000_000_000],
        loadedAddresses: { writable: [], readonly: [watched.address] },
      };
      const deposits = mapNativeSolTransactionToDeposits("sig1", t, [watched], 132, 9);
      expect(deposits).toEqual([expect.objectContaining({ walletAddressId: "wa-1", eventIndex: 2, amount: "1" })]);
    });

    it("behaves exactly as before (no loadedAddresses) for a legacy transaction", () => {
      const deposits = mapNativeSolTransactionToDeposits("sig1", tx(), [watched], 132, 9);
      expect(deposits).toEqual([expect.objectContaining({ eventIndex: 1 })]);
    });
  });
});

describe("mapSplTokenTransactionToDeposits", () => {
  const mint = "MintAddress1111111111111111111111111111111";

  function tx(): SolanaTransaction {
    return {
      slot: 100,
      transaction: { message: { accountKeys: [sender, watched.address] } },
      meta: {
        err: null,
        preBalances: [],
        postBalances: [],
        preTokenBalances: [{ accountIndex: 1, mint, uiTokenAmount: { amount: "1000000", decimals: 6 } }],
        postTokenBalances: [{ accountIndex: 1, mint, uiTokenAmount: { amount: "1500000", decimals: 6 } }],
      },
    };
  }

  it("maps a positive token-balance delta for the tracked mint using accountIndex as eventIndex", () => {
    const deposits = mapSplTokenTransactionToDeposits("sig1", tx(), [watched], 132, mint, 6);
    expect(deposits).toEqual([expect.objectContaining({ walletAddressId: "wa-1", eventIndex: 1, amount: "0.5" })]);
  });

  it("ignores a balance entry for a different mint", () => {
    const deposits = mapSplTokenTransactionToDeposits("sig1", tx(), [watched], 132, "SomeOtherMint111111111111111111111111111", 6);
    expect(deposits).toHaveLength(0);
  });

  it("treats a token account with no prior balance as a full-amount deposit", () => {
    const t = tx();
    t.meta!.preTokenBalances = [];
    const deposits = mapSplTokenTransactionToDeposits("sig1", t, [watched], 132, mint, 6);
    expect(deposits[0].amount).toBe("1.5");
  });

  it("still resolves and detects a deposit whose token account was resolved via an Address Lookup Table", () => {
    const t: SolanaTransaction = {
      slot: 100,
      transaction: { message: { accountKeys: [sender] } }, // the ATA is NOT here
      meta: {
        err: null,
        preBalances: [],
        postBalances: [],
        preTokenBalances: [{ accountIndex: 1, mint, uiTokenAmount: { amount: "1000000", decimals: 6 } }],
        postTokenBalances: [{ accountIndex: 1, mint, uiTokenAmount: { amount: "1500000", decimals: 6 } }],
        loadedAddresses: { writable: [watched.address], readonly: [] },
      },
    };
    const deposits = mapSplTokenTransactionToDeposits("sig1", t, [watched], 132, mint, 6);
    expect(deposits).toEqual([expect.objectContaining({ walletAddressId: "wa-1", eventIndex: 1, amount: "0.5" })]);
  });
});
