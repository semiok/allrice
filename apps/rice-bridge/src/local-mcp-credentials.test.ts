import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  rm,
  chmod,
  lstat,
  readFile,
  symlink,
  link,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  localMcpCredentialDirectory,
  storeLocalMcpCredential,
  readLocalMcpCredential,
  revokeLocalMcpCredential,
  localMcpCredentialCli,
  type LocalMcpCredentialBinding,
} from './local-mcp-credentials.js';

let directory: string, binding: LocalMcpCredentialBinding;
const token = 'synthetic-local-token-"quoted"';
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'allrice-p17-credentials-'));
  vi.stubEnv('ALLRICE_BRIDGE_CONFIG_PATH', join(directory, 'config.json'));
  binding = {
    server: 'https://synthetic.example',
    deviceId: randomUUID(),
    connectionId: randomUUID(),
    sourceDigest: `sha256:${'1'.repeat(64)}`,
    reference: { id: randomUUID(), revision: 1 },
  };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const recordPath = async () =>
  join(
    await localMcpCredentialDirectory(),
    `${binding.reference.id}-${binding.reference.revision}.json`,
  );

describe('P17 explicit private-file local MCP credential lifecycle', () => {
  it('creates only owned private storage with precise binding and immutable revision', async () => {
    await storeLocalMcpCredential(binding, token);
    expect(await readLocalMcpCredential(binding)).toBe(token);
    expect(
      (await lstat(await localMcpCredentialDirectory())).mode & 0o777,
    ).toBe(0o700);
    expect((await lstat(await recordPath())).mode & 0o777).toBe(0o600);
    const before = await lstat(await recordPath());
    await storeLocalMcpCredential(binding, token);
    expect((await lstat(await recordPath())).ino).toBe(before.ino);
    await expect(
      storeLocalMcpCredential(binding, 'different-synthetic-token'),
    ).rejects.toThrow('LOCAL_MCP_CREDENTIAL_REVISION_EXISTS');
  });
  it.each(['server', 'deviceId', 'connectionId', 'sourceDigest'] as const)(
    'never reads a credential under a different %s binding',
    async (field) => {
      await storeLocalMcpCredential(binding, token);
      const replacement =
        field === 'server'
          ? 'https://other.example'
          : field === 'sourceDigest'
            ? `sha256:${'2'.repeat(64)}`
            : randomUUID();
      await expect(
        readLocalMcpCredential({ ...binding, [field]: replacement }),
      ).rejects.toThrow('LOCAL_MCP_CREDENTIAL_UNAVAILABLE');
      expect(await readLocalMcpCredential(binding)).toBe(token);
    },
  );
  it('writes an irreversible revision tombstone, without claiming cloud revocation or secure erase', async () => {
    await storeLocalMcpCredential(binding, token);
    expect(await revokeLocalMcpCredential(binding)).toEqual({
      localCredentialRevoked: true,
      cloudConnectionRevoked: false,
      storage: 'private-file-unencrypted',
    });
    expect(await readFile(await recordPath(), 'utf8')).not.toContain(token);
    await expect(readLocalMcpCredential(binding)).rejects.toThrow(
      'LOCAL_MCP_CREDENTIAL_REVOKED',
    );
    await expect(storeLocalMcpCredential(binding, token)).rejects.toThrow(
      'LOCAL_MCP_CREDENTIAL_REVISION_EXISTS',
    );
    await storeLocalMcpCredential(
      { ...binding, reference: { ...binding.reference, revision: 2 } },
      token,
    );
  });
  it('missing references revoke to tombstones and cannot later be installed', async () => {
    await expect(readLocalMcpCredential(binding)).rejects.toThrow(
      'LOCAL_MCP_CREDENTIAL_UNAVAILABLE',
    );
    await revokeLocalMcpCredential(binding);
    await expect(storeLocalMcpCredential(binding, token)).rejects.toThrow(
      'LOCAL_MCP_CREDENTIAL_REVISION_EXISTS',
    );
  });
  it.each([
    'directory-mode',
    'file-mode',
    'file-symlink',
    'file-hardlink',
    'directory-symlink',
  ])(
    'refuses unsafe storage and cannot falsely claim cleanup: %s',
    async (scenario) => {
      await storeLocalMcpCredential(binding, token);
      const path = await recordPath(),
        vault = await localMcpCredentialDirectory();
      if (scenario === 'directory-mode') await chmod(vault, 0o755);
      if (scenario === 'file-mode') await chmod(path, 0o644);
      if (scenario === 'file-hardlink')
        await link(path, join(directory, 'alias'));
      if (scenario === 'file-symlink') {
        await rm(path);
        await writeFile(join(directory, 'outside'), token);
        await symlink(join(directory, 'outside'), path);
      }
      if (scenario === 'directory-symlink') {
        await rm(vault, { recursive: true });
        await symlink(directory, vault);
      }
      await expect(readLocalMcpCredential(binding)).rejects.toThrow(
        'LOCAL_MCP_CREDENTIAL_UNAVAILABLE',
      );
      await expect(revokeLocalMcpCredential(binding)).rejects.toThrow(
        'LOCAL_MCP_CREDENTIAL_UNAVAILABLE',
      );
    },
  );
  it('does not echo tokens, paths or underlying errors on invalid input/CLI failures', async () => {
    for (const value of ['\n' + token, 'x'.repeat(4097)]) {
      const error = await storeLocalMcpCredential(binding, value).catch(
        (error) => error as Error,
      );
      expect(String(error)).toBe('Error: LOCAL_MCP_CREDENTIAL_UNAVAILABLE');
      expect(String(error)).not.toContain(value);
    }
    await expect(
      localMcpCredentialCli([
        'credential',
        'set',
        binding.connectionId,
        binding.sourceDigest,
        binding.reference.id,
        '1',
        '--private-file-unencrypted',
      ]),
    ).rejects.toThrow(/^LOCAL_MCP_CREDENTIAL_UNAVAILABLE$/);
    await expect(
      localMcpCredentialCli(['credential', 'set', token]),
    ).rejects.toThrow(/^LOCAL_MCP_CREDENTIAL_MISMATCH$/);
  });
});
