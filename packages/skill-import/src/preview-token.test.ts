import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SkillPreviewTokens, type SkillPreview } from './preview-token.ts';

const secret = 'synthetic-preview-test-key-0000000000';
const tokens = new SkillPreviewTokens(secret);
function fixture() {
  const bytes = Buffer.from('synthetic source bytes');
  const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  const scope = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    instanceId: randomUUID(),
    digest,
  };
  const preview: SkillPreview = {
    schemaVersion: 1,
    ...scope,
    source: {
      kind: 'zip',
      fileName: 'weekly.zip',
      originalChecksum: digest,
      byteLength: bytes.length,
    },
    sourcePath: 'SKILL.md',
    target: { operation: 'install' },
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
  return { bytes, scope, preview, token: tokens.issue(preview, bytes) };
}

describe('exact browser preview source attestation', () => {
  it('binds an update to the complete impact digest without changing the source digest', () => {
    const f = fixture();
    const target = {
      operation: 'update' as const,
      installationId: randomUUID(),
      expectedRevision: 1,
      expectedVersionId: randomUUID(),
      bindingsDigest: 'sha256:' + 'a'.repeat(64),
    };
    const token = tokens.issue({ ...f.preview, target }, f.bytes);
    const verified = tokens.verify(token, f.scope);
    expect(verified.preview.target).toEqual(target);
    expect(verified.preview.digest).toBe(f.scope.digest);
    const [, archive, signature] = token.split('.');
    const changed = Buffer.from(
      JSON.stringify({
        ...f.preview,
        target: { ...target, bindingsDigest: 'sha256:' + 'b'.repeat(64) },
      }),
    ).toString('base64url');
    expect(() =>
      tokens.verify(`${changed}.${archive}.${signature}`, f.scope),
    ).toThrow('preview_invalid');
  });
  it('recovers the exact bytes and structured target without fetching or storing', () => {
    const f = fixture();
    expect(tokens.verify(f.token, f.scope)).toEqual({
      preview: f.preview,
      bytes: f.bytes,
    });
  });
  it.each(['organizationId', 'workspaceId', 'ownerId', 'instanceId'] as const)(
    'rejects another %s',
    (key) => {
      const f = fixture();
      expect(() =>
        tokens.verify(f.token, { ...f.scope, [key]: randomUUID() }),
      ).toThrow('preview_invalid');
    },
  );
  it('rejects a changed digest, target, source bytes or signing key', () => {
    const f = fixture();
    expect(() =>
      tokens.verify(f.token, {
        ...f.scope,
        digest: 'sha256:' + '0'.repeat(64),
      }),
    ).toThrow('preview_invalid');
    const [payload, archive, signature] = f.token.split('.');
    const changed = Buffer.from(
      JSON.stringify({
        ...f.preview,
        target: {
          operation: 'update',
          installationId: randomUUID(),
          expectedRevision: 2,
          expectedVersionId: randomUUID(),
        },
      }),
    ).toString('base64url');
    for (const forged of [
      `${changed}.${archive}.${signature}`,
      `${payload}.${Buffer.from('different').toString('base64url')}.${signature}`,
    ])
      expect(() => tokens.verify(forged, f.scope)).toThrow('preview_invalid');
    expect(() =>
      new SkillPreviewTokens('another-synthetic-key-0000000000000').verify(
        f.token,
        f.scope,
      ),
    ).toThrow('preview_invalid');
  });
  it('rejects expiration and a regular signed download token', () => {
    const f = fixture();
    expect(() =>
      tokens.verify(f.token, f.scope, Date.parse(f.preview.expiresAt)),
    ).toThrow('preview_expired');
    expect(() =>
      tokens.verify('download-payload.download-signature', f.scope),
    ).toThrow('preview_invalid');
  });
  it('does not issue a source claim for different bytes', () => {
    const f = fixture();
    expect(() => tokens.issue(f.preview, Buffer.from('changed'))).toThrow(
      'source_invalid',
    );
  });
});
