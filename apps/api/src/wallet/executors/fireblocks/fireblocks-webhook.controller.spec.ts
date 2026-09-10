import { BadRequestException, RawBodyRequest, UnauthorizedException } from "@nestjs/common";
import { Request } from "express";
import * as crypto from "crypto";
import { PrismaService } from "../../../prisma/prisma.service";
import { SecretResolverService } from "../../provider-config/secret-resolver.service";
import { FireblocksWebhookController } from "./fireblocks-webhook.controller";
import { FireblocksWebhookService } from "./fireblocks-webhook.service";

function generateTestKeyPair() {
  return crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
}

function sign(body: string, privateKey: string): string {
  return crypto.sign("RSA-SHA512", Buffer.from(body, "utf8"), privateKey).toString("base64");
}

function makeRequest(rawBody: string): RawBodyRequest<Request> {
  return { rawBody: Buffer.from(rawBody, "utf8") } as unknown as RawBodyRequest<Request>;
}

describe("FireblocksWebhookController", () => {
  const { privateKey, publicKey } = generateTestKeyPair();
  let webhookService: { processWebhookPayload: jest.Mock };
  let prisma: { custodyProviderConfig: { findMany: jest.Mock } };
  let secretResolver: { resolve: jest.Mock };
  let config: { get: jest.Mock };
  let controller: FireblocksWebhookController;

  beforeEach(() => {
    webhookService = { processWebhookPayload: jest.fn().mockResolvedValue("processed") };
    prisma = { custodyProviderConfig: { findMany: jest.fn().mockResolvedValue([{ webhookSecretRef: "env:FIREBLOCKS_WEBHOOK_PUBLIC_KEY", environment: "SANDBOX" }]) } };
    secretResolver = { resolve: jest.fn().mockReturnValue(publicKey) };
    config = { get: jest.fn().mockReturnValue("sandbox") };
    controller = new FireblocksWebhookController(
      webhookService as unknown as FireblocksWebhookService,
      prisma as unknown as PrismaService,
      secretResolver as unknown as SecretResolverService,
      config as never,
    );
  });

  it("rejects a request with no Fireblocks-Signature header", async () => {
    await expect(controller.handle(makeRequest("{}"), undefined)).rejects.toThrow(UnauthorizedException);
    expect(webhookService.processWebhookPayload).not.toHaveBeenCalled();
  });

  it("rejects a request with an invalid signature", async () => {
    const body = JSON.stringify({ type: "T", data: { id: "fb-1", status: "COMPLETED" } });
    await expect(controller.handle(makeRequest(body), "not-a-real-signature")).rejects.toThrow(UnauthorizedException);
    expect(webhookService.processWebhookPayload).not.toHaveBeenCalled();
  });

  it("accepts a genuinely valid signature and forwards the parsed payload to the service", async () => {
    const body = JSON.stringify({ type: "T", data: { id: "fb-1", status: "COMPLETED", txHash: "0xreal", externalTxId: "wd-1" } });
    const signature = sign(body, privateKey);

    const result = await controller.handle(makeRequest(body), signature);

    expect(result).toEqual({ status: "processed" });
    expect(webhookService.processWebhookPayload).toHaveBeenCalledWith({ type: "T", data: { id: "fb-1", status: "COMPLETED", txHash: "0xreal", externalTxId: "wd-1" } });
  });

  it("rejects when no CustodyProviderConfig has a Fireblocks webhook key configured at all", async () => {
    prisma.custodyProviderConfig.findMany.mockResolvedValue([]);
    const body = "{}";
    const signature = sign(body, privateKey);
    await expect(controller.handle(makeRequest(body), signature)).rejects.toThrow(UnauthorizedException);
  });

  it("throws BadRequestException if the raw body was not captured", async () => {
    const req = { rawBody: undefined } as unknown as RawBodyRequest<Request>;
    await expect(controller.handle(req, "some-signature")).rejects.toThrow(BadRequestException);
  });

  it("rejects a validly-signed but non-JSON body", async () => {
    const body = "not json";
    const signature = sign(body, privateKey);
    await expect(controller.handle(makeRequest(body), signature)).rejects.toThrow(BadRequestException);
  });

  describe("A1 — webhook verification environment isolation (security review finding)", () => {
    const sandboxKeys = generateTestKeyPair();
    const productionKeys = generateTestKeyPair();

    const allConfigs = [
      { webhookSecretRef: "env:FIREBLOCKS_SANDBOX_WEBHOOK_KEY", environment: "SANDBOX" },
      { webhookSecretRef: "env:FIREBLOCKS_PRODUCTION_WEBHOOK_KEY", environment: "PRODUCTION" },
    ];

    beforeEach(() => {
      // A real Prisma `findMany({where:{environment}})` only returns rows
      // matching that filter — this mock reproduces that instead of
      // ignoring the where clause, so these tests actually exercise the
      // controller's own query construction, not just its post-fetch logic.
      prisma.custodyProviderConfig.findMany.mockImplementation(async ({ where }: { where: { environment?: string } }) =>
        allConfigs.filter((c) => c.environment === where.environment),
      );
      secretResolver.resolve.mockImplementation((ref: string) => {
        if (ref === "env:FIREBLOCKS_SANDBOX_WEBHOOK_KEY") return sandboxKeys.publicKey;
        if (ref === "env:FIREBLOCKS_PRODUCTION_WEBHOOK_KEY") return productionKeys.publicKey;
        throw new Error(`unexpected ref ${ref}`);
      });
    });

    it("REJECTS a webhook validly signed with a PRODUCTION key when the runtime is sandbox", async () => {
      config.get.mockReturnValue("sandbox");
      const body = JSON.stringify({ type: "T", data: { id: "fb-1", status: "COMPLETED", externalTxId: "wd-1" } });
      const signature = sign(body, productionKeys.privateKey);

      await expect(controller.handle(makeRequest(body), signature)).rejects.toThrow(UnauthorizedException);
      expect(webhookService.processWebhookPayload).not.toHaveBeenCalled();
    });

    it("REJECTS a webhook validly signed with a SANDBOX key when the runtime is production", async () => {
      config.get.mockReturnValue("production");
      const body = JSON.stringify({ type: "T", data: { id: "fb-1", status: "COMPLETED", externalTxId: "wd-1" } });
      const signature = sign(body, sandboxKeys.privateKey);

      await expect(controller.handle(makeRequest(body), signature)).rejects.toThrow(UnauthorizedException);
      expect(webhookService.processWebhookPayload).not.toHaveBeenCalled();
    });

    it("ACCEPTS a webhook signed with the SANDBOX key when the runtime is sandbox", async () => {
      config.get.mockReturnValue("sandbox");
      const body = JSON.stringify({ type: "T", data: { id: "fb-1", status: "COMPLETED", externalTxId: "wd-1" } });
      const signature = sign(body, sandboxKeys.privateKey);

      const result = await controller.handle(makeRequest(body), signature);
      expect(result).toEqual({ status: "processed" });
    });

    it("ACCEPTS a webhook signed with the PRODUCTION key when the runtime is production", async () => {
      config.get.mockReturnValue("production");
      const body = JSON.stringify({ type: "T", data: { id: "fb-1", status: "COMPLETED", externalTxId: "wd-1" } });
      const signature = sign(body, productionKeys.privateKey);

      const result = await controller.handle(makeRequest(body), signature);
      expect(result).toEqual({ status: "processed" });
    });

    it("queries only the environment this runtime requires — never fetches both", async () => {
      config.get.mockReturnValue("sandbox");
      const body = JSON.stringify({ type: "T", data: { id: "fb-1", status: "COMPLETED", externalTxId: "wd-1" } });
      const signature = sign(body, sandboxKeys.privateKey);

      await controller.handle(makeRequest(body), signature);

      expect(prisma.custodyProviderConfig.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ environment: "SANDBOX" }) }));
    });
  });
});
