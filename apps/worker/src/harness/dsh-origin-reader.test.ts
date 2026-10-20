import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { configuredNativeOriginReaders } from '@allrice/database';
import type { NativeRootOrigin, NativeSessionPin } from '@allrice/database';
import type { HarnessExecutionInput } from './adapter.js';

const registry = vi.hoisted(() => ({ launch: vi.fn(), checked: vi.fn() }));
vi.mock('./dsh-native-artifact.js', () => ({
  nativeArtifactLaunchForPin: registry.launch,
  checkedDshNativeLaunch: registry.checked,
  installRetainedDshNativeArtifact: vi.fn(),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'origin-reader-pool-')),
  );
  roots.push(root);
  const source = 'sha256:' + 'a'.repeat(64),
    target = 'sha256:' + 'b'.repeat(64);
  const organizationId = randomUUID(),
    workspaceId = randomUUID(),
    ownerId = randomUUID(),
    contextId = randomUUID();
  const origin: NativeRootOrigin = {
    schemaVersion: 1,
    contextKind: 'chat',
    contextId,
    rootSeed: contextId,
    distributionGeneration: 'dsh-0.2.1-rc.2-687f282',
    profileId: 'restricted',
    artifactId: source,
    frozenIdentity: {
      kind: 'employee_package',
      checksum: 'sha256:' + 'c'.repeat(64),
      sourceId: randomUUID(),
    },
  };
  const storage = join(root, 'old-storage');
  await mkdir(storage);
  const policy = {
    schemaVersion: 1,
    mode: 'unbound_chat_first_writer',
    sourceArtifactId: source,
    targetArtifactId: target,
    generation: origin.distributionGeneration,
    profileId: 'restricted',
    sessionFormat: 4,
    prerequisites: {
      nodeMajor: Number(process.versions.node.split('.')[0]),
      platform: process.platform,
      arch: process.arch,
      modules: process.versions.modules,
    },
    evidenceDigest: 'sha256:' + 'd'.repeat(64),
    contexts: [{ organizationId, workspaceId, ownerId, origin }],
  };
  const path = join(root, 'policy.json'),
    bytes = JSON.stringify(policy);
  await writeFile(path, bytes);
  for (const [key, value] of Object.entries({
    ALLRICE_DSH_ORIGIN_READER_APPROVAL_PATH: path,
    ALLRICE_DSH_ORIGIN_READER_APPROVAL_SHA256:
      'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    ALLRICE_DSH_ORIGIN_READER_STORAGE_ROOT: storage,
    ALLRICE_DSH_NATIVE_ARTIFACT_ID: target,
    ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID: target,
  }))
    vi.stubEnv(key, value);
  registry.checked
    .mockReset()
    .mockReturnValue({ artifactId: target, profileId: 'restricted' });
  registry.launch.mockReset().mockImplementation((request) => {
    if (request.artifactId !== target)
      throw Error('original code not installed');
    return {
      artifactId: target,
      generation: origin.distributionGeneration,
      version: '0.2.1-rc.2',
      command: process.execPath,
      args: [join(root, 'current.mjs')],
      profile: join(root, 'restricted.yml'),
    };
  });
  const { DshRuntimePool } = await import('./dsh/runtime-pool.js');
  const pool = new DshRuntimePool({
    runtimeRoot: join(root, 'new-storage'),
    runtimeCommand: process.execPath,
    runtimeArgs: [join(root, 'current.mjs')],
    cordisConfig: join(root, 'restricted.yml'),
  });
  const input = {
    kernel: {
      sessionId: contextId,
      runtimeDistributionGeneration: origin.distributionGeneration,
    },
    executionEnvironment: {
      ALLRICE_ORGANIZATION_ID: organizationId,
      ALLRICE_WORKSPACE_ID: workspaceId,
      ALLRICE_OWNER_ID: ownerId,
    },
    signal: new AbortController().signal,
  } as unknown as HarnessExecutionInput;
  const threadId = 'dsh-' + contextId;
  return {
    root,
    source,
    target,
    storage,
    pool,
    input,
    origin,
    threadId,
    organizationId,
    workspaceId,
    ownerId,
    contextId,
  };
}
it('selects only the verified current target and preserves the old source namespace and immutable origin', async () => {
  const f = await fixture(),
    before = JSON.stringify(f.origin);
  const descriptor = f.pool.describeNativeSession(
    f.input,
    f.threadId,
    undefined,
    f.origin,
  )!;
  expect(descriptor.artifactId).toBe(f.target);
  expect(descriptor.artifactManifestDigest).toBe(f.target);
  expect(descriptor.storageNamespace).toBe(
    join(
      f.storage,
      f.organizationId,
      f.workspaceId,
      f.ownerId,
      f.contextId,
      'sessions',
    ),
  );
  expect(descriptor.originReaderApprovalDigest).toMatch(/^sha256:/);
  expect(JSON.stringify(f.origin)).toBe(before);
  expect(
    registry.launch.mock.calls.every(
      ([request]) => request.artifactId === f.target,
    ),
  ).toBe(true);
  await f.pool.assertOriginReaderFirstWriter(f.input, f.threadId, f.origin);
  await f.pool.close();
});
it('describes an adopted target on cold continuation with the same first-writer proof and original storage', async () => {
  const f = await fixture();
  const descriptor = f.pool.describeNativeSession(
    f.input,
    f.threadId,
    undefined,
    f.origin,
  )!;
  const pin: NativeSessionPin = {
    ...descriptor,
    organizationId: f.organizationId,
    workspaceId: f.workspaceId,
    ownerId: f.ownerId,
    contextKind: 'chat',
    contextId: f.contextId,
    firstRunId: randomUUID(),
    firstJobId: randomUUID(),
    firstAttempt: 1,
    boundAt: new Date().toISOString(),
    bindingBasis: 'business_root_origin',
    rootOriginDigest: configuredNativeOriginReaders()[0]!.originDigest,
  };
  expect(f.pool.describeNativeSession(f.input, f.threadId, pin)).toEqual(
    descriptor,
  );
  expect(() =>
    f.pool.describeNativeSession(f.input, f.threadId, {
      ...pin,
      rootOriginDigest: 'sha256:' + 'f'.repeat(64),
    }),
  ).toThrow('ORIGIN_APPROVAL');
  expect(() =>
    f.pool.describeNativeSession(f.input, f.threadId, {
      ...pin,
      ownerId: randomUUID(),
    }),
  ).toThrow('APPROVAL_INVALID');
  expect(() =>
    f.pool.describeNativeSession(f.input, f.threadId, {
      ...pin,
      originReaderApprovalDigest: undefined,
    }),
  ).toThrow(
    expect.objectContaining({ code: 'DSH_NATIVE_SESSION_BINDING_CONFLICT' }),
  );
  await f.pool.close();
});
it('rejects any previous journal before first binding, even a different content generation', async () => {
  const f = await fixture();
  const descriptor = f.pool.describeNativeSession(
    f.input,
    f.threadId,
    undefined,
    f.origin,
  )!;
  await mkdir(descriptor.storageNamespace, { recursive: true });
  await writeFile(
    join(descriptor.storageNamespace, 'another-generation.jsonl'),
    'preserve',
  );
  await expect(
    f.pool.assertOriginReaderFirstWriter(f.input, f.threadId, f.origin),
  ).rejects.toMatchObject({ code: 'DSH_NATIVE_ORIGIN_STORAGE_NOT_VIRGIN' });
  await f.pool.close();
});
it('does not grant the mapping to another tenant, origin, profile or an existing source writer', async () => {
  const f = await fixture();
  expect(() =>
    f.pool.describeNativeSession(
      {
        ...f.input,
        executionEnvironment: {
          ...f.input.executionEnvironment,
          ALLRICE_OWNER_ID: randomUUID(),
        },
      },
      f.threadId,
      undefined,
      f.origin,
    ),
  ).toThrow('APPROVAL_INVALID');
  expect(() =>
    f.pool.describeNativeSession(f.input, f.threadId, undefined, {
      ...f.origin,
      contextId: randomUUID(),
    }),
  ).toThrow('APPROVAL_INVALID');
  expect(() =>
    f.pool.describeNativeSession(f.input, f.threadId, undefined, {
      ...f.origin,
      profileId: 'technical',
    }),
  ).toThrow('APPROVAL_INVALID');
  const descriptor = f.pool.describeNativeSession(
    f.input,
    f.threadId,
    undefined,
    f.origin,
  )!;
  const old = {
    ...descriptor,
    artifactId: f.source,
    artifactManifestDigest: f.source,
    originReaderApprovalDigest: undefined,
  } as NativeSessionPin;
  expect(() => f.pool.describeNativeSession(f.input, f.threadId, old)).toThrow(
    'EXISTING_WRITER_NOT_MIGRATED',
  );
  await f.pool.close();
});
