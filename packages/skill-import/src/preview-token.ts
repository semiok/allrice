import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  PersonalSkillPreviewAttestationSchema as previewSchema,
  personalSkillLimits,
  type PersonalSkillPreviewAttestation as SkillPreview,
} from '@allrice/contracts';
export { PersonalSkillPreviewTargetSchema as skillPreviewTargetSchema } from '@allrice/contracts';
export type { PersonalSkillPreviewAttestation as SkillPreview } from '@allrice/contracts';

export class SkillPreviewError extends Error {
  constructor(
    readonly code:
      | 'preview_invalid'
      | 'preview_expired'
      | 'source_invalid'
      | 'version_conflict'
      | 'name_mismatch',
  ) {
    super(code);
  }
}

/** A source attestation, never a write grant. Confirmation must recheck current
 * owner/instance authority, the exact attested bytes and all mutation guards.
 * Domain separation prevents ordinary signed file URLs from becoming previews. */
export class SkillPreviewTokens {
  constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret) < 32)
      throw new Error('storage signing secret must contain at least 32 bytes');
  }

  private signature(payload: string, archive: string) {
    return createHmac('sha256', this.secret)
      .update('allrice:personal-skill-preview:v1\n')
      .update(payload)
      .update('.')
      .update(archive)
      .digest();
  }

  issue(input: SkillPreview, bytes: Uint8Array) {
    const value = previewSchema.parse(input);
    if (
      bytes.byteLength > personalSkillLimits.archiveBytes ||
      value.source.byteLength !== bytes.byteLength ||
      value.digest !== checksum(bytes) ||
      value.source.originalChecksum !== value.digest
    )
      throw new SkillPreviewError('source_invalid');
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    const archive = Buffer.from(bytes).toString('base64url');
    return `${payload}.${archive}.${this.signature(payload, archive).toString('base64url')}`;
  }

  verify(
    token: string,
    scope: {
      organizationId: string;
      workspaceId: string;
      ownerId: string;
      instanceId: string;
      digest: string;
    },
    now = Date.now(),
  ) {
    const invalid = () => {
      throw new SkillPreviewError('preview_invalid');
    };
    // Stateless preview: exact source bytes remain in the browser until a
    // separate confirmation. No temporary database rows or cleanup lifecycle.
    const maximumArchive = Math.ceil(
      (personalSkillLimits.archiveBytes * 4) / 3,
    );
    if (token.length > maximumArchive + 32_768 + 45) return invalid();
    const [payload, archive, signature, extra] = token.split('.');
    if (
      !payload ||
      !archive ||
      !signature ||
      extra ||
      payload.length > 32_768 ||
      archive.length > maximumArchive
    )
      return invalid();
    const actual = Buffer.from(signature, 'base64url');
    const expected = this.signature(payload, archive);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return invalid();
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return invalid();
    }
    const parsed = previewSchema.safeParse(decoded);
    if (!parsed.success) return invalid();
    const value = parsed.data;
    if (
      value.organizationId !== scope.organizationId ||
      value.workspaceId !== scope.workspaceId ||
      value.ownerId !== scope.ownerId ||
      value.instanceId !== scope.instanceId ||
      value.digest !== scope.digest
    )
      return invalid();
    if (Date.parse(value.expiresAt) <= now)
      throw new SkillPreviewError('preview_expired');
    const bytes = Buffer.from(archive, 'base64url');
    if (
      bytes.toString('base64url') !== archive ||
      bytes.byteLength > personalSkillLimits.archiveBytes ||
      bytes.byteLength !== value.source.byteLength ||
      checksum(bytes) !== value.digest ||
      value.source.originalChecksum !== value.digest
    )
      return invalid();
    return { preview: value, bytes };
  }
}

const checksum = (bytes: Uint8Array) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
