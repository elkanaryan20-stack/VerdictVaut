import { balancesService, createTestUser, depositsService, fundUserForTest, getAssetNetwork, prisma } from "./helpers";

async function provisionAndAssign(userId: string, assetSymbol: string, networkCode: string, address: string) {
  const assetNetwork = await getAssetNetwork(assetSymbol, networkCode);
  const wallet = await prisma.walletAddress.create({
    data: { assetNetworkId: assetNetwork.id, address, environment: "SANDBOX", status: "ASSIGNED" },
  });
  await prisma.depositAddressAssignment.create({
    data: {
      userId,
      assetId: assetNetwork.assetId,
      networkId: assetNetwork.networkId,
      assetNetworkId: assetNetwork.id,
      walletAddressId: wallet.id,
      environment: "SANDBOX",
    },
  });
  return wallet;
}

describe("GET /wallet/balances (real Postgres)", () => {
  it("returns every active asset for a brand-new user, all zero-filled", async () => {
    const user = await createTestUser();
    const balances = await balancesService.getMyBalances(user.id);

    expect(balances.length).toBeGreaterThanOrEqual(6); // BTC, ETH, SOL, USDC, USDT, XRP
    for (const balance of balances) {
      expect(balance.totalBalance).toBe("0");
      expect(balance.reservedBalance).toBe("0");
      expect(balance.availableBalance).toBe("0");
    }
  });

  it("reflects a real ledger credit for exactly the asset that was funded, leaving every other asset at zero", async () => {
    const user = await createTestUser();
    await fundUserForTest(user.id, "USDC", "150");

    const balances = await balancesService.getMyBalances(user.id);
    const usdc = balances.find((b) => b.symbol === "USDC")!;
    const btc = balances.find((b) => b.symbol === "BTC")!;

    expect(usdc.totalBalance).toBe("150");
    expect(usdc.availableBalance).toBe("150");
    expect(btc.totalBalance).toBe("0");
  });

  it("never exposes another user's balance", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    await fundUserForTest(userA.id, "USDC", "500");

    const balancesB = await balancesService.getMyBalances(userB.id);
    expect(balancesB.find((b) => b.symbol === "USDC")!.totalBalance).toBe("0");
  });
});

describe("DepositsService.listMine pagination (real Postgres)", () => {
  it("returns only the requested page, newest-first, with an accurate total", async () => {
    const user = await createTestUser();
    const marker = `${Date.now()}-${Math.random()}`;
    const wallet = await provisionAndAssign(user.id, "USDC", "ethereum-sepolia", `0xPaged${marker}`);
    const assetNetwork = await getAssetNetwork("USDC", "ethereum-sepolia");

    // Five deposits, sequentially detected.
    for (let i = 0; i < 5; i += 1) {
      await depositsService.recordObservedTransaction({
        userId: user.id,
        assetSymbol: "USDC",
        assetNetworkId: assetNetwork.id,
        walletAddressId: wallet.id,
        txHash: `0xpage-${marker}-${i}`,
        amount: "1",
        confirmations: 12,
        requiredConfirmations: 12,
      });
    }

    const pageOne = await depositsService.listMine(user.id, 1, 2);
    expect(pageOne.items).toHaveLength(2);
    expect(pageOne.total).toBe(5);
    expect(pageOne.page).toBe(1);
    expect(pageOne.pageSize).toBe(2);

    const pageTwo = await depositsService.listMine(user.id, 2, 2);
    expect(pageTwo.items).toHaveLength(2);
    // No overlap between pages.
    const pageOneIds = new Set(pageOne.items.map((d) => d.id));
    for (const item of pageTwo.items) {
      expect(pageOneIds.has(item.id)).toBe(false);
    }

    const pageThree = await depositsService.listMine(user.id, 3, 2);
    expect(pageThree.items).toHaveLength(1); // remainder
  });

  it("never returns another user's deposits, and total reflects only this user's own", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const marker = `${Date.now()}-${Math.random()}`;
    const walletA = await provisionAndAssign(userA.id, "USDC", "ethereum-sepolia", `0xUserA${marker}`);
    const assetNetwork = await getAssetNetwork("USDC", "ethereum-sepolia");

    await depositsService.recordObservedTransaction({
      userId: userA.id,
      assetSymbol: "USDC",
      assetNetworkId: assetNetwork.id,
      walletAddressId: walletA.id,
      txHash: `0xuserA-${marker}`,
      amount: "10",
      confirmations: 12,
      requiredConfirmations: 12,
    });

    const resultB = await depositsService.listMine(userB.id, 1, 20);
    expect(resultB.total).toBe(0);
    expect(resultB.items).toHaveLength(0);
  });
});
