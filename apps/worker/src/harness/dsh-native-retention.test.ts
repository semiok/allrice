import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as NativeOnceLoader from '../native-schedule-once-loader.js';
import type { NativeRootOrigin } from '@allrice/database';

const seam = vi.hoisted(() => ({
  install: vi.fn(),
  launch: vi.fn(),
  coverage: vi.fn(),
  controlHistory: vi.fn(),
  origin: vi.fn(),
}));
vi.mock('@allrice/database', () => ({
  verifyNativeArtifactReferenceCoverage: seam.coverage,
  inspectNativeOriginReaderStates: vi.fn().mockResolvedValue([]),
  configuredNativeOriginReaders: vi.fn(() => []),
  nativeOriginReaderForBinding: vi.fn(),
  nativeOriginReaderForOrigin: seam.origin,
}));
vi.mock('./dsh-native-artifact.js', () => ({
  installRetainedDshNativeArtifact: seam.install,
  nativeArtifactLaunchForPin: seam.launch,
  approvedDshNativeControlArtifact: vi.fn(),
}));
vi.mock('../native-schedule-once-loader.js', async () => ({
  ...(await vi.importActual<typeof NativeOnceLoader>(
    '../native-schedule-once-loader.js',
  )),
  verifyNativeOnceControlHistory: seam.controlHistory,
}));
const old = 'dsh-0.1.5-rc.3-a4c74a9';
const frozen = 'dsh-0.1.1-rc.2-b150a55';
const id = 'sha256:' + 'a'.repeat(64);
const current = 'dsh-0.2.1-rc.2-687f282';
const retainedCurrentId = 'sha256:' + 'c'.repeat(64);
let root: string;
beforeEach(async () => {
  vi.resetModules();
  for (const key of Object.keys(process.env))
    if (key.startsWith('ALLRICE_DSH_ORIGIN_READER_'))
      vi.stubEnv(key, undefined);
  seam.origin.mockReset().mockReturnValue(undefined);
  seam.coverage.mockReset().mockResolvedValue({
    verified: true,
    references: [],
    nativeOnceControlReferences: [],
  });
  seam.controlHistory.mockReset().mockResolvedValue(1);
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
it('keeps closed control references independent of business pins and reads their original history only for retirement checks', async () => {
  const reference = {
    artifactId: retainedCurrentId,
    profileId: 'allrice-once-control-v1',
    storageId: 'original-once-storage',
    stateRoot: root,
  };
  const controls = [
    { controlSessionId: 'once-control-session', sessionState: 'ready' },
  ];
  seam.coverage.mockResolvedValue({
    verified: true,
    references: [
      {
        source: 'control:native_once',
        artifactId: retainedCurrentId,
        records: 1,
        covered: true,
      },
    ],
    nativeOnceControlReferences: [
      { partitionId: 'closed-partition', reference, controls },
    ],
  });
  const policy = await import('./dsh-native-retention.js');
  await policy.verifyConfiguredDshNativeReferences({
    artifactId: retainedCurrentId,
    generation: current,
  });
  expect(seam.controlHistory).not.toHaveBeenCalled();
  const result = await policy.verifyConfiguredDshNativeReferences(
    { artifactId: retainedCurrentId, generation: current },
    { requireReaderIdle: true },
  );
  expect(seam.controlHistory).toHaveBeenCalledWith(reference, controls);
  expect(result.nativeOnceControlHistoryVerified).toBe(1);
  expect(seam.launch).not.toHaveBeenCalled();
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
it.each([2, 6, 7])(
  'requires independent original provenance for retained slot %i',
  async (slot) => {
    configureCurrent();
    const prefix = `ALLRICE_DSH_RETAINED_${slot}_`;
    vi.stubEnv(prefix + 'ROOT', '/reviewed/current-a');
    vi.stubEnv(prefix + 'ARTIFACT_ID', retainedCurrentId);
    vi.stubEnv(prefix + 'STORAGE_ROOT', root);
    vi.stubEnv(prefix + 'SOURCE_SHA', '');
    vi.stubEnv(prefix + 'SOURCE_TREE', 'e'.repeat(40));
    const policy = await import('./dsh-native-retention.js');
    await expect(policy.installConfiguredDshNativeRetention()).rejects.toThrow(
      'SOURCE_PAIR_REQUIRED',
    );
    expect(seam.install).toHaveBeenCalledTimes(slot === 2 ? 1 : 2);
  },
);
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
it.each([0, 8])(
  'rejects retained slot %i rather than silently dropping history',
  async (slot) => {
    vi.stubEnv(`ALLRICE_DSH_RETAINED_${slot}_ROOT`, '/reviewed/excess');
    const policy = await import('./dsh-native-retention.js');
    await expect(policy.installConfiguredDshNativeRetention()).rejects.toThrow(
      'SLOT_LIMIT',
    );
    expect(seam.install).not.toHaveBeenCalled();
  },
);
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

it('keeps seven exact historical readers beside a distinct primary without evicting slot one', async () => {
  configure();
  const ids = [
    id,
    ...['b', 'c', 'd', 'e', 'f', '1'].map((v) => 'sha256:' + v.repeat(64)),
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
  expect(policy.retainedDshStorageRoot(ids[6]!)).toBe(root);
  expect(installed[6]).toMatchObject({
    slot: 7,
    artifactId: ids[6],
    sourceSha: 'd'.repeat(40),
    sourceTree: 'e'.repeat(40),
  });
  await policy.verifyConfiguredDshNativeReferences({
    artifactId: 'sha256:' + '7'.repeat(64),
    generation: current,
  });
  const approvals = seam.coverage.mock.calls[0]![0];
  expect(
    approvals.map((item: { artifactId: string }) => item.artifactId),
  ).toEqual(['sha256:' + '7'.repeat(64), ...ids]);
  expect(approvals).toHaveLength(8);
  expect(approvals[0].storageRoot).toBe(root + '/new-primary');
  expect(
    approvals
      .slice(1)
      .every((item: { storageRoot: string }) => item.storageRoot === root),
  ).toBe(true);
  // Policy seam only: real registry limits, DB coverage and cold launch remain separate checks.
});

it('MET195 emits bounded per-slot phases and metrics without altering approval inputs or reference coverage', async () => {
  configure();
  seam.install.mockImplementation(async (input) => {
    input.observe?.({ kind: 'read', bytes: 3 });
    return {
      artifactId: input.expectedId,
      generation: old,
      version: '0.1.5-rc.3',
      root: input.root,
    };
  });
  const events: Array<{ slot: number; kind: string; metric?: unknown }> = [];
  const policy = await import('./dsh-native-retention.js');
  const entries = await policy.installConfiguredDshNativeRetention({
    observe: (event) => events.push(event),
  });
  expect(events.map((event) => [event.slot, event.kind])).toEqual([
    [1, 'started'],
    [1, 'metric'],
    [1, 'completed'],
  ]);
  expect(entries[0]?.artifactId).toBe(id);
  expect(policy.retainedDshStorageRoot(id)).toBe(root);
});
it('MET195 retains the original rejection even if the phase observer throws', async () => {
  configure();
  const failure = Error('exact retained verification failure');
  seam.install.mockRejectedValue(failure);
  const policy = await import('./dsh-native-retention.js');
  await expect(
    policy.installConfiguredDshNativeRetention({
      observe: () => {
        throw Error('diagnostic sink failure');
      },
    }),
  ).rejects.toBe(failure);
});

function guardOrigin(): NativeRootOrigin {
  const contextId = '11111111-1111-4111-8111-111111111111';
  return {
    schemaVersion: 1,
    contextKind: 'chat',
    contextId,
    rootSeed: contextId,
    artifactId: retainedCurrentId,
    distributionGeneration: current,
    profileId: 'restricted',
    frozenIdentity: {
      kind: 'employee_package',
      checksum: id,
      sourceId: '22222222-2222-4222-8222-222222222222',
    },
  };
}
it.each([
  ['ALLRICE_DSH_ORIGIN_READER_APPROVAL_PATH', 'synthetic-present-reader-input'],
  [
    'ALLRICE_DSH_ORIGIN_READER_APPROVAL_SHA256',
    'synthetic-present-reader-input',
  ],
  ['ALLRICE_DSH_ORIGIN_READER_STORAGE_ROOT', 'synthetic-present-reader-input'],
  ['ALLRICE_DSH_ORIGIN_READER_2_APPROVAL_PATH', ''],
  ['ALLRICE_DSH_ORIGIN_READER_2_APPROVAL_SHA256', ''],
  ['ALLRICE_DSH_ORIGIN_READER_2_STORAGE_ROOT', ''],
  ['ALLRICE_DSH_ORIGIN_READER_2_APPROVAL_SHA256', '  '],
  ['ALLRICE_DSH_ORIGIN_READER_3_APPROVAL_PATH', ''],
  ['ALLRICE_DSH_ORIGIN_READER_2_ALLOW_EXISTING_WRITER', ''],
  ['ALLRICE_DSH_ORIGIN_READER_APPROVAL_PATH_2', ''],
  ['ALLRICE_DSH_ORIGIN_READER_APPROVAL_SHA256_2', '  '],
  [
    'ALLRICE_DSH_ORIGIN_READER_STORAGE_ROOT_2',
    'synthetic-present-reader-input',
  ],
  ['ALLRICE_DSH_ORIGIN_READER_2APPROVAL_PATH', ''],
  ['ALLRICE_DSH_ORIGIN_READER_02_APPROVAL_PATH', ''],
  [
    'ALLRICE_DSH_ORIGIN_READER_2_APPROVAL_PATH',
    'synthetic-present-reader-input',
  ],
] as const)(
  'requires scope before launch for reader input %s = %j',
  async (key, value) => {
    vi.stubEnv('ALLRICE_DSH_ORIGIN_READER_APPROVAL_PATH', '');
    vi.stubEnv(key, value);
    const policy = await import('./dsh-native-retention.js');
    expect(() =>
      policy.originDshNativeLaunch(guardOrigin(), 'restricted'),
    ).toThrow('DSH_NATIVE_ARTIFACT_RETAINED_ORIGIN_SCOPE_REQUIRED');
    expect(seam.origin).not.toHaveBeenCalled();
    expect(seam.launch).not.toHaveBeenCalled();
  },
);
it('requires scope when the entire second reader group is explicitly empty', async () => {
  for (const key of [
    'ALLRICE_DSH_ORIGIN_READER_2_APPROVAL_PATH',
    'ALLRICE_DSH_ORIGIN_READER_2_APPROVAL_SHA256',
    'ALLRICE_DSH_ORIGIN_READER_2_STORAGE_ROOT',
  ])
    vi.stubEnv(key, '');
  const policy = await import('./dsh-native-retention.js');
  expect(() =>
    policy.originDshNativeLaunch(guardOrigin(), 'restricted'),
  ).toThrow('DSH_NATIVE_ARTIFACT_RETAINED_ORIGIN_SCOPE_REQUIRED');
  expect(seam.origin).not.toHaveBeenCalled();
  expect(seam.launch).not.toHaveBeenCalled();
});
it.each(['absent', 'legacy-empty'] as const)(
  'keeps original verified origin launch with %s reader configuration',
  async (mode) => {
    if (mode === 'legacy-empty')
      for (const key of [
        'ALLRICE_DSH_ORIGIN_READER_APPROVAL_PATH',
        'ALLRICE_DSH_ORIGIN_READER_APPROVAL_SHA256',
        'ALLRICE_DSH_ORIGIN_READER_STORAGE_ROOT',
      ])
        vi.stubEnv(key, '');
    const origin = guardOrigin();
    const launch = {
      artifactId: origin.artifactId,
      generation: current,
      command: '/reviewed/node',
      args: ['/reviewed/original/entry.mjs'],
      profile: '/reviewed/original/restricted',
    };
    seam.launch.mockReturnValue(launch);
    const policy = await import('./dsh-native-retention.js');
    expect(policy.originDshNativeLaunch(origin, 'restricted')).toEqual(launch);
    expect(seam.launch).toHaveBeenCalledWith({
      artifactId: origin.artifactId,
      profileId: 'restricted',
    });
    expect(seam.origin).not.toHaveBeenCalled();
  },
);
it('delegates scoped partial second-reader configuration to the strict loader without launch fallback', async () => {
  vi.stubEnv('ALLRICE_DSH_ORIGIN_READER_2_APPROVAL_SHA256', '');
  seam.origin.mockImplementation(() => {
    throw Error('DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID');
  });
  const origin = guardOrigin();
  const scope = {
    organizationId: '33333333-3333-4333-8333-333333333333',
    workspaceId: '44444444-4444-4444-8444-444444444444',
    ownerId: '55555555-5555-4555-8555-555555555555',
  };
  const policy = await import('./dsh-native-retention.js');
  expect(() =>
    policy.originDshNativeLaunch(origin, 'restricted', scope),
  ).toThrow('DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID');
  expect(seam.origin).toHaveBeenCalledWith(origin, scope);
  expect(seam.launch).not.toHaveBeenCalled();
});
