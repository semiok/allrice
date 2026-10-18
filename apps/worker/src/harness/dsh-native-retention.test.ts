import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const seam = vi.hoisted(() => ({ install: vi.fn(), launch: vi.fn() }));
vi.mock('./dsh-native-artifact.js', () => ({
  installRetainedDshNativeArtifact: seam.install,
  nativeArtifactLaunchForPin: seam.launch,
}));
const old = 'dsh-0.1.5-rc.3-a4c74a9';
const frozen = 'dsh-0.1.1-rc.2-b150a55';
const id = 'sha256:' + 'a'.repeat(64);
let root: string;
beforeEach(async () => {
  vi.resetModules();
  seam.install.mockReset().mockImplementation(async (input) => ({
    artifactId: input.expectedId,
    generation: old,
    version: '0.1.5-rc.3',
    root: input.root,
  }));
  seam.launch.mockReset().mockImplementation((input) => ({
    artifactId: input.artifactId,
    generation: old,
    version: '0.1.5-rc.3',
    command: '/reviewed/node',
    args: ['/reviewed/old/entry.mjs'],
    profile: '/reviewed/old/' + input.profileId,
  }));
  root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-retention-config-')),
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
function configure() {
  vi.stubEnv('ALLRICE_DSH_RETAINED_1_ROOT', '/reviewed/old');
  vi.stubEnv('ALLRICE_DSH_RETAINED_1_ARTIFACT_ID', id);
  vi.stubEnv('ALLRICE_DSH_RETAINED_1_STORAGE_ROOT', root);
}
// Config/policy unit seam only. Real content/entry approval and compiled native
// process routing are separate acceptance probes, never inferred from this mock.
it('does not treat an unbound context as a new candidate root', async () => {
  const policy = await import('./dsh-native-retention.js');
  expect(await policy.installConfiguredDshNativeRetention()).toEqual([]);
  expect(() =>
    policy.legacyDshNativeLaunch(
      {
        artifactId: id,
        generation: 'dsh-0.2.1-rc.2-687f282',
        version: '0.2.1-rc.2',
        command: '/reviewed/node',
        args: ['/reviewed/new'],
        profile: '/reviewed/new/profile',
      },
      'restricted',
    ),
  ).toThrow('LEGACY_UNAVAILABLE');
  expect(seam.install).not.toHaveBeenCalled();
});
it('requires an explicit protected storage root before registering retained code', async () => {
  configure();
  vi.stubEnv('ALLRICE_DSH_RETAINED_1_STORAGE_ROOT', '');
  const policy = await import('./dsh-native-retention.js');
  await expect(policy.installConfiguredDshNativeRetention()).rejects.toThrow(
    'CONFIG_PAIR_REQUIRED',
  );
  expect(seam.install).not.toHaveBeenCalled();
});
it('limits frozen compatibility to the exact configured artifact and profile', async () => {
  configure();
  vi.stubEnv(
    'ALLRICE_DSH_RETAINED_1_FROZEN_PROFILES',
    JSON.stringify([{ generation: frozen, profileId: 'restricted' }]),
  );
  const policy = await import('./dsh-native-retention.js');
  await policy.installConfiguredDshNativeRetention();
  const selected = policy.legacyDshNativeLaunch(
    {
      artifactId: 'sha256:' + 'b'.repeat(64),
      generation: 'dsh-0.2.1-rc.2-687f282',
      version: '0.2.1-rc.2',
      command: '/reviewed/node',
      args: ['/reviewed/new'],
      profile: '/reviewed/new/profile',
    },
    'restricted',
  );
  expect(selected.artifactId).toBe(id);
  expect(policy.retainedDshStorageRoot(id)).toBe(root);
  expect(() =>
    policy.assertDshFrozenCompatibility(frozen, selected, 'restricted'),
  ).not.toThrow();
  expect(() =>
    policy.assertDshFrozenCompatibility(frozen, selected, 'technical'),
  ).toThrow('FROZEN_GENERATION_MISMATCH');
  expect(() =>
    policy.assertDshFrozenCompatibility(
      frozen,
      { ...selected, artifactId: 'sha256:' + 'b'.repeat(64) },
      'restricted',
    ),
  ).toThrow('FROZEN_GENERATION_MISMATCH');
  expect(() =>
    policy.assertDshFrozenCompatibility(
      'dsh-0.2.1-rc.2-687f282',
      selected,
      'restricted',
    ),
  ).toThrow('FROZEN_GENERATION_MISMATCH');
});
it('rejects new-to-old downgrade tuples before code registration', async () => {
  configure();
  vi.stubEnv(
    'ALLRICE_DSH_RETAINED_1_FROZEN_PROFILES',
    JSON.stringify([
      { generation: 'dsh-0.2.1-rc.2-687f282', profileId: 'restricted' },
    ]),
  );
  const policy = await import('./dsh-native-retention.js');
  await expect(policy.installConfiguredDshNativeRetention()).rejects.toThrow(
    'FROZEN_TUPLE',
  );
  expect(seam.install).not.toHaveBeenCalled();
});
it('does not protect a mutable symlink in place of the actual data root', async () => {
  configure();
  const alias = join(root, 'alias');
  await symlink(root, alias);
  vi.stubEnv('ALLRICE_DSH_RETAINED_1_STORAGE_ROOT', alias);
  const policy = await import('./dsh-native-retention.js');
  await expect(policy.installConfiguredDshNativeRetention()).rejects.toThrow(
    'STORAGE_ROOT',
  );
  expect(seam.install).not.toHaveBeenCalled();
});
