import * as crypto from "crypto";
import { decodeBase58, decodeBase58Check } from "./base58.util";

const BITCOIN_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// Test-only encoder, mirroring bech32.util.spec.ts's approach: round-
// tripping through an independent encode path exercises the
// big-integer <-> bytes conversion and leading-zero handling that are
// the actual risk in a from-scratch Base58 implementation, without
// depending on transcribing an external address string from memory.
function encodeBase58(bytes: Buffer, alphabet: string): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);

  let out = "";
  while (value > 0n) {
    const digit = Number(value % 58n);
    out = alphabet[digit] + out;
    value /= 58n;
  }

  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingZeros += 1;
  }
  return alphabet[0].repeat(leadingZeros) + out;
}

function encodeBase58Check(payload: Buffer, alphabet: string): string {
  const hash1 = crypto.createHash("sha256").update(payload).digest();
  const hash2 = crypto.createHash("sha256").update(hash1).digest();
  return encodeBase58(Buffer.concat([payload, hash2.subarray(0, 4)]), alphabet);
}

describe("decodeBase58 / decodeBase58Check", () => {
  it("accepts the Bitcoin genesis-block address — a real, universally-cited, checksum-valid mainnet P2PKH address", () => {
    const payload = decodeBase58Check("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "BITCOIN");
    expect(payload).not.toBeNull();
    expect(payload!.length).toBe(21); // 1 version byte + 20-byte hash160
    expect(payload![0]).toBe(0x00); // mainnet P2PKH version byte
  });

  it("rejects that same address with one corrupted character", () => {
    const corrupted = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb";
    expect(decodeBase58Check(corrupted, "BITCOIN")).toBeNull();
  });

  it("rejects a string containing a character outside the Base58 alphabet (e.g. '0', 'O', 'I', 'l' are deliberately excluded)", () => {
    expect(decodeBase58("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfN0", "BITCOIN")).toBeNull();
  });

  describe("round-trip against a self-generated, genuinely checksum-valid payload", () => {
    it("round-trips an arbitrary 21-byte payload (version byte + 20-byte hash)", () => {
      const payload = Buffer.from([0x00, ...Array.from({ length: 20 }, (_, i) => i * 3)]);
      const encoded = encodeBase58Check(payload, BITCOIN_ALPHABET);
      expect(decodeBase58Check(encoded, "BITCOIN")).toEqual(payload);
    });

    it("correctly preserves leading zero bytes (a known Base58 edge case)", () => {
      const payload = Buffer.from([0x00, 0x00, 0x00, 1, 2, 3, 4, 5]);
      const encoded = encodeBase58Check(payload, BITCOIN_ALPHABET);
      expect(encoded.startsWith("111")).toBe(true); // 3 leading zero bytes -> 3 leading '1' characters
      expect(decodeBase58Check(encoded, "BITCOIN")).toEqual(payload);
    });

    it("rejects a genuinely valid encoding under the WRONG alphabet (Bitcoin vs XRPL)", () => {
      const payload = Buffer.from([0x00, ...Array.from({ length: 20 }, (_, i) => i)]);
      const encodedXrpl = encodeBase58Check(payload, "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz");
      // Not guaranteed to be UNDECODABLE under the Bitcoin alphabet (the
      // character sets overlap), but the checksum will not match once
      // reinterpreted through the wrong digit assignment.
      expect(decodeBase58Check(encodedXrpl, "BITCOIN")).toBeNull();
    });
  });
});
