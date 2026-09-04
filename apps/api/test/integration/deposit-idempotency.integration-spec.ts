import { createTestUser, depositsService, getAsset, getAssetNetwork, getUserAccount, prisma, provisionAddress } from "./helpers";

async function auditLogsFor(resourceId: string) {
  return prisma.auditLog.findMany({ where: { resourceType: "Deposit", resourceId } });
}

describe("Deposit idempotency (real Postgres)", () => {
  it("credits exactly once under concurrent duplicate observations of the same on-chain transaction", async () => {
    const user = await createTestUser();
    const assetNetwork = await getAssetNetwork("USDC", "ethereum-sepolia");
    const address = await provisionAddress(assetNetwork.id, `0xConcurrent${Date.now()}${Math.random()}`);
    const txHash = `0xduplicate-${Date.now()}-${Math.random()}`;

    const input = {
      userId: user.id,
      assetSymbol: "USDC",
      assetNetworkId: assetNetwork.id,
      walletAddressId: address.id,
      txHash,
      amount: "100",
      confirmations: 20,
      requiredConfirmations: 12,
    };

    // Simulate duplicate watcher runs / redelivered webhooks / retries all
    // observing the exact same on-chain transaction "at once".
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => depositsService.recordObservedTransaction(input)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(8);

    const deposits = await prisma.deposit.findMany({ where: { assetNetworkId: assetNetwork.id, txHash } });
    expect(deposits).toHaveLength(1);
    expect(deposits[0].status).toBe("CREDITED");

    const account = await getUserAccount(user.id, "USDC");
    expect(account?.cachedBalance.toString()).toBe("100"); // not 800

    const entries = await prisma.ledgerEntry.findMany({ where: { accountId: account!.id } });
    expect(entries).toHaveLength(1);

    const transactions = await prisma.ledgerTransaction.findMany({
      where: { referenceType: "Deposit", referenceId: deposits[0].id },
    });
    expect(transactions).toHaveLength(1);

    // Auditability holds under the same concurrency, not just the ledger.
    const auditRows = await auditLogsFor(deposits[0].id);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].actorType).toBe("SYSTEM");
    expect(auditRows[0].action).toBe("deposit.credit");
  });

  it("credits exactly once across many sequential retries of the same transaction", async () => {
    const user = await createTestUser();
    const assetNetwork = await getAssetNetwork("USDC", "ethereum-sepolia");
    const address = await provisionAddress(assetNetwork.id, `0xSequential${Date.now()}${Math.random()}`);
    const txHash = `0xsequential-${Date.now()}-${Math.random()}`;

    const input = {
      userId: user.id,
      assetSymbol: "USDC",
      assetNetworkId: assetNetwork.id,
      walletAddressId: address.id,
      txHash,
      amount: "50",
      confirmations: 12,
      requiredConfirmations: 12,
    };

    for (let i = 0; i < 5; i += 1) {
      await depositsService.recordObservedTransaction(input);
    }

    const account = await getUserAccount(user.id, "USDC");
    expect(account?.cachedBalance.toString()).toBe("50");
  });

  it("never regresses status once CREDITED, even if a stale/duplicate watcher update arrives late", async () => {
    const user = await createTestUser();
    const assetNetwork = await getAssetNetwork("USDC", "ethereum-sepolia");
    const address = await provisionAddress(assetNetwork.id, `0xStale${Date.now()}${Math.random()}`);
    const txHash = `0xstale-${Date.now()}-${Math.random()}`;

    await depositsService.recordObservedTransaction({
      userId: user.id,
      assetSymbol: "USDC",
      assetNetworkId: assetNetwork.id,
      walletAddressId: address.id,
      txHash,
      amount: "20",
      confirmations: 15,
      requiredConfirmations: 12,
    });

    // A late-arriving update reporting fewer confirmations than required
    // (e.g. a reorg-aware watcher re-checking) must not undo the credit.
    const result = await depositsService.recordObservedTransaction({
      userId: user.id,
      assetSymbol: "USDC",
      assetNetworkId: assetNetwork.id,
      walletAddressId: address.id,
      txHash,
      amount: "20",
      confirmations: 1,
      requiredConfirmations: 12,
    });

    expect(result.status).toBe("CREDITED");
    const account = await getUserAccount(user.id, "USDC");
    expect(account?.cachedBalance.toString()).toBe("20");
  });

  it("treats the same txHash with different eventIndex as distinct deposits (token-transfer safety)", async () => {
    const user = await createTestUser();
    const assetNetwork = await getAssetNetwork("USDC", "ethereum-sepolia");
    const address = await provisionAddress(assetNetwork.id, `0xMultiEvent${Date.now()}${Math.random()}`);
    // One transaction, two separate Transfer logs crediting the same user
    // — exactly the case txHash-alone identity would wrongly collapse.
    const txHash = `0xbatch-${Date.now()}-${Math.random()}`;

    await depositsService.recordObservedTransaction({
      userId: user.id,
      assetSymbol: "USDC",
      assetNetworkId: assetNetwork.id,
      walletAddressId: address.id,
      txHash,
      eventIndex: 0,
      amount: "30",
      confirmations: 12,
      requiredConfirmations: 12,
    });
    await depositsService.recordObservedTransaction({
      userId: user.id,
      assetSymbol: "USDC",
      assetNetworkId: assetNetwork.id,
      walletAddressId: address.id,
      txHash,
      eventIndex: 1,
      amount: "45",
      confirmations: 12,
      requiredConfirmations: 12,
    });

    const deposits = await prisma.deposit.findMany({ where: { assetNetworkId: assetNetwork.id, txHash } });
    expect(deposits).toHaveLength(2); // two distinct events, not deduped

    const account = await getUserAccount(user.id, "USDC");
    expect(account?.cachedBalance.toString()).toBe("75"); // both credited: 30 + 45
  });

  it("processes genuinely different concurrent deposit events without interfering with each other", async () => {
    const assetNetwork = await getAssetNetwork("USDC", "ethereum-sepolia");
    const users = await Promise.all(Array.from({ length: 5 }, () => createTestUser()));
    const marker = `${Date.now()}-${Math.random()}`;

    await Promise.all(
      users.map(async (user, i) => {
        const address = await provisionAddress(assetNetwork.id, `0xParallel${marker}-${i}`);
        return depositsService.recordObservedTransaction({
          userId: user.id,
          assetSymbol: "USDC",
          assetNetworkId: assetNetwork.id,
          walletAddressId: address.id,
          txHash: `0xparallel-${marker}-${i}`,
          amount: "10",
          confirmations: 12,
          requiredConfirmations: 12,
        });
      }),
    );

    for (const user of users) {
      const account = await getUserAccount(user.id, "USDC");
      expect(account?.cachedBalance.toString()).toBe("10");
    }
  });

  it("keeps the EXTERNAL_CHAIN house account as the balancing counterparty", async () => {
    const user = await createTestUser();
    const assetNetwork = await getAssetNetwork("USDC", "ethereum-sepolia");
    const address = await provisionAddress(assetNetwork.id, `0xHouse${Date.now()}${Math.random()}`);
    const txHash = `0xhouse-${Date.now()}-${Math.random()}`;

    await depositsService.recordObservedTransaction({
      userId: user.id,
      assetSymbol: "USDC",
      assetNetworkId: assetNetwork.id,
      walletAddressId: address.id,
      txHash,
      amount: "75",
      confirmations: 12,
      requiredConfirmations: 12,
    });

    const asset = await getAsset("USDC");
    const houseAccount = await prisma.ledgerAccount.findUnique({
      where: { houseAccountKey_assetId: { houseAccountKey: "EXTERNAL_CHAIN", assetId: asset.id } },
    });
    expect(houseAccount).not.toBeNull();
    expect(houseAccount!.cachedBalance.isNegative()).toBe(true);
  });
});
