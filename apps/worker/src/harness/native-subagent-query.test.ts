import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { NativeSubagentQueryTarget } from '@allrice/database';
import { DSH_INSTALLED_DISTRIBUTION } from '@allrice/contracts';
import { DshRuntimePool, type DshRuntime } from './dsh/runtime-pool.js';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const sessionId = randomUUID();
  const target: NativeSubagentQueryTarget = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    sessionId,
    generation: 3,
    rootOriginDigest: 'sha256:' + 'a'.repeat(64),
    descriptor: {
      nativeSessionId: 'dsh-' + sessionId,
      artifactId: 'sha256:' + 'b'.repeat(64),
      artifactManifestDigest: 'sha256:' + 'b'.repeat(64),
      distributionGeneration: DSH_INSTALLED_DISTRIBUTION.generation,
      profileId: 'restricted',
      storageContextKey: sessionId,
      storageNamespace: '/test/sessions',
    },
  };
  const pool = new DshRuntimePool({ idleCloseMs: 60_000 });
  const summary = {
    rootId: target.descriptor.nativeSessionId,
    root: { source: 'live', cursor: 0 },
    descendants: [],
  };
  const runtime = {
    id: randomUUID(),
    sessionId: target.descriptor.nativeSessionId,
    organizationId: target.organizationId,
    workspaceId: target.workspaceId,
    ownerId: target.ownerId,
    productSessionId: sessionId,
    nativeGeneration: target.generation,
    nativeTools: [],
    lastActivityAt: new Date(Date.now() - 3_600_000).toISOString(),
    nativePin: {
      ...target.descriptor,
      organizationId: target.organizationId,
      workspaceId: target.workspaceId,
      ownerId: target.ownerId,
      contextKind: 'chat',
      contextId: sessionId,
      bindingBasis: 'business_root_origin',
      rootOriginDigest: target.rootOriginDigest,
    },
    client: {
      nativeSubagentSummary: vi.fn(async () => summary),
      close: vi.fn(async () => {}),
      processState: () => ({ state: 'running' }),
    },
  } as unknown as DshRuntime;
  const cache = Reflect.get(pool, 'runtimes') as Map<string, DshRuntime>;
  cache.set(runtime.sessionId, runtime);
  return {
    target,
    pool,
    runtime,
    cache,
    summary,
    signal: new AbortController().signal,
  };
}

it('reads only the exact existing owner without acquisition, lease or activity touch', async () => {
  const f = fixture();
  const spies = ['acquire', 'touch', 'lease'].map((key) =>
    vi.spyOn(f.pool, key as 'acquire'),
  );
  const before = f.runtime.lastActivityAt;
  expect(await f.pool.nativeSubagentSummary(f.target, f.signal)).toBe(
    f.summary,
  );
  expect(f.runtime.lastActivityAt).toBe(before);
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  await f.pool.reclaimIdle();
  expect(f.runtime.client.close).toHaveBeenCalledOnce();
  expect(
    await f.pool.nativeSubagentSummary(f.target, f.signal),
  ).toBeUndefined();
});

it.each([
  'organizationId',
  'workspaceId',
  'ownerId',
  'sessionId',
  'generation',
  'rootOriginDigest',
] as const)(
  'rejects mismatched business %s before sending a read to the Host',
  async (key) => {
    const f = fixture();
    const target = {
      ...f.target,
      [key]: key === 'generation' ? 4 : randomUUID(),
    };
    await expect(
      f.pool.nativeSubagentSummary(target, f.signal),
    ).rejects.toThrow('NATIVE_QUERY_HOST_MISMATCH');
    expect(f.runtime.client.nativeSubagentSummary).not.toHaveBeenCalled();
  },
);

it('refuses a changed pin and a root replacement during an in-flight read', async () => {
  const f = fixture();
  await expect(
    f.pool.nativeSubagentSummary(
      {
        ...f.target,
        descriptor: {
          ...f.target.descriptor,
          storageNamespace: '/other/sessions',
        },
      },
      f.signal,
    ),
  ).rejects.toThrow('NATIVE_QUERY_HOST_MISMATCH');
  vi.mocked(f.runtime.client.nativeSubagentSummary).mockImplementation(
    async () => {
      f.cache.set(f.runtime.sessionId, { ...f.runtime, id: randomUUID() });
      return f.summary as Awaited<
        ReturnType<DshRuntime['client']['nativeSubagentSummary']>
      >;
    },
  );
  await expect(
    f.pool.nativeSubagentSummary(f.target, f.signal),
  ).rejects.toThrow('NATIVE_QUERY_HOST_MISMATCH');
});

it('does not report a preparing or unconfirmed closed owner as an absent hot Host', async () => {
  const f = fixture();
  const owners = Reflect.get(f.pool, 'ownedRuntimes') as Set<DshRuntime>;
  owners.add(f.runtime);
  f.cache.delete(f.runtime.sessionId);
  await expect(
    f.pool.nativeSubagentSummary(f.target, f.signal),
  ).rejects.toThrow('NATIVE_QUERY_HOST_UNAVAILABLE');
  f.cache.set(f.runtime.sessionId, f.runtime);
  vi.mocked(f.runtime.client.close).mockRejectedValue(
    Error('close unconfirmed'),
  );
  await expect(f.pool.closeOwned(f.runtime)).rejects.toThrow(
    'close unconfirmed',
  );
  await expect(
    f.pool.nativeSubagentSummary(f.target, f.signal),
  ).rejects.toThrow('NATIVE_QUERY_HOST_UNAVAILABLE');
  expect(f.runtime.client.nativeSubagentSummary).not.toHaveBeenCalled();
});

it('lets idle close win an in-flight read and suppresses its stale result', async () => {
  const f = fixture();
  vi.mocked(f.runtime.client.nativeSubagentSummary).mockImplementation(
    async () => {
      await f.pool.reclaimIdle();
      return f.summary as Awaited<
        ReturnType<DshRuntime['client']['nativeSubagentSummary']>
      >;
    },
  );
  await expect(
    f.pool.nativeSubagentSummary(f.target, f.signal),
  ).rejects.toThrow('NATIVE_QUERY_HOST_MISMATCH');
  expect(f.runtime.client.close).toHaveBeenCalledOnce();
});
