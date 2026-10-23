import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HarnessRuntimeClosureSnapshot,
  HarnessRuntimeProcessSnapshot,
} from './adapter.js';
const db = vi.hoisted(() => ({
  readDshRuntimeCloseCoverage: vi.fn(),
  finalizeWorkerDshRuntimeInventory: vi.fn(),
}));
vi.mock('@allrice/database', () => db);
import {
  verifyWorkerDshRuntimeClosure,
  DshWorkerCloseError,
} from './dsh-worker-close.js';

const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = {
  workerId: id(1),
  workerBootId: id(2),
  serviceManifestDigest: `sha256:${'a'.repeat(64)}`,
};
const owner = {
  ...identity,
  runtimeId: id(3),
  version: 1,
  kind: 'owned',
  observedAt: '2026-10-23T00:00:00.000Z',
  artifactId: `sha256:${'b'.repeat(64)}`,
  profileId: 'restricted',
  context: {
    kind: 'context',
    contextKind: 'chat',
    contextId: id(4),
    organizationId: id(5),
    workspaceId: id(6),
    ownerId: id(7),
  },
};
function stored(physical = 'exited', publicClose = 'confirmed') {
  return {
    owner: structuredClone(owner),
    ownerDigest: `sha256:${'c'.repeat(64)}`,
    physical,
    publicClose,
    finalResponseFlush:
      publicClose === 'confirmed'
        ? 'verified_wrapper_normal_exit'
        : 'unconfirmed',
    observations: [],
  };
}
function live(): HarnessRuntimeProcessSnapshot {
  return {
    id: owner.runtimeId,
    organizationId: id(5),
    workspaceId: id(6),
    sessionId: id(4),
    ownerId: id(7),
    threadId: 'native',
    providerRoute: 'openai-codex',
    model: 'test',
    reasoningEffort: 'low',
    profileFingerprint: 'd'.repeat(64),
    nativeTools: [],
    startedAt: owner.observedAt,
    lastActivityAt: owner.observedAt,
  };
}
function closure(
  processState: 'exited' | 'running' | 'unknown' = 'exited',
): HarnessRuntimeClosureSnapshot {
  return {
    id: owner.runtimeId,
    threadId: 'native',
    nativeArtifactId: owner.artifactId,
    state: 'unconfirmed',
    processState,
    stdioClosed: processState === 'exited',
    exitCode: processState === 'exited' ? 0 : null,
    signal: null,
    shutdownAcknowledged: true,
    wrapperCleanupConfirmed: true,
    terminationAttempted: null,
  };
}
function input() {
  return {
    ...identity,
    runtimeInventory: () => [] as HarnessRuntimeProcessSnapshot[],
    closureInventory: () => [] as HarnessRuntimeClosureSnapshot[],
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  db.readDshRuntimeCloseCoverage.mockResolvedValue([stored()]);
  db.finalizeWorkerDshRuntimeInventory.mockResolvedValue(undefined);
});

