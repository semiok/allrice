import {
  mkdtemp,
  writeFile,
  readFile,
  stat,
  chmod,
  rm,
  symlink,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getGeminiCredentialStatus,
  saveGeminiCredential,
  validateGeminiApiKey,
} from './gemini-credential-store';
import { DeploymentDshCredentialResolver } from '../../../worker/src/harness/dsh-credential-resolver';

const key = 'SYNTHETIC_GEMINI_KEY_FOR_LOCAL_TESTS';
let directory: string;
let path: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'allrice-gemini-credential-'));
  path = join(directory, 'credentials.json');
  vi.stubEnv('ALLRICE_DSH_CREDENTIALS_FILE', path);
  vi.stubEnv('ALLRICE_DSH_CREDENTIALS_JSON', '');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe('Gemini private credential storage', () => {
  it('reports missing binding, persists and resolves through the real Worker resolver', async () => {
    expect(await getGeminiCredentialStatus()).toEqual({
      configured: false,
      writable: true,
      updatedAt: null,
    });
    const saved = await saveGeminiCredential(` ${key} `, 'admin-id');
    expect(saved.configured).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await getGeminiCredentialStatus()).toEqual(saved);
    const resolver = new DeploymentDshCredentialResolver();
    await expect(
      resolver.resolve({
        reference: 'deployment:gemini-default',
        organizationId: 'org',
        workspaceId: 'ws',
        ownerId: 'owner',
        route: 'gemini',
      }),
    ).resolves.toEqual({ apiKey: key });
    expect(JSON.stringify(saved)).not.toContain(key);
    expect(await readdir(directory)).toEqual(['credentials.json']);
  });
  it('replaces only Gemini and preserves unrelated credential bindings', async () => {
    const unrelated = {
      scope: 'deployment',
      apiKey: 'UNRELATED_SYNTHETIC_SECRET',
    };
    await writeFile(path, JSON.stringify({ 'deployment:other': unrelated }), {
      mode: 0o600,
    });
    await saveGeminiCredential(key, 'admin-id');
    await saveGeminiCredential(`${key}_REPLACED`, 'admin-id');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved['deployment:other']).toEqual(unrelated);
    expect(saved['deployment:gemini-default'].apiKey).toBe(`${key}_REPLACED`);
    expect(saved['deployment:gemini-default'].updatedBy).toBe('admin-id');
  });
  it.each([
    '',
    '   ',
    'short',
    `${key}\n`,
    `${key}\nrun`,
    'x'.repeat(257),
    'curl --key anything',
    '<script>not-a-key</script>',
  ])('rejects invalid key without echoing input (%#)', async (value) => {
    expect(() => validateGeminiApiKey(value)).toThrow('invalid_key');
    await expect(saveGeminiCredential(value, 'admin-id')).rejects.toThrow(
      'invalid_key',
    );
    expect(await readdir(directory)).toEqual([]);
  });
  it('refuses inline directory shadowing file storage', async () => {
    vi.stubEnv('ALLRICE_DSH_CREDENTIALS_JSON', '{}');
    await expect(getGeminiCredentialStatus()).rejects.toThrow('unavailable');
    await expect(saveGeminiCredential(key, 'admin-id')).rejects.toThrow(
      'unavailable',
    );
  });
  it('refuses missing or relative deployment paths', async () => {
    for (const value of ['', 'relative.json']) {
      vi.stubEnv('ALLRICE_DSH_CREDENTIALS_FILE', value);
      await expect(saveGeminiCredential(key, 'admin-id')).rejects.toThrow(
        'unavailable',
      );
    }
  });
  it('refuses permissive files and leaves original content untouched', async () => {
    await writeFile(path, '{}', { mode: 0o644 });
    await expect(saveGeminiCredential(key, 'admin-id')).rejects.toThrow(
      'unavailable',
    );
    expect(await readFile(path, 'utf8')).toBe('{}');
  });
  it('refuses a group-writable parent', async () => {
    await chmod(directory, 0o770);
    await expect(saveGeminiCredential(key, 'admin-id')).rejects.toThrow(
      'unavailable',
    );
  });
  it('refuses symlinks instead of following them', async () => {
    const target = join(directory, 'target.json');
    await writeFile(target, '{}', { mode: 0o600 });
    await symlink(target, path);
    await expect(saveGeminiCredential(key, 'admin-id')).rejects.toThrow(
      'unavailable',
    );
    expect(await readFile(target, 'utf8')).toBe('{}');
  });
  it.each([
    '[]',
    'null',
    '{broken secret',
    '{"deployment:gemini-default":{"scope":"tenant","apiKey":"secret"}}',
  ])(
    'does not overwrite malformed or differently scoped directories (%#)',
    async (encoded) => {
      await writeFile(path, encoded, { mode: 0o600 });
      await expect(saveGeminiCredential(key, 'admin-id')).rejects.toThrow(
        'unavailable',
      );
      expect(await readFile(path, 'utf8')).toBe(encoded);
    },
  );
  it('returns a conflict if another writer holds the lock, leaving that lock intact', async () => {
    await writeFile(`${path}.lock`, '', { mode: 0o600 });
    await expect(saveGeminiCredential(key, 'admin-id')).rejects.toThrow('busy');
    expect(await readdir(directory)).toEqual(['credentials.json.lock']);
  });
  it('never produces a partial directory under simultaneous saves', async () => {
    const results = await Promise.allSettled([
      saveGeminiCredential(key, 'first'),
      saveGeminiCredential(`${key}_SECOND`, 'second'),
    ]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect([key, `${key}_SECOND`]).toContain(
      saved['deployment:gemini-default'].apiKey,
    );
    expect(await readdir(directory)).toEqual(['credentials.json']);
  });
});
