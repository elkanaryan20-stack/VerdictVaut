import { Injectable, ServiceUnavailableException } from "@nestjs/common";

/**
 * Public sandbox/testnet endpoints, verified reachable at the time this
 * was written — real infrastructure, not placeholders, so the adapters
 * have something honest to talk to out of the box. Any of these can (and
 * for anything beyond light development traffic, should) be overridden
 * per network via <NETWORK_CODE>_RPC_URL (e.g. ETHEREUM_SEPOLIA_RPC_URL —
 * see .env.example) to point at a credentialed provider
 * (Infura/Alchemy/QuickNode/etc.) instead. There are deliberately no
 * production entries here: this app refuses to boot with
 * APP_ENVIRONMENT=production (see env.validation.ts), so a mainnet
 * default would only ever be dead code.
 */
const DEFAULT_SANDBOX_RPC_URLS: Record<string, string> = {
  "bitcoin-testnet": "https://blockstream.info/testnet/api",
  "ethereum-sepolia": "https://ethereum-sepolia-rpc.publicnode.com",
  "base-sepolia": "https://base-sepolia-rpc.publicnode.com",
  "solana-devnet": "https://api.devnet.solana.com",
  "xrpl-testnet": "https://s.altnet.rippletest.net:51234",
};

function envVarFor(networkCode: string): string {
  return `${networkCode.toUpperCase().replace(/-/g, "_")}_RPC_URL`;
}

@Injectable()
export class ChainRpcConfigService {
  getRpcUrl(networkCode: string): string {
    const envVar = envVarFor(networkCode);
    const url = process.env[envVar] || DEFAULT_SANDBOX_RPC_URLS[networkCode];
    if (!url) {
      throw new ServiceUnavailableException(
        `No RPC/provider URL configured for network "${networkCode}" — set ${envVar} or add a default.`,
      );
    }
    return url;
  }
}
