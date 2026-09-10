import { BadRequestException } from "@nestjs/common";
import { NetworkFamily } from "@prisma/client";
import { decodeBase58, decodeBase58Check } from "./address-checksums/base58.util";
import { decodeSegwitAddress } from "./address-checksums/bech32.util";

/**
 * FORMAT + CHECKSUM validation only — this proves the string is a
 * structurally well-formed, correctly-checksummed address for the
 * given network family. It does NOT prove the destination is actually
 * owned/controlled by anyone in particular, or that it exists on
 * chain, or that a chain-adapter has ever observed it — that would be
 * on-chain OWNERSHIP verification, which this system does not perform
 * for any network (see WithdrawalsService.reconcile()'s destination
 * cross-check for EVM/XRP, which compares against chain-reported data
 * for an ALREADY-BROADCAST withdrawal, and the explicit absence of any
 * equivalent for Bitcoin/Solana — still an open item, not something
 * this function claims to close).
 */
const EVM_PATTERN = /^0x[a-fA-F0-9]{40}$/;

function assertValidBitcoinAddress(address: string): void {
  if (/^(1|3)/.test(address)) {
    const payload = decodeBase58Check(address, "BITCOIN");
    // 1 version byte + 20-byte hash160 — true for both P2PKH (1...) and
    // P2SH (3...); this does not itself distinguish which version byte
    // was used, matching the pre-existing lax scope of "looks like a
    // legacy Bitcoin address", now with a REAL checksum behind it
    // instead of a bare shape guess.
    if (payload && payload.length === 21) return;
    throw new BadRequestException("Destination address does not look like a valid BITCOIN address");
  }

  if (/^(bc1|tb1)/i.test(address)) {
    const hrp = address.slice(0, 2).toLowerCase();
    if (decodeSegwitAddress(address, hrp)) return;
    throw new BadRequestException("Destination address does not look like a valid BITCOIN address");
  }

  throw new BadRequestException("Destination address does not look like a valid BITCOIN address");
}

function assertValidSolanaAddress(address: string): void {
  // Solana addresses are Base58-encoded 32-byte ed25519 public keys —
  // unlike Bitcoin/XRP there is no embedded checksum to verify (Solana
  // itself has no Base58Check convention), so the strongest format
  // check available is: does this decode, under the standard Base58
  // alphabet, to exactly 32 bytes. This rejects garbage that merely
  // LOOKS the right length as a string (the old regex's only check) but
  // decodes to the wrong byte length.
  const decoded = decodeBase58(address, "BITCOIN"); // Solana reuses the same (Bitcoin/IPFS) Base58 alphabet
  if (decoded && decoded.length === 32) return;
  throw new BadRequestException("Destination address does not look like a valid SOLANA address");
}

function assertValidXrplAddress(address: string): void {
  if (!address.startsWith("r")) {
    throw new BadRequestException("Destination address does not look like a valid XRPL address");
  }
  const payload = decodeBase58Check(address, "XRPL");
  // XRPL classic addresses: 1 version byte (always 0x00) + 20-byte account ID.
  if (payload && payload.length === 21 && payload[0] === 0x00) return;
  throw new BadRequestException("Destination address does not look like a valid XRPL address");
}

function assertValidEvmAddress(address: string): void {
  if (!EVM_PATTERN.test(address)) {
    throw new BadRequestException("Destination address does not look like a valid EVM address");
  }
  // EIP-55 mixed-case checksum verification is DEFERRED, deliberately:
  // it requires Keccak-256, which is NOT the same algorithm as the
  // SHA3-256 Node's built-in `crypto` module provides (different
  // padding — using SHA3-256 here would silently compute the WRONG
  // checksum for every address). Implementing Keccak-256 from scratch
  // is exactly the kind of hand-rolled cryptographic primitive this
  // phase was told not to invent, and no Keccak/EIP-55 dependency is
  // present in this repo today (this app's chain adapters deliberately
  // avoid blockchain SDK dependencies — see chain-adapters/*.util.ts).
  // A lowercase or fully-uppercase address (both valid, checksum-free
  // forms) and a correctly-checksummed mixed-case address are all
  // accepted identically here; an INCORRECTLY-checksummed mixed-case
  // address is also accepted (format-only) rather than rejected. This
  // is an explicit, documented gap — not silently absent — pending a
  // real decision on adding a Keccak-256 dependency.
}

export function assertValidDestinationAddress(family: NetworkFamily, address: string): void {
  if (!address) {
    throw new BadRequestException(`Destination address does not look like a valid ${family} address`);
  }

  switch (family) {
    case "BITCOIN":
      return assertValidBitcoinAddress(address);
    case "EVM":
      return assertValidEvmAddress(address);
    case "SOLANA":
      return assertValidSolanaAddress(address);
    case "XRPL":
      return assertValidXrplAddress(address);
  }
}
