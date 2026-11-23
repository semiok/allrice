import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type HostHistoryBinding,
  type HostHistorySnapshot,
  type HostHistoryStorePort,
} from '@allrice/contracts';
import {
  HostHistoryStore,
  hostHistoryDigest,
  HostHistoryIntegrityError,
} from './host-history.ts';
import {
  HostHistorySourceStore,
  type HostHistorySource,
} from './host-history-source.ts';

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
  const root = await mkdtemp(join(tmpdir(), 'history-source-'));
  roots.push(root);
  const raw = new HostHistoryStore(root),
    sources = new HostHistorySourceStore(root, raw);
  const b: HostHistoryBinding = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    personId: randomUUID(),
    employeeInstanceId: randomUUID(),
    threadId: randomUUID(),
    nativeInstanceRef: 'original-instance',
    nativeProfileRef: 'original-profile',
    nativeSessionId: 'root',
    rootNativeSessionId: 'root',
    parentNativeSessionId: null,
    configurationRef: 'original-release',
    configurationDigest: hostHistoryDigest('original-config'),
    executionGeneration: '4.0',
  };
  const header = {
    id: 'root',
    version: 4 as const,
    createdAt: 1,
    isSeeded: false,
  };
  const snapshot = (binding = b, count = 0): HostHistorySnapshot => ({
    schemaVersion: 1,
    binding,
    source: {
      dshVersion: '0.2.1-rc.2',
      sessionFormatVersion: 4,
      headerHash: hostHistoryDigest(header),
      inheritedEventCount: 0,
      throughSeq: count - 1,
      eventHashes: Array.from({ length: count }, (_, index) =>
        hostHistoryDigest({ index }),
      ),
    },
    entries: [],
    attachments: [],
    lastTurn: { startSeq: null, endSeq: null, reason: null },
  });
  const first = snapshot(),
    digest = await raw.publish(first, signal());
  const key = {
    organizationId: b.organizationId,
    workspaceId: b.workspaceId,
    personId: b.personId,
    employeeInstanceId: b.employeeInstanceId,
    threadId: b.threadId,
    rootNativeSessionId: 'root',
    rootOriginDigest: hostHistoryDigest('sql-original-root'),
    rootBindingRef: 'original-root-operation',
    vmId: randomUUID(),
  };
  const manifest: HostHistorySource = {
    schemaVersion: 1,
    key,
    sessions: [{ binding: b, snapshotDigest: digest, header }],
    edges: [],
  };
  return { root, raw, sources, b, key, manifest, snapshot };
}

