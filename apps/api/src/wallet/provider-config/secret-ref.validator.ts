import { BadRequestException } from "@nestjs/common";

// "scheme:path" — e.g. "env:FIREBLOCKS_API_KEY" or
// "secretsmanager:prod/fireblocks/api-key" — never a bare value, which
// is what pasting an actual secret in by mistake would look like. This
// does not prove the value is safe (a determined admin could still pick
// a scheme-shaped string and put a secret after the colon), but it
// categorically rejects the common mistake of pasting a raw API
// key/token with no scheme prefix at all. Mirrored as a DB CHECK
// constraint (see the Phase 14A migration) so a direct write bypassing
// this service is caught too.
const SECRET_REF_PATTERN = /^(env|secretsmanager|vault|doppler|ssm):\S+$/;

export function assertValidSecretRef(value: string | undefined | null, fieldName: string): void {
  if (value == null) return;
  if (!SECRET_REF_PATTERN.test(value)) {
    throw new BadRequestException(
      `${fieldName} must be a reference in "scheme:path" form (env|secretsmanager|vault|doppler|ssm:...) pointing to where the real secret lives — never the secret value itself.`,
    );
  }
}
