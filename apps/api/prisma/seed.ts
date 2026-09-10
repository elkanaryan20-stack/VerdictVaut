import { PrismaClient, AssetClass, NetworkFamily, NetworkEnvironment } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Reference-data seed only: assets, networks, and the asset<->network join.
 * This never inserts balances, deposits, withdrawals, or transactions —
 * those only ever come from real ledger/chain activity.
 */
async function main() {
  const assets = await Promise.all(
    [
      { symbol: "BTC", name: "Bitcoin", decimals: 8, assetClass: AssetClass.NATIVE, isSettlementCurrency: false },
      { symbol: "ETH", name: "Ethereum", decimals: 18, assetClass: AssetClass.NATIVE, isSettlementCurrency: false },
      { symbol: "SOL", name: "Solana", decimals: 9, assetClass: AssetClass.NATIVE, isSettlementCurrency: false },
      { symbol: "USDC", name: "USD Coin", decimals: 6, assetClass: AssetClass.TOKEN, isSettlementCurrency: true },
      { symbol: "USDT", name: "Tether", decimals: 6, assetClass: AssetClass.TOKEN, isSettlementCurrency: false },
      { symbol: "XRP", name: "XRP", decimals: 6, assetClass: AssetClass.NATIVE, isSettlementCurrency: false },
    ].map((a) =>
      prisma.asset.upsert({ where: { symbol: a.symbol }, create: a, update: a }),
    ),
  );
  const assetBySymbol = Object.fromEntries(assets.map((a) => [a.symbol, a]));

  const networks = await Promise.all(
    [
      { code: "bitcoin-testnet", family: NetworkFamily.BITCOIN, environment: NetworkEnvironment.SANDBOX, name: "Bitcoin Testnet" },
      { code: "ethereum-sepolia", family: NetworkFamily.EVM, environment: NetworkEnvironment.SANDBOX, name: "Ethereum Sepolia" },
      { code: "base-sepolia", family: NetworkFamily.EVM, environment: NetworkEnvironment.SANDBOX, name: "Base Sepolia" },
      { code: "solana-devnet", family: NetworkFamily.SOLANA, environment: NetworkEnvironment.SANDBOX, name: "Solana Devnet" },
      { code: "xrpl-testnet", family: NetworkFamily.XRPL, environment: NetworkEnvironment.SANDBOX, name: "XRPL Testnet" },
      { code: "bitcoin-mainnet", family: NetworkFamily.BITCOIN, environment: NetworkEnvironment.PRODUCTION, name: "Bitcoin Mainnet" },
      { code: "ethereum-mainnet", family: NetworkFamily.EVM, environment: NetworkEnvironment.PRODUCTION, name: "Ethereum Mainnet" },
      { code: "base-mainnet", family: NetworkFamily.EVM, environment: NetworkEnvironment.PRODUCTION, name: "Base Mainnet" },
      { code: "solana-mainnet", family: NetworkFamily.SOLANA, environment: NetworkEnvironment.PRODUCTION, name: "Solana Mainnet" },
      { code: "xrpl-mainnet", family: NetworkFamily.XRPL, environment: NetworkEnvironment.PRODUCTION, name: "XRPL Mainnet" },
    ].map((n) => prisma.network.upsert({ where: { code: n.code }, create: n, update: n })),
  );
  const networkByCode = Object.fromEntries(networks.map((n) => [n.code, n]));

  const assetNetworks: Array<{
    assetSymbol: string;
    networkCode: string;
    isNative: boolean;
    contractAddress?: string;
    memoRequired?: boolean;
    minConfirmations: number;
    /** Defaults to true (matching the schema default) when omitted. */
    isActive?: boolean;
  }> = [
    { assetSymbol: "BTC", networkCode: "bitcoin-testnet", isNative: true, minConfirmations: 2 },
    { assetSymbol: "ETH", networkCode: "ethereum-sepolia", isNative: true, minConfirmations: 12 },
    { assetSymbol: "SOL", networkCode: "solana-devnet", isNative: true, minConfirmations: 32 },
    { assetSymbol: "XRP", networkCode: "xrpl-testnet", isNative: true, memoRequired: true, minConfirmations: 1 },
    // Circle's own published testnet USDC deployments — confirmed live
    // (deployed contract bytecode, matching Circle's standard
    // upgradeable FiatTokenProxy) against the public RPC endpoints this
    // app defaults to (see chain-adapters/rpc-config.service.ts) at the
    // time this was written. USDC on Sepolia and USDC on Base Sepolia
    // are deliberately different contract addresses on different
    // networks — never assume one asset has one universal address.
    { assetSymbol: "USDC", networkCode: "ethereum-sepolia", isNative: false, contractAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", minConfirmations: 12 },
    { assetSymbol: "USDC", networkCode: "base-sepolia", isNative: false, contractAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", minConfirmations: 12 },
    // Tether does not publish an official Sepolia testnet deployment —
    // contractAddress is deliberately left unset rather than inventing
    // one, and this row is seeded isActive: false to match: honestly
    // non-functional and un-activatable (asset_networks_active_token_
    // requires_contract_check enforces this at the DB level too, not
    // just here) until a real address is available and someone
    // deliberately activates it via AssetsNetworksService with one
    // configured. Phase 14A audit finding: this row previously had no
    // isActive override and silently defaulted to the schema's `true`,
    // contradicting this very comment's stated intent.
    { assetSymbol: "USDT", networkCode: "ethereum-sepolia", isNative: false, minConfirmations: 12, isActive: false },
  ];

  for (const an of assetNetworks) {
    const asset = assetBySymbol[an.assetSymbol];
    const network = networkByCode[an.networkCode];
    await prisma.assetNetwork.upsert({
      where: { assetId_networkId: { assetId: asset.id, networkId: network.id } },
      create: {
        assetId: asset.id,
        networkId: network.id,
        isNative: an.isNative,
        contractAddress: an.contractAddress,
        memoRequired: an.memoRequired ?? false,
        minConfirmations: an.minConfirmations,
        isActive: an.isActive ?? true,
      },
      update: {
        isNative: an.isNative,
        contractAddress: an.contractAddress,
        memoRequired: an.memoRequired ?? false,
        minConfirmations: an.minConfirmations,
        isActive: an.isActive ?? true,
      },
    });
  }

  console.log("Seed complete: assets, networks, and asset-network pairs upserted.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
