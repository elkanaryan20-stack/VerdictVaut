import { Injectable, InternalServerErrorException } from "@nestjs/common";

/**
 * Resolves a `credentialsSecretRef`/`webhookSecretRef` value (see
 * secret-ref.validator.ts's "scheme:path" format) into the ACTUAL
 * secret content — the one place in the codebase allowed to do that.
 *
 * Phase 14B scope: only the `env:` scheme is actually implemented
 * (reads `process.env[VAR_NAME]`), matching what a real local/CI/
 * container-injected-env deployment already needs with zero new
 * dependencies. `secretsmanager:`/`vault:`/`doppler:`/`ssm:` are
 * legitimate REFERENCE FORMATS (already accepted by
 * secret-ref.validator.ts so an admin can record intent/where a secret
 * SHOULD live even before this is wired up) but resolving them for real
 * requires integrating that provider's own SDK — not done here. Using
 * one of those schemes today fails closed with a clear "not
 * implemented" error rather than silently returning nothing or, worse,
 * treating the reference string itself as if it were the secret.
 */
@Injectable()
export class SecretResolverService {
  resolve(ref: string): string {
    const separatorIndex = ref.indexOf(":");
    const scheme = ref.slice(0, separatorIndex);
    const path = ref.slice(separatorIndex + 1);

    if (scheme === "env") {
      const value = process.env[path];
      if (!value) {
        throw new InternalServerErrorException(`Secret reference "${ref}" points to environment variable "${path}", which is not set.`);
      }
      return value;
    }

    throw new InternalServerErrorException(
      `Secret reference scheme "${scheme}:" is a recognized reference FORMAT but resolving it is not implemented yet ` +
        `(only "env:" is currently wired up) — refusing to guess at a secret value rather than failing loudly.`,
    );
  }
}
