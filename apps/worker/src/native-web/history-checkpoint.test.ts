import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import type { NativeHistoryCut } from '@allrice/dsh-native-history-source/types';
import type { HostHistoryBinding } from '@allrice/contracts';
import {
  HostHistoryStore,
  hostHistoryDigest,
  HostHistoryIntegrityError,
} from '@allrice/storage';
import { HostHistorySourceStore } from '@allrice/storage';
import { checkpointNativeHistory } from './history-checkpoint.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const signal = () => new AbortController().signal;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'history-checkpoint-'));
  roots.push(root);
  const snapshots = new HostHistoryStore(root),
    sources = new HostHistorySourceStore(root, snapshots);
  const binding: HostHistoryBinding = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    personId: randomUUID(),
    employeeInstanceId: randomUUID(),
    threadId: randomUUID(),
    nativeInstanceRef: 'actual-original-host-receipt',
    nativeProfileRef: 'actual-original-profile-receipt',
    nativeSessionId: 'root',
    rootNativeSessionId: 'root',
    parentNativeSessionId: null,
    configurationRef: 'original-configuration-release',
    configurationDigest: hostHistoryDigest({ original: 'configuration' }),
    executionGeneration: '4.0',
  };
  const cut: NativeHistoryCut = {
    rootSessionId: 'root',
    sessions: [
      {
        meta: {
          id: SessionId('root'),
          version: 4,
          createdAt: 1,
          isSeeded: false,
        },
        inheritedEventCount: 0,
        events: [
          {
            type: 'subagent/catalog',
            seq: SessionSeq(0),
            time: 2,
            data: {
              version: 0,
              childId: SessionId('child'),
              childCreatedAt: 2,
              mode: 'one-shot',
            },
          },
        ],
        catalog: [{ id: SessionId('child'), createdAt: 2, mode: 'one-shot' }],
      },
      {
        meta: {
          id: SessionId('child'),
          version: 4,
          createdAt: 2,
          isSeeded: false,
        },
        inheritedEventCount: 0,
        events: [],
        catalog: [],
      },
    ],
  };
  const key = {
    organizationId: binding.organizationId,
    workspaceId: binding.workspaceId,
    personId: binding.personId,
    employeeInstanceId: binding.employeeInstanceId,
    threadId: binding.threadId,
    rootNativeSessionId: 'root',
    rootOriginDigest: hostHistoryDigest('actual-sql-root-pin'),
    rootBindingRef: 'actual-root-create-operation',
    vmId: randomUUID(),
  };
  // Synthetic native cuts contain no attachments. Production requires the real
  // attachment owner even when its eventual result is empty.
  const input = {
    key,
    originalBindings: [
      binding,
      { ...binding, nativeSessionId: 'child', parentNativeSessionId: 'root' },
    ],
    native: { readCut: vi.fn(async () => JSON.stringify(cut)) },
    authorize: vi.fn(async (binding: HostHistoryBinding) => ({
      binding,
      revoked: signal(),
    })),
    attachments: vi.fn(async () => []),
    snapshots,
    sources,
    signal: signal(),
  };
  return { input, cut, binding, key, root };
}