describe('committed host history source', () => {
  it('does not expose an already-published snapshot before manifest commit', async () => {
    const f = await fixture();
    expect(await f.sources.read(f.key, signal())).toBeNull();
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      f.sources.publish(f.manifest, aborted.signal),
    ).rejects.toBeDefined();
    expect(await f.raw.read(f.b, signal())).not.toBeNull();
    expect(await f.sources.read(f.key, signal())).toBeNull();
  });
  it('pins the exact committed snapshot despite longer published/uncommitted data', async () => {
    const f = await fixture();
    await f.sources.publish(f.manifest, signal());
    const selected = (await f.sources.read(f.key, signal()))!;
    const longer = await f.raw.publish(f.snapshot(f.b, 1), signal());
    const store = f.sources.committedStore(selected);
    expect((await f.raw.read(f.b, signal()))!.digest).toBe(longer);
    expect((await store.read(f.b, signal()))!.digest).toBe(
      f.manifest.sessions[0]!.snapshotDigest,
    );
    await expect(store.read(f.b, signal(), longer)).rejects.toBeInstanceOf(
      HostHistoryIntegrityError,
    );
    await expect(store.publish(f.snapshot(), signal())).rejects.toBeInstanceOf(
      HostHistoryIntegrityError,
    );
    const next = structuredClone(f.manifest);
    next.sessions[0]!.snapshotDigest = longer;
    await f.sources.publish(next, signal());
    expect(
      (await f.sources.read(f.key, signal()))!.manifest.sessions[0]!
        .snapshotDigest,
    ).toBe(longer);
    expect((await store.read(f.b, signal()))!.digest).toBe(
      f.manifest.sessions[0]!.snapshotDigest,
    );
    const older = (await f.sources.read(f.key, signal(), {
      nativeSessionId: f.b.nativeSessionId,
      snapshotDigest: f.manifest.sessions[0]!.snapshotDigest,
    }))!;
    expect(older.manifest).toEqual(f.manifest);
    const unpublished = await f.raw.publish(f.snapshot(f.b, 2), signal());
    await expect(
      f.sources.read(f.key, signal(), {
        nativeSessionId: f.b.nativeSessionId,
        snapshotDigest: unpublished,
      }),
    ).rejects.toBeInstanceOf(HostHistoryIntegrityError);
    await expect(
      f.sources.read(f.key, signal(), {
        nativeSessionId: 'other-session',
        snapshotDigest: longer,
      }),
    ).rejects.toBeInstanceOf(HostHistoryIntegrityError);
  });
  it('persists/reopens immutable original facts and rejects replacement config', async () => {
    const f = await fixture();
    const digest = await f.sources.publish(f.manifest, signal());
    expect(
      await new HostHistorySourceStore(
        f.root,
        new HostHistoryStore(f.root),
      ).read(f.key, signal()),
    ).toEqual({ digest, manifest: f.manifest });
    const changed = structuredClone(f.manifest);
    changed.sessions[0]!.binding.configurationRef = 'current-release';
    const newer = {
      ...f.snapshot(changed.sessions[0]!.binding),
      binding: changed.sessions[0]!.binding,
    };
    changed.sessions[0]!.snapshotDigest = await f.raw.publish(newer, signal());
    await expect(f.sources.publish(changed, signal())).rejects.toBeInstanceOf(
      HostHistoryIntegrityError,
    );
  });
  it('checks original header, exact own catalog event, complete ancestry and crossed vectors', async () => {
    const f = await fixture();
    const childHeader = {
      id: 'child',
      version: 4 as const,
      createdAt: 2,
      isSeeded: false,
    };
    const event = {
      type: 'subagent/catalog' as const,
      seq: 0,
      time: 2,
      data: {
        version: 0 as const,
        childId: 'child',
        childCreatedAt: 2,
        mode: 'one-shot' as const,
      },
    };
    const parent = f.snapshot(f.b, 1);
    parent.source.eventHashes = [hostHistoryDigest(event)];
    const childBinding = {
      ...f.b,
      nativeSessionId: 'child',
      parentNativeSessionId: 'root',
    };
    const child = f.snapshot(childBinding);
    child.source.headerHash = hostHistoryDigest(childHeader);
    const manifest = structuredClone(f.manifest);
    manifest.sessions[0]!.snapshotDigest = await f.raw.publish(
      parent,
      signal(),
    );
    manifest.sessions.push({
      binding: childBinding,
      header: childHeader,
      snapshotDigest: await f.raw.publish(child, signal()),
    });
    manifest.edges.push({
      parentNativeSessionId: 'root',
      childNativeSessionId: 'child',
      parentEvent: event,
    });
    await f.sources.publish(manifest, signal());
    for (const mutate of [
      (m: HostHistorySource) => {
        m.edges = [];
      },
      (m: HostHistorySource) => {
        m.edges[0]!.parentEvent.data.childCreatedAt = 3;
      },
      (m: HostHistorySource) => {
        m.sessions[1]!.header.createdAt = 3;
      },
      (m: HostHistorySource) => {
        m.edges[0]!.parentNativeSessionId = 'child';
      },
      (m: HostHistorySource) => {
        m.sessions[1]!.binding.nativeProfileRef = 'guessed-profile';
      },
    ]) {
      const bad = structuredClone(manifest);
      mutate(bad);
      await expect(f.sources.publish(bad, signal())).rejects.toBeDefined();
    }
    const longerParent = structuredClone(parent);
    longerParent.source.throughSeq = 1;
    longerParent.source.eventHashes.push(
      hostHistoryDigest('next-parent-event'),
    );
    const advancedParent = structuredClone(manifest);
    advancedParent.sessions[0]!.snapshotDigest = await f.raw.publish(
      longerParent,
      signal(),
    );
    await f.sources.publish(advancedParent, signal());
    const longerChild = structuredClone(child);
    longerChild.source.throughSeq = 0;
    longerChild.source.eventHashes.push(hostHistoryDigest('next-child-event'));
    const crossed = structuredClone(manifest);
    crossed.sessions[1]!.snapshotDigest = await f.raw.publish(
      longerChild,
      signal(),
    );
    await expect(f.sources.publish(crossed, signal())).rejects.toBeInstanceOf(
      HostHistoryIntegrityError,
    );
    expect((await f.sources.read(f.key, signal()))!.manifest).toEqual(
      advancedParent,
    );
  });
  it('refuses missing roots and cross-person bindings', async () => {
    const f = await fixture();
    for (const mutate of [
      (m: HostHistorySource) => {
        m.key.personId = randomUUID();
      },
      (m: HostHistorySource) => {
        m.key.rootNativeSessionId = 'absent';
      },
      (m: HostHistorySource) => {
        m.sessions[0]!.binding.parentNativeSessionId = 'other';
      },
    ]) {
      const bad = structuredClone(f.manifest);
      mutate(bad);
      await expect(f.sources.publish(bad, signal())).rejects.toBeDefined();
    }
  });
  it('retains raw-store integrity failures instead of bypassing bad uncommitted fragments', async () => {
    const f = await fixture();
    await f.sources.publish(f.manifest, signal());
    const selected = (await f.sources.read(f.key, signal()))!;
    const dir = join(f.root, hostHistoryDigest(f.b).slice(7));
    await writeFile(join(dir, `${'e'.repeat(64)}.json`), '{}');
    await expect(
      f.sources.committedStore(selected).read(f.b, signal()),
    ).rejects.toBeDefined();
  });
  it('rejects corrupt committed bytes and does not trust filename or JSON fields alone', async () => {
    const f = await fixture();
    await f.sources.publish(f.manifest, signal());
    const dir = join(f.root, 'sources', hostHistoryDigest(f.key).slice(7));
    const file = join(
      dir,
      (await readdir(dir)).find((name) => name.endsWith('.json'))!,
    );
    const value = JSON.parse(await readFile(file, 'utf8'));
    value.key.rootBindingRef = 'replaced';
    await writeFile(file, JSON.stringify(value));
    await expect(f.sources.read(f.key, signal())).rejects.toBeInstanceOf(
      HostHistoryIntegrityError,
    );
  });
  it('waits for real raw I/O settlement when cancellation arrives during a read', async () => {
    const f = await fixture();
    await f.sources.publish(f.manifest, signal());
    const entered = gate(),
      release = gate();
    let joined = false;
    let hold = false;
    const raw: HostHistoryStorePort = {
      publish: f.raw.publish.bind(f.raw),
      async read(...args) {
        if (hold) {
          entered.release();
          await release.promise;
        }
        try {
          return await f.raw.read(...args);
        } finally {
          joined = true;
        }
      },
    };
    const sources = new HostHistorySourceStore(f.root, raw);
    const selected = (await sources.read(f.key, signal()))!;
    hold = true;
    joined = false;
    const controller = new AbortController();
    let settled = false;
    const reading = sources
      .committedStore(selected)
      .read(f.b, controller.signal);
    void reading.then(
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
    expect(joined).toBe(false);
    release.release();
    await expect(reading).rejects.toBeDefined();
    expect(joined).toBe(true);
  });
});
