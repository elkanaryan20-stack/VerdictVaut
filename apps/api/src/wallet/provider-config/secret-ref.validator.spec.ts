import { BadRequestException } from "@nestjs/common";
import { assertValidSecretRef } from "./secret-ref.validator";

describe("assertValidSecretRef", () => {
  it("allows a null/undefined value (the field is optional)", () => {
    expect(() => assertValidSecretRef(undefined, "credentialsSecretRef")).not.toThrow();
    expect(() => assertValidSecretRef(null, "credentialsSecretRef")).not.toThrow();
  });

  it.each(["env:FIREBLOCKS_API_KEY", "secretsmanager:prod/fireblocks/api-key", "vault:secret/fireblocks", "doppler:prj/config/KEY", "ssm:/prod/fireblocks/key"])(
    "accepts a well-formed scheme:path reference (%s)",
    (ref) => {
      expect(() => assertValidSecretRef(ref, "credentialsSecretRef")).not.toThrow();
    },
  );

  it("rejects a bare value with no scheme prefix — the exact shape of pasting a raw secret by mistake", () => {
    expect(() => assertValidSecretRef("sk_live_abcdef123456", "credentialsSecretRef")).toThrow(BadRequestException);
  });

  it("rejects an unrecognized scheme", () => {
    expect(() => assertValidSecretRef("s3:bucket/key", "credentialsSecretRef")).toThrow(BadRequestException);
  });

  it("rejects a scheme with nothing after the colon", () => {
    expect(() => assertValidSecretRef("env:", "credentialsSecretRef")).toThrow(BadRequestException);
  });

  it("names the offending field in the error message", () => {
    expect(() => assertValidSecretRef("bad-value", "webhookSecretRef")).toThrow(/webhookSecretRef/);
  });
});