describe('same-boot durable closure and physical final inventory', () => {
  it('reads the actual boot and updates only witnessed exits', async () => {
    const result = await verifyWorkerDshRuntimeClosure(input());
    expect(db.readDshRuntimeCloseCoverage).toHaveBeenCalledWith(undefined, {
      workerBootId: identity.workerBootId,
    });
    expect(db.finalizeWorkerDshRuntimeInventory).toHaveBeenCalledWith({
      ...identity,
      runtimes: [],
      exitedRuntimeIds: [owner.runtimeId],
    });
    expect(result).toMatchObject({
      confirmed: 1,
      readbackConfirmed: true,
      physicalRegistryUpdated: true,
      legacyHistory: 'not_reclassified',
    });
  });
  it('keeps an abnormal physical exit offline but semantically unconfirmed', async () => {
    db.readDshRuntimeCloseCoverage.mockResolvedValue([
      stored('exited', 'unconfirmed'),
    ]);
    const error = await verifyWorkerDshRuntimeClosure({
      ...input(),
      closureInventory: () => [closure()],
    }).catch((e) => e);
    expect(error).toBeInstanceOf(DshWorkerCloseError);
    expect(error.summary).toMatchObject({
      physicalExited: [owner.runtimeId],
      liveOrUnknown: [],
      unconfirmed: [owner.runtimeId],
      physicalRegistryUpdated: true,
    });
  });
  it('retains a provider owner missing its close even if absent from the chat pool', async () => {
    const pending = stored('unknown', 'unconfirmed');
    pending.owner.context = {
      kind: 'provider',
      purpose: 'codex_probe',
    } as unknown as typeof pending.owner.context;
    db.readDshRuntimeCloseCoverage.mockResolvedValue([pending]);
    await expect(verifyWorkerDshRuntimeClosure(input())).rejects.toMatchObject({
      summary: {
        liveOrUnknown: [owner.runtimeId],
        unconfirmed: [owner.runtimeId],
        physicalExited: [],
      },
    });
    expect(
      db.finalizeWorkerDshRuntimeInventory.mock.calls[0]?.[0].exitedRuntimeIds,
    ).toEqual([]);
  });
  it('does not mark a running/unknown instance offline', async () => {
    db.readDshRuntimeCloseCoverage.mockResolvedValue([
      stored('unknown', 'unconfirmed'),
    ]);
    await expect(
      verifyWorkerDshRuntimeClosure({
        ...input(),
        runtimeInventory: () => [live()],
        closureInventory: () => [closure('running')],
      }),
    ).rejects.toMatchObject({ summary: { liveOrUnknown: [owner.runtimeId] } });
    expect(db.finalizeWorkerDshRuntimeInventory).toHaveBeenCalledWith({
      ...identity,
      runtimes: [live()],
      exitedRuntimeIds: [],
    });
  });
  it('rejects contradictory durable exit and still-running physical owner', async () => {
    await expect(
      verifyWorkerDshRuntimeClosure({
        ...input(),
        runtimeInventory: () => [live()],
      }),
    ).rejects.toMatchObject({
      summary: { physicalExited: [], liveOrUnknown: [owner.runtimeId] },
    });
  });
  it.each(['workerId', 'workerBootId', 'serviceManifestDigest'] as const)(
    'rejects foreign %s rather than using its exit proof',
    async (key) => {
      const row = stored();
      row.owner[key] =
        key === 'serviceManifestDigest' ? `sha256:${'e'.repeat(64)}` : id(99);
      db.readDshRuntimeCloseCoverage.mockResolvedValue([row]);
      await expect(
        verifyWorkerDshRuntimeClosure(input()),
      ).rejects.toMatchObject({
        summary: { readbackConfirmed: false, physicalExited: [] },
      });
    },
  );
  it('rejects duplicated owner rows', async () => {
    db.readDshRuntimeCloseCoverage.mockResolvedValue([stored(), stored()]);
    await expect(verifyWorkerDshRuntimeClosure(input())).rejects.toMatchObject({
      summary: { readbackConfirmed: false },
    });
  });
  it('does not infer success from a database read failure or empty pool', async () => {
    db.readDshRuntimeCloseCoverage.mockRejectedValue(Error('read'));
    await expect(verifyWorkerDshRuntimeClosure(input())).rejects.toMatchObject({
      summary: { readbackConfirmed: false, physicalRegistryUpdated: false },
    });
    expect(db.finalizeWorkerDshRuntimeInventory).not.toHaveBeenCalled();
  });
  it('retains a witnessed physical exit when its observation write/readback failed', async () => {
    db.readDshRuntimeCloseCoverage.mockResolvedValue([
      stored('unknown', 'unconfirmed'),
    ]);
    await expect(
      verifyWorkerDshRuntimeClosure({
        ...input(),
        closureInventory: () => [closure()],
      }),
    ).rejects.toMatchObject({
      summary: {
        physicalExited: [owner.runtimeId],
        liveOrUnknown: [],
        unconfirmed: [owner.runtimeId],
      },
    });
    expect(db.finalizeWorkerDshRuntimeInventory).toHaveBeenCalledWith({
      ...identity,
      runtimes: [],
      exitedRuntimeIds: [],
    });
  });
  it('does not turn a failed physical inventory read into an empty inventory', async () => {
    await expect(
      verifyWorkerDshRuntimeClosure({
        ...input(),
        runtimeInventory() {
          throw Error('inventory');
        },
      }),
    ).rejects.toMatchObject({ summary: { physicalRegistryUpdated: false } });
    expect(db.finalizeWorkerDshRuntimeInventory).not.toHaveBeenCalled();
  });
  it('surfaces registry commit failure while retaining durable results', async () => {
    db.finalizeWorkerDshRuntimeInventory.mockRejectedValue(Error('commit'));
    await expect(verifyWorkerDshRuntimeClosure(input())).rejects.toMatchObject({
      summary: {
        confirmed: 1,
        readbackConfirmed: true,
        physicalRegistryUpdated: false,
      },
    });
  });
  it('accepts never-spawned as no resource, without marking a runtime offline', async () => {
    db.readDshRuntimeCloseCoverage.mockResolvedValue([
      stored('never_spawned', 'not_started'),
    ]);
    expect(await verifyWorkerDshRuntimeClosure(input())).toMatchObject({
      neverSpawned: 1,
      confirmed: 0,
      physicalExited: [],
    });
  });
  it('permits a quiet current boot without backfilling prior unknown boots', async () => {
    db.readDshRuntimeCloseCoverage.mockResolvedValue([]);
    expect(await verifyWorkerDshRuntimeClosure(input())).toMatchObject({
      observedRuntimes: 0,
      confirmed: 0,
      legacyHistory: 'not_reclassified',
    });
  });
  it('refuses a chat inventory whose owner scope differs', async () => {
    db.readDshRuntimeCloseCoverage.mockResolvedValue([
      stored('unknown', 'unconfirmed'),
    ]);
    await expect(
      verifyWorkerDshRuntimeClosure({
        ...input(),
        runtimeInventory: () => [{ ...live(), ownerId: id(98) }],
      }),
    ).rejects.toBeInstanceOf(DshWorkerCloseError);
  });
});
