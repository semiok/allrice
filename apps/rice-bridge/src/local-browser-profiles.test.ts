import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BrowserProfileSchema,
  type LocalBrowserProfileBinding,
} from '@allrice/contracts';
import {
  LocalBrowserProfiles,
  validateLocalBrowserStorageState,
} from './local-browser-profiles.js';
import {
  writeCredentialRecordFile,
  readCredentialRecordFile,
  deleteCredentialRecordFile,
} from './credential-files.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const profile = BrowserProfileSchema.parse({
  version: 1,
  origins: ['https://login.example.com'],
});
const state = {
  cookies: [
    {
      name: 'session',
      value: 'synthetic-secret',
      domain: 'login.example.com',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax' as const,
    },
  ],
  origins: [
    {
      origin: 'https://login.example.com',
      localStorage: [{ name: 'owner', value: 'synthetic' }],
    },
  ],
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'allrice-p22-profile-'));
  roots.push(root);
  const binding: LocalBrowserProfileBinding = {
    version: 1,
    scope: {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      projectId: null,
    },
    ownerId: randomUUID(),
    deviceId: randomUUID(),
    grantId: randomUUID(),
    grantRevision: 1,
    logicalProfileId: randomUUID(),
    persistLogin: true,
  };
  return {
    root,
    binding,
    store: new LocalBrowserProfiles(
      join(root, 'config.json'),
      'https://saas.example',
    ),
  };
}
describe('P22 owned login state, real private files', () => {
  it('device cleanup is bounded to its private index, erases inactive login state, and is idempotent', async () => {
    const { store, binding } = await fixture();
    const other = {
      ...binding,
      deviceId: randomUUID(),
      logicalProfileId: randomUUID(),
    };
    await store.save(binding, profile, state);
    await store.save(other, profile, state);
    const otherPath = join(
      store.deviceDirectory(other.deviceId),
      `${other.logicalProfileId}.json`,
    );
    const priorOther = await readFile(otherPath, 'utf8');
    await store.revokeDevice(binding.deviceId);
    await store.revokeDevice(binding.deviceId);
    expect(
      JSON.parse(
        await readFile(
          join(
            store.deviceDirectory(binding.deviceId),
            `${binding.logicalProfileId}.json`,
          ),
          'utf8',
        ),
      ).state,
    ).toBeNull();
    expect(await readFile(otherPath, 'utf8')).toBe(priorOther);
    await expect(store.load(binding, profile)).rejects.toThrow(
      'LOCAL_BROWSER_POLICY_DENIED',
    );
    await expect(
      store.save(
        { ...binding, logicalProfileId: randomUUID() },
        profile,
        state,
      ),
    ).rejects.toThrow('LOCAL_BROWSER_POLICY_DENIED');
  });
  it('a never-created device profile directory is safely empty, but a missing index beside a profile is unsafe', async () => {
    const { store, binding } = await fixture();
    await expect(store.revokeDevice(randomUUID())).resolves.toBeUndefined();
    await store.save(binding, profile, state);
    const directory = store.deviceDirectory(binding.deviceId);
    await rm(join(directory, 'index.json'));
    await expect(store.revokeDevice(binding.deviceId)).rejects.toThrow(
      'LOCAL_BROWSER_PROFILE_UNSAFE',
    );
    expect(
      await readFile(
        join(directory, `${binding.logicalProfileId}.json`),
        'utf8',
      ),
    ).toContain('synthetic-secret');
  });
  it.each(['malformed', 'wrong-device', 'symlink'] as const)(
    'does not treat an %s index as successful cleanup',
    async (kind) => {
      const { root, store, binding } = await fixture();
      await store.save(binding, profile, state);
      const directory = store.deviceDirectory(binding.deviceId);
      if (kind === 'symlink') {
        await rm(join(directory, 'index.json'));
        await symlink(
          join(root, 'outside-index.json'),
          join(directory, 'index.json'),
        );
      } else {
        const index = JSON.parse(
          await readFile(join(directory, 'index.json'), 'utf8'),
        );
        await writeCredentialRecordFile(
          directory,
          'index.json',
          kind === 'malformed'
            ? '{'
            : JSON.stringify({ ...index, deviceId: randomUUID() }),
        );
      }
      await expect(store.revokeDevice(binding.deviceId)).rejects.toThrow();
      expect(
        await readFile(
          join(directory, `${binding.logicalProfileId}.json`),
          'utf8',
        ),
      ).toContain('synthetic-secret');
    },
  );
  it('mid-cleanup failure is not success, freezes future saves, and safely retries remaining indexed files', async () => {
    const { store, binding } = await fixture();
    const second = {
      ...binding,
      logicalProfileId: randomUUID(),
      grantId: randomUUID(),
    };
    await store.save(binding, profile, state);
    await store.save(second, profile, state);
    const directory = store.deviceDirectory(binding.deviceId);
    const firstPath = join(directory, `${binding.logicalProfileId}.json`),
      secondPath = join(directory, `${second.logicalProfileId}.json`);
    await chmod(secondPath, 0o644);
    await expect(store.revokeDevice(binding.deviceId)).rejects.toThrow();
    expect(JSON.parse(await readFile(firstPath, 'utf8')).state).toBeNull();
    expect(await readFile(secondPath, 'utf8')).toContain('synthetic-secret');
    await expect(
      store.save(
        { ...binding, logicalProfileId: randomUUID() },
        profile,
        state,
      ),
    ).rejects.toThrow('LOCAL_BROWSER_POLICY_DENIED');
    await chmod(secondPath, 0o600);
    await store.revokeDevice(binding.deviceId);
    expect(JSON.parse(await readFile(secondPath, 'utf8')).state).toBeNull();
  });
  it('limits each device index to 128 exact bindings and does not write a 129th state', async () => {
    const { store, binding } = await fixture();
    const entries = Array.from({ length: 128 }, () => ({
      binding: { ...binding, logicalProfileId: randomUUID() },
      origins: profile.origins,
    }));
    const directory = store.deviceDirectory(binding.deviceId);
    await writeCredentialRecordFile(
      directory,
      'index.json',
      JSON.stringify({
        version: 1,
        serverUrl: 'https://saas.example',
        deviceId: binding.deviceId,
        revoked: false,
        entries,
      }),
      { maxBytes: 256 * 1024 },
    );
    await expect(store.save(binding, profile, state)).rejects.toThrow(
      'LOCAL_BROWSER_PROFILE_UNSAFE',
    );
    await expect(
      readFile(join(directory, `${binding.logicalProfileId}.json`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('persists only with explicit opt-in and reads across independent store instances', async () => {
    const { root, store, binding } = await fixture();
    await store.save({ ...binding, persistLogin: false }, profile, state);
    expect(
      await store.load({ ...binding, persistLogin: false }, profile),
    ).toBeUndefined();
    await store.save(binding, profile, state);
    expect(
      (await lstat(store.deviceDirectory(binding.deviceId))).mode & 0o777,
    ).toBe(0o700);
    expect(
      (
        await lstat(
          join(
            store.deviceDirectory(binding.deviceId),
            `${binding.logicalProfileId}.json`,
          ),
        )
      ).mode & 0o777,
    ).toBe(0o600);
    expect(
      await new LocalBrowserProfiles(
        join(root, 'config.json'),
        'https://saas.example',
      ).load(binding, profile),
    ).toEqual(state);
  });
  it('rejects device, owner, organization, grant revision and server rebinding', async () => {
    const { root, store, binding } = await fixture();
    await store.save(binding, profile, state);
    for (const changed of [
      { ownerId: randomUUID() },
      { grantId: randomUUID() },
      { grantRevision: 2 },
      { scope: { ...binding.scope, organizationId: randomUUID() } },
    ])
      await expect(
        store.load({ ...binding, ...changed }, profile),
      ).rejects.toThrow('LOCAL_BROWSER_PROFILE_UNSAFE');
    expect(
      await store.load({ ...binding, deviceId: randomUUID() }, profile),
    ).toBeUndefined();
    await expect(
      new LocalBrowserProfiles(
        join(root, 'config.json'),
        'https://other.example',
      ).load(binding, profile),
    ).resolves.toBeUndefined();
  });
  it('revocation removes real cookie/localStorage content and prevents stale grant resurrection', async () => {
    const { store, binding } = await fixture();
    await store.save(binding, profile, state);
    await store.revoke(binding);
    const text = await readFile(
      join(
        store.deviceDirectory(binding.deviceId),
        `${binding.logicalProfileId}.json`,
      ),
      'utf8',
    );
    expect(text).not.toContain('synthetic-secret');
    expect(JSON.parse(text).state).toBeNull();
    await expect(store.save(binding, profile, state)).rejects.toThrow(
      'LOCAL_BROWSER_POLICY_DENIED',
    );
    await expect(store.load(binding, profile)).rejects.toThrow(
      'LOCAL_BROWSER_POLICY_DENIED',
    );
    const fresh = {
      ...binding,
      grantId: randomUUID(),
      logicalProfileId: randomUUID(),
    };
    await store.save(fresh, profile, state);
    expect(await store.load(fresh, profile)).toEqual(state);
  });
  it('does not treat an unsafe file as a successful revoke or overwrite its target', async () => {
    const { root, store, binding } = await fixture();
    await store.save(binding, profile, state);
    const path = join(
      store.deviceDirectory(binding.deviceId),
      `${binding.logicalProfileId}.json`,
    );
    await chmod(path, 0o644);
    await expect(store.revoke(binding)).rejects.toThrow(
      'LOCAL_BROWSER_PROFILE_UNSAFE',
    );
    await chmod(path, 0o600);
    await rm(path);
    const target = join(root, 'synthetic.json');
    await symlink(target, path);
    await expect(store.load(binding, profile)).rejects.toThrow(
      'LOCAL_BROWSER_PROFILE_UNSAFE',
    );
  });
  it('rejects imported state for unapproved origins, unknown storage and private-cookie errors without values', () => {
    for (const invalid of [
      {
        ...state,
        origins: [{ origin: 'https://foreign.example', localStorage: [] }],
      },
      { ...state, indexedDB: 'synthetic-secret' },
      {
        ...state,
        cookies: [{ ...state.cookies[0], domain: 'foreign.example' }],
      },
    ])
      expect(() =>
        validateLocalBrowserStorageState(invalid, profile.origins),
      ).toThrow('LOCAL_BROWSER_PROFILE_UNSAFE');
  });
  it('supports bounded larger browser state without weakening default B4 credential limits', async () => {
    const { root } = await fixture();
    const dir = join(root, 'private');
    const content = 's'.repeat(20000);
    await expect(
      writeCredentialRecordFile(dir, 'state.json', content),
    ).rejects.toThrow('BRIDGE_CREDENTIAL_FILE_UNSAFE');
    await writeCredentialRecordFile(dir, 'state.json', content, {
      maxBytes: 256 * 1024,
    });
    await expect(readCredentialRecordFile(dir, 'state.json')).rejects.toThrow(
      'BRIDGE_CREDENTIAL_FILE_UNSAFE',
    );
    expect(
      await readCredentialRecordFile(dir, 'state.json', {
        maxBytes: 256 * 1024,
      }),
    ).toBe(content);
    await expect(deleteCredentialRecordFile(dir, 'state.json')).rejects.toThrow(
      'BRIDGE_CREDENTIAL_FILE_UNSAFE',
    );
    await deleteCredentialRecordFile(dir, 'state.json', {
      maxBytes: 256 * 1024,
    });
    expect(await readCredentialRecordFile(dir, 'state.json')).toBeNull();
  });
});
