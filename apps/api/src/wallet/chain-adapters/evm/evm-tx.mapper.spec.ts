import { WatchedAddress } from "../deposit-chain-adapter.interface";
import { addressToTopic, blockNumberToHex, ERC20_TRANSFER_TOPIC, EvmBlock, EvmLog } from "./evm-json-rpc.types";
import { mapNativeBlockToDeposits, mapTransferLogToDeposit } from "./evm-tx.mapper";

const watched: WatchedAddress = { walletAddressId: "wa-1", address: `0x${"1".repeat(39)}a`, destinationTag: null };

describe("mapNativeBlockToDeposits", () => {
  function block(overrides: Partial<EvmBlock> = {}): EvmBlock {
    return {
      number: blockNumberToHex(100),
      transactions: [{ hash: "0xhash1", to: watched.address, from: "0xsender", value: "0xde0b6b3a7640000", blockNumber: blockNumberToHex(100) }],
      ...overrides,
    };
  }

  it("maps a matching native transfer with confirmations derived from block depth", () => {
    const deposits = mapNativeBlockToDeposits(block(), [watched], 105, 18);
    expect(deposits).toEqual([
      expect.objectContaining({ walletAddressId: "wa-1", txHash: "0xhash1", eventIndex: 0, amount: "1", confirmations: 6 }),
    ]);
  });

  it("is case-insensitive when matching the recipient address", () => {
    const deposits = mapNativeBlockToDeposits(
      block({ transactions: [{ hash: "0xh", to: watched.address.toUpperCase(), from: "0xs", value: "0x1", blockNumber: blockNumberToHex(100) }] }),
      [watched],
      105,
      18,
    );
    expect(deposits).toHaveLength(1);
  });

  it("ignores transactions to a different address", () => {
    const deposits = mapNativeBlockToDeposits(
      block({ transactions: [{ hash: "0xh", to: "0xsomeoneelse", from: "0xs", value: "0x1", blockNumber: blockNumberToHex(100) }] }),
      [watched],
      105,
      18,
    );
    expect(deposits).toHaveLength(0);
  });

  it("ignores a zero-value transaction (e.g. a contract-call tx with no native transfer)", () => {
    const deposits = mapNativeBlockToDeposits(
      block({ transactions: [{ hash: "0xh", to: watched.address, from: "0xs", value: "0x0", blockNumber: blockNumberToHex(100) }] }),
      [watched],
      105,
      18,
    );
    expect(deposits).toHaveLength(0);
  });

  it("ignores contract-creation transactions (to: null)", () => {
    const deposits = mapNativeBlockToDeposits(
      block({ transactions: [{ hash: "0xh", to: null, from: "0xs", value: "0x1", blockNumber: blockNumberToHex(100) }] }),
      [watched],
      105,
      18,
    );
    expect(deposits).toHaveLength(0);
  });
});

describe("mapTransferLogToDeposit", () => {
  function log(overrides: Partial<EvmLog> = {}): EvmLog {
    return {
      address: "0xcontract",
      topics: [ERC20_TRANSFER_TOPIC, addressToTopic("0xsender"), addressToTopic(watched.address)],
      data: "0x0000000000000000000000000000000000000000000000000000000000989680", // 10_000_000 in hex
      blockNumber: blockNumberToHex(100),
      transactionHash: "0xhash1",
      logIndex: blockNumberToHex(3),
      ...overrides,
    };
  }

  it("maps a matching Transfer log using logIndex as eventIndex", () => {
    const deposit = mapTransferLogToDeposit(log(), [watched], 105, 6, "0xcontract");
    expect(deposit).toEqual(
      expect.objectContaining({ walletAddressId: "wa-1", txHash: "0xhash1", eventIndex: 3, amount: "10", confirmations: 6 }),
    );
  });

  it("returns null for a log addressed to a different recipient", () => {
    const deposit = mapTransferLogToDeposit(
      log({ topics: [ERC20_TRANSFER_TOPIC, addressToTopic("0xsender"), addressToTopic("0xsomeoneelse")] }),
      [watched],
      105,
      6,
      "0xcontract",
    );
    expect(deposit).toBeNull();
  });

  it("never treats a reorged-out (removed) log as a real observation", () => {
    const deposit = mapTransferLogToDeposit(log({ removed: true }), [watched], 105, 6, "0xcontract");
    expect(deposit).toBeNull();
  });

  it("returns null for a malformed log with too few topics", () => {
    const deposit = mapTransferLogToDeposit(log({ topics: [ERC20_TRANSFER_TOPIC] }), [watched], 105, 6, "0xcontract");
    expect(deposit).toBeNull();
  });

  it("distinguishes two transfers in the same transaction via distinct logIndex", () => {
    const first = mapTransferLogToDeposit(log({ logIndex: blockNumberToHex(1) }), [watched], 105, 6, "0xcontract");
    const second = mapTransferLogToDeposit(log({ logIndex: blockNumberToHex(2) }), [watched], 105, 6, "0xcontract");
    expect(first!.eventIndex).not.toBe(second!.eventIndex);
  });

  it("never credits a Transfer-shaped log from an unrelated (unexpected) contract — a fake token cannot become a USDC/USDT deposit", () => {
    // Any contract can emit a log with the exact same topic0 signature as
    // an ERC-20 Transfer — this is the check that stops that from being
    // mistaken for a real transfer of the configured asset.
    const deposit = mapTransferLogToDeposit(log({ address: "0xNotTheRealTokenContract" }), [watched], 105, 6, "0xcontract");
    expect(deposit).toBeNull();
  });

  it("matches the contract address case-insensitively", () => {
    const deposit = mapTransferLogToDeposit(log({ address: "0xCONTRACT" }), [watched], 105, 6, "0xcontract");
    expect(deposit).not.toBeNull();
  });
});
