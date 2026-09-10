import { decodeSegwitAddress } from "./bech32.util";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

// A minimal, test-only ENCODER (the production code only ever needs to
// decode/verify a user-supplied address, never mint one) — used purely
// to generate real, checksum-valid bech32/bech32m strings so the
// decoder under test can be exercised against genuinely well-formed
// input, including the harder-to-source bech32m/taproot case, without
// depending on transcribing a long address string from memory.
function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i += 1) if ((top >>> i) & 1) chk ^= GENERATOR[i];
  }
  return chk >>> 0;
}
function hrpExpand(hrp: string): number[] {
  return [...[...hrp].map((c) => c.charCodeAt(0) >>> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
}
function convertBits(data: number[], fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];
  const maxV = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >>> bits) & maxV);
    }
  }
  if (pad && bits > 0) result.push((acc << (toBits - bits)) & maxV);
  return result;
}
function encodeSegwitAddress(hrp: string, witnessVersion: number, program: number[]): string {
  const constValue = witnessVersion === 0 ? 1 : 0x2bc830a3;
  const data = [witnessVersion, ...convertBits(program, 8, 5, true)];
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ constValue;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i += 1) checksum.push((mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((v) => CHARSET[v]).join("")}`;
}

describe("decodeSegwitAddress", () => {
  it("accepts a real, previously-trusted mainnet v0 (P2WPKH) address from this repo's own existing test fixtures", () => {
    const result = decodeSegwitAddress("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "bc");
    expect(result).not.toBeNull();
    expect(result!.witnessVersion).toBe(0);
    expect(result!.program.length).toBe(20);
  });

  it("rejects that same address with a single flipped character (a corrupted checksum)", () => {
    const corrupted = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdp"; // last char changed
    expect(decodeSegwitAddress(corrupted, "bc")).toBeNull();
  });

  it("rejects an address for the wrong network (bc vs tb)", () => {
    expect(decodeSegwitAddress("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "tb")).toBeNull();
  });

  it("rejects mixed-case input", () => {
    expect(decodeSegwitAddress("Bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "bc")).toBeNull();
  });

  describe("round-trip against a self-generated, genuinely checksum-valid address", () => {
    it("accepts a real v0/P2WPKH (20-byte program) address", () => {
      const program = Array.from({ length: 20 }, (_, i) => i);
      const address = encodeSegwitAddress("bc", 0, program);
      const result = decodeSegwitAddress(address, "bc");
      expect(result).toEqual({ hrp: "bc", witnessVersion: 0, program: Buffer.from(program) });
    });

    it("accepts a real v0/P2WSH (32-byte program) address", () => {
      const program = Array.from({ length: 32 }, (_, i) => i);
      const address = encodeSegwitAddress("bc", 0, program);
      const result = decodeSegwitAddress(address, "bc");
      expect(result!.program.length).toBe(32);
    });

    it("accepts a real v1/taproot (bech32m) address and rejects the same payload encoded with the wrong (bech32) checksum", () => {
      const program = Array.from({ length: 32 }, (_, i) => 31 - i);
      const validTaproot = encodeSegwitAddress("bc", 1, program);
      expect(decodeSegwitAddress(validTaproot, "bc")).toEqual({ hrp: "bc", witnessVersion: 1, program: Buffer.from(program) });

      // Construct the identical data but checksummed as if it were v0
      // (bech32 instead of bech32m) — BIP-350 requires v1+ to use
      // bech32m specifically; a v1 payload with a bech32 checksum must
      // be rejected, not silently accepted as "close enough".
      const constValue = 1;
      const data = [1, ...convertBits(program, 8, 5, true)];
      const values = [...hrpExpand("bc"), ...data, 0, 0, 0, 0, 0, 0];
      const mod = polymod(values) ^ constValue;
      const checksum: number[] = [];
      for (let i = 0; i < 6; i += 1) checksum.push((mod >>> (5 * (5 - i))) & 31);
      const wrongChecksumType = `bc1${[...data, ...checksum].map((v) => CHARSET[v]).join("")}`;
      expect(decodeSegwitAddress(wrongChecksumType, "bc")).toBeNull();
    });

    it("rejects a v0 program that is neither 20 nor 32 bytes", () => {
      const program = Array.from({ length: 24 }, (_, i) => i);
      const address = encodeSegwitAddress("bc", 0, program);
      expect(decodeSegwitAddress(address, "bc")).toBeNull();
    });

    it("rejects a witness version greater than 16", () => {
      const program = Array.from({ length: 20 }, (_, i) => i);
      const address = encodeSegwitAddress("bc", 17, program);
      expect(decodeSegwitAddress(address, "bc")).toBeNull();
    });
  });
});
