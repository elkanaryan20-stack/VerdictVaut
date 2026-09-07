import { BadRequestException } from "@nestjs/common";
import { assertValidDestinationAddress } from "./destination-address.validator";

describe("assertValidDestinationAddress", () => {
  describe("BITCOIN", () => {
    it("accepts a legacy P2PKH address", () => {
      expect(() => assertValidDestinationAddress("BITCOIN", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2")).not.toThrow();
    });

    it("accepts a bech32 address", () => {
      expect(() => assertValidDestinationAddress("BITCOIN", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).not.toThrow();
    });

    it("rejects an EVM address on the Bitcoin network", () => {
      expect(() => assertValidDestinationAddress("BITCOIN", "0x000000000000000000000000000000000000dEaD")).toThrow(BadRequestException);
    });

    it("rejects an obviously malformed string", () => {
      expect(() => assertValidDestinationAddress("BITCOIN", "not-an-address")).toThrow(BadRequestException);
    });
  });

  describe("EVM", () => {
    it("accepts a well-formed 0x address", () => {
      expect(() => assertValidDestinationAddress("EVM", "0x000000000000000000000000000000000000dEaD")).not.toThrow();
    });

    it("rejects a too-short hex string", () => {
      expect(() => assertValidDestinationAddress("EVM", "0x1234")).toThrow(BadRequestException);
    });

    it("rejects an address missing the 0x prefix", () => {
      expect(() => assertValidDestinationAddress("EVM", "000000000000000000000000000000000000dEaD")).toThrow(BadRequestException);
    });

    it("rejects a Solana-shaped address on an EVM network", () => {
      expect(() => assertValidDestinationAddress("EVM", "DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK")).toThrow(BadRequestException);
    });
  });

  describe("SOLANA", () => {
    it("accepts a well-formed base58 address", () => {
      expect(() => assertValidDestinationAddress("SOLANA", "DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK")).not.toThrow();
    });

    it("rejects a string containing characters base58 excludes (0, O, I, l)", () => {
      expect(() => assertValidDestinationAddress("SOLANA", "0OIl8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5")).toThrow(BadRequestException);
    });

    it("rejects a too-short string", () => {
      expect(() => assertValidDestinationAddress("SOLANA", "short")).toThrow(BadRequestException);
    });
  });

  describe("XRPL", () => {
    it("accepts a well-formed classic address", () => {
      expect(() => assertValidDestinationAddress("XRPL", "rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh")).not.toThrow();
    });

    it("rejects an address not starting with 'r'", () => {
      expect(() => assertValidDestinationAddress("XRPL", "xEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh")).toThrow(BadRequestException);
    });

    it("rejects a Bitcoin address on XRPL", () => {
      expect(() => assertValidDestinationAddress("XRPL", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2")).toThrow(BadRequestException);
    });
  });

  it("rejects an empty string for every network family", () => {
    for (const family of ["BITCOIN", "EVM", "SOLANA", "XRPL"] as const) {
      expect(() => assertValidDestinationAddress(family, "")).toThrow(BadRequestException);
    }
  });
});
