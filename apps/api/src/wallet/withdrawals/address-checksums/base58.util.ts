import * as crypto from "crypto";

// Standard Base58 (Bitcoin alphabet) decode, and the Base58Check
// wrapper (Base58 + a trailing 4-byte SHA256(SHA256(payload)) checksum)
// used by Bitcoin legacy addresses and, with a different alphabet, XRP
// classic addresses. Both are simple, well-published constructions —
// not something reimplemented from a guess — built entirely on Node's
// native `crypto` module (SHA-256 has been in Node's built-in `crypto`
// since its earliest versions), so this needs no new dependency.

const BITCOIN_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
// XRPL uses its own alphabet (same 58 symbols, different assignment) —
// see https://xrpl.org/docs/concepts/accounts/addresses (base58 with a
// ripple-specific dictionary).
const XRPL_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

export type Base58Alphabet = "BITCOIN" | "XRPL";

function alphabetFor(alphabet: Base58Alphabet): string {
  return alphabet === "BITCOIN" ? BITCOIN_ALPHABET : XRPL_ALPHABET;
}

/** Decodes a Base58 string to raw bytes, or returns null for any input that isn't validly encoded in this alphabet. */
export function decodeBase58(input: string, alphabet: Base58Alphabet): Buffer | null {
  const chars = alphabetFor(alphabet);
  if (input.length === 0) return null;

  let value = 0n;
  for (const char of input) {
    const digit = chars.indexOf(char);
    if (digit === -1) return null;
    value = value * 58n + BigInt(digit);
  }

  // Big-endian byte conversion of the accumulated value.
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value % 256n));
    value /= 256n;
  }

  // Each leading "1" (the alphabet's zero-index character) encodes one
  // leading zero byte that the big-integer conversion above otherwise
  // drops entirely.
  const zeroChar = chars[0];
  let leadingZeros = 0;
  for (const char of input) {
    if (char !== zeroChar) break;
    leadingZeros += 1;
  }

  return Buffer.concat([Buffer.alloc(leadingZeros, 0), Buffer.from(bytes)]);
}

/**
 * Decodes and verifies a Base58Check string: the last 4 bytes must
 * equal the first 4 bytes of SHA256(SHA256(payload)). Returns the
 * payload (version byte + hash, checksum stripped) on success, or null
 * on any decode or checksum failure — deliberately never throws, since
 * "not a valid address" is an expected, common outcome here, not an
 * exceptional one.
 */
export function decodeBase58Check(input: string, alphabet: Base58Alphabet): Buffer | null {
  const decoded = decodeBase58(input, alphabet);
  if (!decoded || decoded.length < 5) return null; // at least 1 version byte + 4 checksum bytes

  const payload = decoded.subarray(0, decoded.length - 4);
  const checksum = decoded.subarray(decoded.length - 4);

  const hash1 = crypto.createHash("sha256").update(payload).digest();
  const hash2 = crypto.createHash("sha256").update(hash1).digest();
  const expectedChecksum = hash2.subarray(0, 4);

  return checksum.equals(expectedChecksum) ? payload : null;
}