describe('native history checkpoint', () => {
  it('captures real safe snapshots then atomically commits the original source vector', async () => {
    const f = await fixture();
    const result = await checkpointNativeHistory(f.input);
    expect((await f.input.sources.read(f.key, signal()))!.digest).toBe(
      result.digest,
    );
    expect(
      result.manifest.sessions.map((row) => row.binding.nativeSessionId),
    ).toEqual(['root', 'child']);
    expect(result.manifest.edges[0]!.parentEvent).toEqual(
      f.cut.sessions[0]!.events[0],
    );
    for (const row of result.manifest.sessions) {
      const snapshot = await f.input.snapshots.read(
        row.binding,
        signal(),
        row.snapshotDigest,
      );
      expect(snapshot!.snapshot.binding.configurationDigest).toBe(
        f.binding.configurationDigest,
      );
      expect(snapshot!.snapshot.source.headerHash).toBe(
        hostHistoryDigest(row.header),
      );
      const original = f.cut.sessions.find(
        (cut) => cut.meta.id === row.binding.nativeSessionId,
      )!;
      expect(snapshot!.snapshot.source.throughSeq).toBe(
        original.events.length - 1,
      );
      expect(snapshot!.snapshot.source.eventHashes).toEqual(
        original.events.map(hostHistoryDigest),
      );
    }
    expect(f.input.native.readCut).toHaveBeenCalledTimes(1);
  });
  it('does not reconstruct missing original facts or dispatch a read without them', async () => {
    const f = await fixture();
    await expect(
      checkpointNativeHistory({ ...f.input, originalBindings: [] }),
    ).rejects.toBeInstanceOf(HostHistoryIntegrityError);
    expect(f.input.native.readCut).not.toHaveBeenCalled();
    const wrong = {
      ...f.binding,
      configurationDigest: 'not-a-recorded-digest',
    };
    await expect(
      checkpointNativeHistory({ ...f.input, originalBindings: [wrong] }),
    ).rejects.toBeDefined();
    expect(f.input.native.readCut).not.toHaveBeenCalled();
  });
  it('refuses extra/missing sessions, fork-only ancestry and inherited catalog proof', async () => {
    const f = await fixture();
    for (const mutate of [
      (c: NativeHistoryCut) => {
        (c.sessions as unknown[]).pop();
      },
      (c: NativeHistoryCut) => {
        (c.sessions[0]!.events as unknown[]).splice(0);
      },
      (c: NativeHistoryCut) => {
        Object.assign(c.sessions[0]!, { inheritedEventCount: 1 });
      },
      (c: NativeHistoryCut) => {
        Object.assign(c.sessions[1]!.meta, { createdAt: 3 });
      },
    ]) {
      const bad = structuredClone(f.cut);
      mutate(bad);
      await expect(
        checkpointNativeHistory({
          ...f.input,
          native: { readCut: async () => JSON.stringify(bad) },
        }),
      ).rejects.toBeDefined();
      expect(await f.input.sources.read(f.key, signal())).toBeNull();
    }
  });
  it('leaves published snapshots uncommitted if the real manifest publication fails', async () => {
    const f = await fixture();
    vi.spyOn(f.input.sources, 'publish').mockRejectedValue(
      new Error('fixture-manifest-failed'),
    );
    await expect(checkpointNativeHistory(f.input)).rejects.toThrow(
      'fixture-manifest-failed',
    );
    expect(await f.input.snapshots.read(f.binding, signal())).not.toBeNull();
    expect(await f.input.sources.read(f.key, signal())).toBeNull();
  });
  it('waits for cancelled native I/O to actually settle and never commits a late reply', async () => {
    const f = await fixture(),
      entered = gate(),
      finish = gate(),
      controller = new AbortController();
    const readCut = vi.fn(async () => {
      entered.release();
      await finish.promise;
      return JSON.stringify(f.cut);
    });
    const work = checkpointNativeHistory({
      ...f.input,
      native: { readCut },
      signal: controller.signal,
    });
    let settled = false;
    void work.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await entered.promise;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.input.attachments).not.toHaveBeenCalled();
    finish.release();
    await expect(work).rejects.toBeDefined();
    expect(await f.input.sources.read(f.key, signal())).toBeNull();
  });
  it('validates the serialized header/log through native restoration before publication', async () => {
    const f = await fixture();
    const malformed = structuredClone(f.cut);
    Object.assign(malformed.sessions[0]!.meta, {
      isSeeded: 'not-a-native-boolean',
    });
    await expect(
      checkpointNativeHistory({
        ...f.input,
        native: { readCut: async () => JSON.stringify(malformed) },
      }),
    ).rejects.toThrow();
    expect(await f.input.sources.read(f.key, signal())).toBeNull();
    expect(f.input.attachments).not.toHaveBeenCalled();
  });
  it('cancels on an earlier session grant revocation during a later attachment export', async () => {
    const f = await fixture(),
      revoked = new AbortController(),
      entered = gate(),
      finish = gate();
    f.input.authorize.mockImplementation(async (binding) => ({
      binding,
      revoked: revoked.signal,
    }));
    f.input.attachments.mockImplementation(async () => {
      entered.release();
      await finish.promise;
      return [];
    });
    const work = checkpointNativeHistory(f.input);
    await entered.promise;
    revoked.abort();
    finish.release();
    await expect(work).rejects.toBeDefined();
    expect(await f.input.sources.read(f.key, signal())).toBeNull();
  });
});
