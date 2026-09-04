import { BadRequestException } from "@nestjs/common";
import { NetworkFamily } from "@prisma/client";

/**
 * Basic per-network-family format sanity checks — catches the obvious
 * typo/wrong-network mistake before a withdrawal is even requested. This
 * is deliberately not full checksum/vanity validation (e.g. EIP-55 mixed
 * case checksums, Bech32 checksum verification) — that belongs with the
 * real chain integration, where a wrong destination has real
 * consequences. Until then this is a cheap, useful guard, not the last
 * line of defense.
 */
const PATTERNS: Record<NetworkFamily, RegExp> = {
  BITCOIN: /^(1[a-km-zA-HJ-NP-Z1-9]{25,34}|3[a-km-zA-HJ-NP-Z1-9]{25,34}|(bc1|tb1)[a-z0-9]{25,60})$/,
  EVM: /^0x[a-fA-F0-9]{40}$/,
  SOLANA: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  XRPL: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
};

export function assertValidDestinationAddress(family: NetworkFamily, address: string): void {
  if (!PATTERNS[family].test(address)) {
    throw new BadRequestException(`Destination address does not look like a valid ${family} address`);
  }
}
