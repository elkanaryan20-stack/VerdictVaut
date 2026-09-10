import { BadRequestException, Controller, Headers, HttpCode, Post, RawBodyRequest, Req, UnauthorizedException } from "@nestjs/common";
import { Request } from "express";
import { ConfigService } from "@nestjs/config";
import { Throttle } from "@nestjs/throttler";
import { AppConfig } from "../../../config/configuration";
import { PrismaService } from "../../../prisma/prisma.service";
import { PROVIDER_WEBHOOK_THROTTLE } from "../../../common/throttle-presets";
import { SecretResolverService } from "../../provider-config/secret-resolver.service";
import { requiredProviderConfigEnvironment } from "../../provider-config/provider-environment.util";
import { verifyFireblocksWebhookSignature } from "./fireblocks-webhook-verifier.util";
import { FireblocksWebhookEnvelope, FireblocksWebhookService } from "./fireblocks-webhook.service";

/**
 * A real external webhook endpoint — deliberately OUTSIDE JwtAuthGuard
 * (Fireblocks is not a logged-in VerdictVaut user; its own request
 * signature IS the authentication mechanism, per
 * https://developers.fireblocks.com/reference/validating-webhooks,
 * Phase 14B research pass). Never trusts the payload's own claimed
 * status without that signature check passing first — see the
 * unconditional signature verification below, which runs before the
 * body is even parsed as JSON.
 *
 * The verification PUBLIC key is resolved from whichever
 * CustodyProviderConfig(s) currently have a Fireblocks providerName and
 * a webhookSecretRef configured, RESTRICTED to configs whose own
 * `environment` matches what this running process requires (Security
 * review finding A1) — deliberately checked against EVERY such config
 * within that environment (there may legitimately be more than one,
 * e.g. one per Fireblocks workspace) rather than assuming a single
 * global key, since nothing in the request itself names which config it
 * belongs to. Without this environment filter, a webhook validly signed
 * with a PRODUCTION Fireblocks key could be accepted and processed by a
 * sandbox-running process (or vice versa) purely because both configs
 * happen to exist in the same database.
 */
@Controller("webhooks/fireblocks")
@Throttle(PROVIDER_WEBHOOK_THROTTLE)
export class FireblocksWebhookController {
  constructor(
    private readonly webhookService: FireblocksWebhookService,
    private readonly prisma: PrismaService,
    private readonly secretResolver: SecretResolverService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Post()
  @HttpCode(200)
  async handle(@Req() req: RawBodyRequest<Request>, @Headers("fireblocks-signature") signature: string | undefined): Promise<{ status: string }> {
    if (!signature) {
      throw new UnauthorizedException("Missing Fireblocks-Signature header.");
    }
    if (!req.rawBody) {
      // Should never happen given rawBody:true in main.ts — fail loudly
      // rather than silently treating an unverifiable body as trusted.
      throw new BadRequestException("Raw request body was not captured — cannot verify signature.");
    }

    const rawBody = req.rawBody.toString("utf8");
    const verified = await this.verifyAgainstAnyConfiguredKey(rawBody, signature);
    if (!verified) {
      throw new UnauthorizedException("Fireblocks webhook signature verification failed.");
    }

    let payload: FireblocksWebhookEnvelope;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new BadRequestException("Webhook body is not valid JSON.");
    }

    const outcome = await this.webhookService.processWebhookPayload(payload);
    return { status: outcome };
  }

  private async verifyAgainstAnyConfiguredKey(rawBody: string, signature: string): Promise<boolean> {
    const appEnvironment = this.config.get("appEnvironment", { infer: true });
    const configs = await this.prisma.custodyProviderConfig.findMany({
      where: {
        providerName: { equals: "Fireblocks", mode: "insensitive" },
        webhookSecretRef: { not: null },
        // Security review finding A1 — never verify against a webhook
        // key belonging to a different runtime environment.
        environment: requiredProviderConfigEnvironment(appEnvironment),
      },
    });
    for (const config of configs) {
      try {
        const publicKeyPem = this.secretResolver.resolve(config.webhookSecretRef!);
        if (verifyFireblocksWebhookSignature(rawBody, signature, publicKeyPem)) {
          return true;
        }
      } catch {
        // Unresolvable secret ref for this particular config — try the next one, never crash the request over it.
      }
    }
    return false;
  }
}
