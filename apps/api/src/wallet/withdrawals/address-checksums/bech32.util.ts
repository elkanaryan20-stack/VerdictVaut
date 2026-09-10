// Faithful implementation of BIP-173 (bech32, segwit v0) and BIP-350
// (bech32m, segwit v1+ including taproot) — the standard, published
// checksum algorithms for Bitcoin's native segwit address formats
// (bc1.../tb1...). This is NOT a cryptographic hash — it's a
// CRC-style polynomial checksum specifically designed to be simple and
// exactly reference-implementable from the BIP text, which is what
// this is: a direct transcription of the reference algorithm, verified
// in bech32.util.spec.ts against the BIPs' own official test vectors,
// not an invented scheme.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i += 1) {
      if ((top >>> i) & 1) chk ^= GENERATOR[i];
    }
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const high = [...hrp].map((c) => c.charCodeAt(0) >>> 5);
  const low = [...hrp].map((c) => c.charCodeAt(0) & 31);
  return [...high, 0, ...low];
}

/** Regroups an array of `fromBits`-wide values into `toBits`-wide values (used for 5-bit <-> 8-bit witness-program conversion). */
function convertBits(data: number[], fromBits: number, toBits: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];
  const maxV = (1 << toBits) - 1;

  for (const value of data) {
    if (value < 0 || value >>> fromBits !== 0) return null;
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >>> bits) & maxV);
    }
  }

  if (pad) {
    if (bits > 0) result.push((acc << (toBits - bits)) & maxV);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxV) !== 0) {
    return null;
  }

  return result;
}

export interface DecodedSegwitAddress {
  hrp: string;
  witnessVersion: number;
  program: Buffer;
}

/**
 * Decodes and fully verifies a bech32/bech32m segwit address — checksum
 * (trying both constants, since which one is valid depends on the
 * witness version per BIP-350), witness version/program-length
 * consistency (BIP-141: v0 must be exactly 20 or 32 bytes; BIP-350
 * additionally requires v0 use plain bech32 and v1+ use bech32m), and
 * the expected human-readable prefix. Returns null for anything that
 * doesn't fully check out — never throws, since "not a valid address"
 * is an ordinary, expected outcome here.
 */
export function decodeSegwitAddress(address: string, expectedHrp: string): DecodedSegwitAddress | null {
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) return null; // mixed case is invalid per BIP-173
  const lower = address.toLowerCase();

  const separator = lower.lastIndexOf("1");
  if (separator < 1 || separator + 7 > lower.length || lower.length > 90) return null;

  const hrp = lower.slice(0, separator);
  if (hrp !== expectedHrp.toLowerCase()) return null;

  const dataPart = lower.slice(separator + 1);
  const values: number[] = [];
  for (const char of dataPart) {
    const index = CHARSET.indexOf(char);
    if (index === -1) return null;
    values.push(index);
  }

  const checksum = polymod([...hrpExpand(hrp), ...values]);
  const isBech32 = checksum === BECH32_CONST;
  const isBech32m = checksum === BECH32M_CONST;
  if (!isBech32 && !isBech32m) return null;

  const witnessVersion = values[0];
  const programWords = values.slice(1, values.length - 6); // strip version word + 6-word checksum
  const program = convertBits(programWords, 5, 8, false);
  if (!program || program.length < 2 || program.length > 40) return null;
  if (witnessVersion > 16) return null;

  // BIP-350: v0 must use bech32 (never bech32m), v1+ must use bech32m
  // (never bech32) — the two are not interchangeable by witness version.
  if (witnessVersion === 0 && !isBech32) return null;
  if (witnessVersion !== 0 && !isBech32m) return null;
  // BIP-141: segwit v0 programs are exactly P2WPKH (20 bytes) or P2WSH (32 bytes).
  if (witnessVersion === 0 && program.length !== 20 && program.length !== 32) return null;

  return { hrp, witnessVersion, program: Buffer.from(program) };
}
