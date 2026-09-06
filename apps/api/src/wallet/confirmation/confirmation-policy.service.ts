import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * The single place "is this deposit final enough to credit" is decided.
 * Required-confirmation counts are per asset/network configuration
 * (AssetNetwork.minConfirmations — set at seed/admin-config time, e.g.
 * 2 for BTC testnet, 12 for Sepolia, 32 for Solana devnet, 1 for a
 * validated XRPL ledger) rather than one global constant, because finality
 * time genuinely differs per chain and reflects real reorg-depth risk.
 *
 * This is deliberately a pure decision function over inputs the caller
 * already obtained from a chain adapter — it never itself talks to a
 * chain, so it stays trivially unit-testable and safe to call from
 * inside a DB transaction if ever needed.
 */
@Injectable()
export class ConfirmationPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async getRequiredConfirmations(assetNetworkId: string): Promise<number> {
    const assetNetwork = await this.prisma.assetNetwork.findUniqueOrThrow({ where: { id: assetNetworkId } });
    return assetNetwork.minConfirmations;
  }

  /**
   * True only when observed confirmations meet or exceed the configured
   * requirement. A negative or missing confirmation count is never
   * treated as final — the caller must have genuine chain evidence.
   */
  isFinal(confirmations: number, requiredConfirmations: number): boolean {
    return confirmations >= requiredConfirmations && confirmations >= 0;
  }
}
