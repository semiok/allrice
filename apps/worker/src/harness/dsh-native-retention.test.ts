import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const seam = vi.hoisted(() => ({
  install: vi.fn(),
  launch: vi.fn(),
  coverage: vi.fn(),
}));
vi.mock('@allrice/database', () => ({
  verifyNativeArtifactReferenceCoverage: seam.coverage,
}));
vi.mock('./dsh-native-artifact.js', () => ({
  installRetainedDshNativeArtifact: seam.install,
  nativeArtifactLaunchForPin: seam.launch,
}));
const old = 'dsh-0.1.5-rc.3-a4c74a9';
const frozen = 'dsh-0.1.1-rc.2-b150a55';
const id = 'sha256:' + 'a'.repeat(64);
const current = 'dsh-0.2.1-rc.2-687f282';
const retainedCurrentId = 'sha256:' + 'c'.repeat(64);
let root: string;
beforeEach(async () => {
  vi.resetModules();
  seam.coverage
    .mockReset()
    .mockResolvedValue({ verified: true, references: [] });
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
it('projects the actual installed-primary return shape into the strict reference approval contract', async () => {
  vi.stubEnv('ALLRICE_DSH_RUNTIME_ROOT', root);
  vi.stubEnv('ALLRICE_EXECUTION_ROOT', undefined);
  const policy = await import('./dsh-native-retention.js');
  const installed = {
    artifactId: id,
    generation: current,
    verified: true,
    verificationMs: 18,
  };
  await policy.verifyConfiguredDshNativeReferences(installed);
  expect(seam.coverage).toHaveBeenCalledWith([
    {
      artifactId: id,
      generation: current,
      storageRoot: root,
      previewStorageRoot: resolve(
        '.local/executions',
        'platform-employee-tests',
      ),
    },
  ]);
});
function configureCurrent() {
  configure();
  vi.stubEnv('ALLRICE_DSH_RETAINED_2_ROOT', '/reviewed/current-a');
  vi.stubEnv('ALLRICE_DSH_RETAINED_2_ARTIFACT_ID', retainedCurrentId);
  vi.stubEnv('ALLRICE_DSH_RETAINED_2_STORAGE_ROOT', root);
  vi.stubEnv('ALLRICE_DSH_RETAINED_2_SOURCE_SHA', 'd'.repeat(40));
  vi.stubEnv('ALLRICE_DSH_RETAINED_2_SOURCE_TREE', 'e'.repeat(40));
  seam.install.mockImplementation(async (input) => ({
    artifactId: input.expectedId,
    generation: input.expectedId === retainedCurrentId ? current : old,
    root: input.root,
  }));
  seam.launch.mockImplementation((input) => ({
    artifactId: input.artifactId,
    generation: input.artifactId === retainedCurrentId ? current : old,
    version:
      input.artifactId === retainedCurrentId ? '0.2.1-rc.2' : '0.1.5-rc.3',
    command: '/reviewed/node',
    args: ['/reviewed/current-a/entry.mjs'],
    profile: '/reviewed/current-a/' + input.profileId,
  }));
}
it('projects only the existing execution root and fixed employee-preview directory into reference coverage', async () => {
  configureCurrent();
  vi.stubEnv('ALLRICE_DSH_RUNTIME_ROOT', root);
  vi.stubEnv('ALLRICE_EXECUTION_ROOT', root + '/executions');
  const policy = await import('./dsh-native-retention.js');
  await policy.installConfiguredDshNativeRetention();
  await policy.verifyConfiguredDshNativeReferences({
    artifactId: 'sha256:' + 'b'.repeat(64),
    generation: current,
  });
  const approved = seam.coverage.mock.calls[0]![0];
  expect(approved).toHaveLength(3);
  expect(
    approved.every(
      (a: { previewStorageRoot: string }) =>
        a.previewStorageRoot === root + '/executions/platform-employee-tests',
    ),
  ).toBe(true);
});
it.each(['sha256:' + 'b'.repeat(64), undefined])(
  'fulfils an approved origin A after new births switch to %s, without replacing its storage or frozen family',
  async (newRoot) => {
    configureCurrent();
    vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', newRoot);
    const policy = await import('./dsh-native-retention.js');
    const entries = await policy.installConfiguredDshNativeRetention();
    expect(entries[1]).toMatchObject({
      artifactId: retainedCurrentId,
      generation: current,
      sourceSha: 'd'.repeat(40),
      sourceTree: 'e'.repeat(40),
    });
    expect(seam.install).toHaveBeenCalledWith({
      root: '/reviewed/current-a',
      expectedId: retainedCurrentId,
      sourceSha: 'd'.repeat(40),
      sourceTree: 'e'.repeat(40),
    });
    const origin = {
      schemaVersion: 1 as const,
      contextKind: 'experience_consolidation' as const,
      contextId: '10000000-0000-4000-8000-000000000001',
      rootSeed: 'experience-10000000-0000-4000-8000-000000000001',
      artifactId: retainedCurrentId,
      distributionGeneration: current as 'dsh-0.2.1-rc.2-687f282',
      profileId: 'restricted' as const,
      frozenIdentity: {
        kind: 'internal_recipe' as const,
        checksum: 'sha256:' + 'f'.repeat(64),
      },
    };
    const selected = policy.originDshNativeLaunch(origin, 'restricted');
    expect(selected.artifactId).toBe(retainedCurrentId);
    expect(policy.retainedDshStorageRoot(selected.artifactId)).toBe(root);
    expect(
      policy.legacyDshNativeLaunch(selected, 'restricted').artifactId,
    ).toBe(id);
    expect(() =>
      policy.assertDshFrozenCompatibility(frozen, selected, 'restricted'),
    ).toThrow('FROZEN_GENERATION_MISMATCH');
    expect(() =>
      policy.originDshNativeLaunch(
        { ...origin, profileId: 'technical' },
        'restricted',
      ),
    ).toThrow('ORIGIN_APPROVAL');
    seam.launch.mockImplementation(() => {
      throw Error('DSH_NATIVE_ARTIFACT_PIN_NOT_APPROVED');
    });
    expect(() => policy.originDshNativeLaunch(origin, 'restricted')).toThrow(
      'PIN_NOT_APPROVED',
    );
  },
);
it('requires independent original provenance for additional retained slots', async () => {
  configureCurrent();
  vi.stubEnv('ALLRICE_DSH_RETAINED_2_SOURCE_SHA', '');
  const policy = await import('./dsh-native-retention.js');
  await expect(policy.installConfiguredDshNativeRetention()).rejects.toThrow(
    'SOURCE_PAIR_REQUIRED',
  );
  expect(seam.install).toHaveBeenCalledTimes(1);
});
it('does not grant the legacy frozen exception to a current-generation artifact', async () => {
  configureCurrent();
  vi.stubEnv(
    'ALLRICE_DSH_RETAINED_2_FROZEN_PROFILES',
    JSON.stringify([{ generation: frozen, profileId: 'restricted' }]),
  );
  const policy = await import('./dsh-native-retention.js');
  await expect(policy.installConfiguredDshNativeRetention()).rejects.toThrow(
    'FROZEN_TUPLE',
  );
});
it.each([current, 'dsh-unreviewed'])(
  'keeps slot one legacy-only, refusing %s',
  async (generation) => {
    configureCurrent();
    seam.install.mockResolvedValue({
      artifactId: id,
      generation,
      root: '/reviewed/old',
    });
    const policy = await import('./dsh-native-retention.js');
    await expect(policy.installConfiguredDshNativeRetention()).rejects.toThrow(
      'GENERATION',
    );
  },
);
it('refuses an unknown generation in additional slots', async () => {
  configureCurrent();
  seam.install.mockImplementation(async (input) => ({
    artifactId: input.expectedId,
    generation: input.expectedId === id ? old : 'dsh-unreviewed',
    root: input.root,
  }));
  const policy = await import('./dsh-native-retention.js');
  await expect(policy.installConfiguredDshNativeRetention()).rejects.toThrow(
    'GENERATION',
  );
});
it('rejects a sixth slot rather than silently dropping history', async () => {
  vi.stubEnv('ALLRICE_DSH_RETAINED_6_ROOT', '/reviewed/excess');
  const policy = await import('./dsh-native-retention.js');
  await expect(policy.installConfiguredDshNativeRetention()).rejects.toThrow(
    'SLOT_LIMIT',
  );
  expect(seam.install).not.toHaveBeenCalled();
});
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

it('keeps five exact historical readers beside a distinct primary without evicting slot one', async () => {
  configure();
  const ids = [
    id,
    ...['b', 'c', 'd', 'e'].map((v) => 'sha256:' + v.repeat(64)),
  ];
  for (const [offset, artifactId] of ids.slice(1).entries()) {
    const prefix = 'ALLRICE_DSH_RETAINED_' + (offset + 2) + '_';
    vi.stubEnv(prefix + 'ROOT', '/reviewed/exact-' + offset);
    vi.stubEnv(prefix + 'ARTIFACT_ID', artifactId);
    vi.stubEnv(prefix + 'STORAGE_ROOT', root);
    vi.stubEnv(prefix + 'SOURCE_SHA', 'd'.repeat(40));
    vi.stubEnv(prefix + 'SOURCE_TREE', 'e'.repeat(40));
  }
  seam.install.mockImplementation(async (input) => ({
    artifactId: input.expectedId,
    generation: input.expectedId === id ? old : current,
    root: input.root,
  }));
  vi.stubEnv('ALLRICE_DSH_RUNTIME_ROOT', root + '/new-primary');
  const policy = await import('./dsh-native-retention.js');
  const installed = await policy.installConfiguredDshNativeRetention();
  expect(installed.map((item) => item.artifactId)).toEqual(ids);
  expect(policy.retainedDshStorageRoot(id)).toBe(root);
  expect(policy.retainedDshStorageRoot(ids[4]!)).toBe(root);
  await policy.verifyConfiguredDshNativeReferences({
    artifactId: 'sha256:' + 'f'.repeat(64),
    generation: current,
  });
  const approvals = seam.coverage.mock.calls[0]![0];
  expect(
    approvals.map((item: { artifactId: string }) => item.artifactId),
  ).toEqual(['sha256:' + 'f'.repeat(64), ...ids]);
  expect(approvals[0].storageRoot).toBe(root + '/new-primary');
  expect(
    approvals
      .slice(1)
      .every((item: { storageRoot: string }) => item.storageRoot === root),
  ).toBe(true);
  // Policy seam only: real registry limits, DB coverage and cold launch remain separate checks.
});
