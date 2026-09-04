import { BadRequestException } from "@nestjs/common";
import { createTestUser, depositAddressService, getAssetNetwork, prisma, provisionAddress } from "./helpers";

describe("Deposit address pool concurrency (real Postgres)", () => {
  it("assigns a distinct address to each of many concurrent users — no duplicates", async () => {
    const assetNetwork = await getAssetNetwork("ETH", "ethereum-sepolia");
    const poolSize = 10;
    const marker = `${Date.now()}-${Math.random()}`;
    await Promise.all(
      Array.from({ length: poolSize }, (_, i) => provisionAddress(assetNetwork.id, `0xPool${marker}-${i}`)),
    );

    const users = await Promise.all(Array.from({ length: poolSize }, () => createTestUser()));

    const assignments = await Promise.all(
      users.map((user) => depositAddressService.getOrAssign(user.id, "ETH", "ethereum-sepolia")),
    );

    const addressIds = assignments.map((a) => a.walletAddressId);
    expect(new Set(addressIds).size).toBe(poolSize); // every address used exactly once

    const walletAddresses = await prisma.walletAddress.findMany({ where: { id: { in: addressIds } } });
    expect(walletAddresses.every((w) => w.status === "ASSIGNED")).toBe(true);
  });

  it("pool exhaustion returns a deterministic error for the users who miss out, not a silent duplicate", async () => {
    const assetNetwork = await getAssetNetwork("SOL", "solana-devnet");
    const marker = `${Date.now()}-${Math.random()}`;
    const poolSize = 3;
    const requesterCount = 7;
    await Promise.all(
      Array.from({ length: poolSize }, (_, i) => provisionAddress(assetNetwork.id, `SolPool${marker}-${i}`)),
    );

    const users = await Promise.all(Array.from({ length: requesterCount }, () => createTestUser()));

    const results = await Promise.allSettled(
      users.map((user) => depositAddressService.getOrAssign(user.id, "SOL", "solana-devnet")),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ walletAddressId: string }>[];
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(poolSize);
    expect(rejected).toHaveLength(requesterCount - poolSize);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(BadRequestException);
    }

    const distinctAddresses = new Set(fulfilled.map((f) => f.value.walletAddressId));
    expect(distinctAddresses.size).toBe(poolSize); // no address handed to two winners
  });

  it("calling getOrAssign twice (even concurrently) for the same user returns the same stable assignment", async () => {
    const assetNetwork = await getAssetNetwork("XRP", "xrpl-testnet");
    const marker = `${Date.now()}-${Math.random()}`;
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => provisionAddress(assetNetwork.id, `rPool${marker}${i}`)),
    );

    const user = await createTestUser();

    const [first, second] = await Promise.all([
      depositAddressService.getOrAssign(user.id, "XRP", "xrpl-testnet"),
      depositAddressService.getOrAssign(user.id, "XRP", "xrpl-testnet"),
    ]);

    expect(first.walletAddressId).toBe(second.walletAddressId);

    const assignments = await prisma.depositAddressAssignment.findMany({
      where: { userId: user.id, assetId: assetNetwork.assetId, networkId: assetNetwork.networkId },
    });
    expect(assignments).toHaveLength(1); // exactly one assignment row, not two
  });
});
