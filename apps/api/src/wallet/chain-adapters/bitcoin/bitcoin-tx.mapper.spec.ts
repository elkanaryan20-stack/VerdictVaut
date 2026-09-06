import { WatchedAddress } from "../deposit-chain-adapter.interface";
import { EsploraTx } from "./bitcoin-esplora.types";
import { mapEsploraTxToDeposits } from "./bitcoin-tx.mapper";

const watched: WatchedAddress = { walletAddressId: "wa-1", address: "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", destinationTag: null };

function tx(overrides: Partial<EsploraTx> = {}): EsploraTx {
  return {
    txid: "abc123",
    vout: [{ scriptpubkey_address: watched.address, value: 10000 }],
    status: { confirmed: true, block_height: 100 },
    ...overrides,
  };
}

describe("mapEsploraTxToDeposits", () => {
  it("maps a single matching output to one deposit with confirmations from tip height", () => {
    const deposits = mapEsploraTxToDeposits(tx(), watched, 105);
    expect(deposits).toEqual([
      expect.objectContaining({ walletAddressId: "wa-1", txHash: "abc123", eventIndex: 0, amount: "0.0001", confirmations: 6 }),
    ]);
  });

  it("ignores outputs paying a different address", () => {
    const deposits = mapEsploraTxToDeposits(
      tx({ vout: [{ scriptpubkey_address: "someone-else", value: 5000 }] }),
      watched,
      105,
    );
    expect(deposits).toHaveLength(0);
  });

  it("reports confirmations of 0 for an unconfirmed (mempool) transaction", () => {
    const deposits = mapEsploraTxToDeposits(tx({ status: { confirmed: false } }), watched, 105);
    expect(deposits[0].confirmations).toBe(0);
  });

  it("uses the vout index as eventIndex, distinguishing multiple outputs to the same address in one tx", () => {
    const deposits = mapEsploraTxToDeposits(
      tx({ vout: [{ scriptpubkey_address: watched.address, value: 1000 }, { scriptpubkey_address: watched.address, value: 2000 }] }),
      watched,
      105,
    );
    expect(deposits).toHaveLength(2);
    expect(deposits[0].eventIndex).toBe(0);
    expect(deposits[1].eventIndex).toBe(1);
  });

  it("never reports negative confirmations even if tip height data is stale/inconsistent", () => {
    const deposits = mapEsploraTxToDeposits(tx({ status: { confirmed: true, block_height: 200 } }), watched, 105);
    expect(deposits[0].confirmations).toBe(0);
  });
});
