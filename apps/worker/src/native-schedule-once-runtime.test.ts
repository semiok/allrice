import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeOnceSqlOptions } from '@allrice/database';
import {
  NativeScheduleOnceError,
  type NativeScheduleControlHost,
  type NativeScheduleControlReference,
  type NativeScheduleHostFactory,
  type NativeScheduleHostModule,
  type NativeScheduleOnceStore,
  type NativeSchedulePublicModules,
  type NativeScheduleWriter,
} from './native-schedule-once.js';
import {
  createNativeOnceWorkerRuntime,
  NATIVE_ONCE_CONSUMER_LIMIT,
  type NativeOnceWorkerDatabasePorts,
  type NativeOnceWorkerRuntimeTestPorts,
  type NativeOncePartitionActivation,
} from './native-schedule-once-runtime.js';

vi.mock('@allrice/database', () => ({
  getDatabase: undefined,
  createNativeOnceSqlStore: undefined,
  nativeOnceDigest: undefined,
  lockNativeOnceAdmissions: undefined,
  initializeNativeOncePartition: undefined,
  dispatchNextNativeOnceOccurrence: undefined,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const pendingStops: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(pendingStops.splice(0).map((stop) => stop()));
});

function fixture(
  overrides: {
    enabled?: boolean;
    noGrant?: boolean;
    closeFails?: boolean;
    hostCloseGate?: Promise<void>;
    auxiliaryCloseGate?: Promise<void>;
    auxiliaryCloseFails?: boolean;
    dispatch?: () => Promise<boolean>;
    loadModules?: () => Promise<NativeSchedulePublicModules>;
    testPorts?: Partial<NativeOnceWorkerRuntimeTestPorts>;
  } = {},
) {
  const trace: string[] = [];
  const reference: NativeScheduleControlReference = {
    artifactId: 'approved-test-artifact',
    profileId: 'once-control-test-profile',
    storageId: 'test-stable-storage',
    stateRoot: '/approved/test-once-state',
  };
  const writer: NativeScheduleWriter = {
    partitionId: 'allrice-once-v1',
    ownerId: 'runtime-test-worker',
    epoch: 7,
    token: 'private-writer-token',
  };
  const loaded = {
    schedule: {
      scheduleDomain: {
        tables: { tasks: { valueSchema: { parse: vi.fn((value) => value) } } },
      },
    },
  } as unknown as NativeSchedulePublicModules;
  let sqlOptions: NativeOnceSqlOptions | undefined;
  const proofs: unknown[] = [];
  const store: NativeScheduleOnceStore = {
    acquireWriter: vi.fn(async () => {
      trace.push('acquire');
      return overrides.noGrant
        ? null
        : { writer, reference, remainingMs: 30_000, controls: [] };
    }),
    renewWriter: vi.fn(async () => {
      trace.push('renew');
      return { writer, remainingMs: 30_000 };
    }),
    assertWriter: vi.fn(async () => true),
    loadControls: vi.fn(async () => []),
    loadTaskRecords: vi.fn(async () => ({})),
    commitMutation: vi.fn(async () => 'committed' as const),
    readExactCommit: vi.fn(async () => 'absent' as const),
    loadWorkspaceUnit: vi.fn(async () => ({
      unitVersion: 2 as const,
      revision: 0,
      tables: { workspaces: {} },
      global: null,
    })),
    commitWorkspaceWrite: vi.fn(async (_writer, write) => ({
      revision: write.expectedRevision + 1,
    })),
    releaseClosedWriter: vi.fn(async (given) => {
      const proof = await sqlOptions!.proveClosed(given);
      if (!proof) throw new Error('close_proof_required');
      proofs.push(proof);
      trace.push('release');
    }),
  };
  const database: NativeOnceWorkerDatabasePorts = {
    getDatabase: vi.fn(() => ({}) as NativeOnceSqlOptions['db']),
    createNativeOnceSqlStore: vi.fn((options) => {
      sqlOptions = options;
      trace.push('store');
      return store;
    }),
    nativeOnceDigest: (value) =>
      'sha256:' +
      createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    lockNativeOnceAdmissions: vi.fn(async () => new Map()),
    initializeNativeOncePartition: vi.fn(async () => {
      trace.push('initialize-partition');
      return {
        partitionId: writer.partitionId,
        reference: structuredClone(reference),
        activation: {
          enabled: true,
          storageReady: true,
          legacyClockExcluded: true,
          controlArtifactApproved: true,
        },
      };
    }),
    dispatchNextNativeOnceOccurrence: vi.fn(async () => {
      trace.push('dispatch');
      return overrides.dispatch ? overrides.dispatch() : false;
    }),
  };
  const hostFactory: NativeScheduleHostFactory = vi.fn(
    async ({ backend, auxiliaryBackend }) => {
      trace.push('open-host');
      const auxiliaryClose = auxiliaryBackend.close.bind(auxiliaryBackend);
      auxiliaryBackend.close = async () => {
        trace.push('auxiliary-close-start');
        await overrides.auxiliaryCloseGate;
        if (overrides.auxiliaryCloseFails)
          throw Error('injected auxiliary drain failure');
        await auxiliaryClose();
        trace.push('auxiliary-close-completed');
      };
      const host: NativeScheduleControlHost = {
        async boot() {
          trace.push('boot');
        },
        decodeTask(value) {
          return loaded.schedule.scheduleDomain.tables.tasks.valueSchema.parse(
            value,
          );
        },
        async initializeSession() {},
        async resumeSession() {},
        async mountSchedule() {
          trace.push('mount');
          const unit = await backend.kv!.open({
            name: 'schedule',
            version: 1,
            tables: ['tasks'],
            hasGlobal: false,
          });
          await unit.loadAll();
        },
        async catalog() {
          return [];
        },
        async createOnce() {
          throw new Error('empty fixture cannot create a task');
        },
        async deleteOnce() {},
        async close() {
          trace.push('host-close-start');
          await overrides.hostCloseGate;
          if (overrides.closeFails)
            throw new Error('provider-secret-must-never-appear');
          trace.push('host-close-completed');
        },
      };
      return host;
    },
  );
  const loadDatabase = vi.fn(async () => database);
  const verifyStorageRoot = vi.fn(async () => undefined);
  const loadModules = vi.fn(overrides.loadModules ?? (async () => loaded));
  const loadHostFactory = vi.fn(
    async (): Promise<NativeScheduleHostModule> => (input) =>
      hostFactory(input),
  );
  const runtime = createNativeOnceWorkerRuntime(
    {
      workerId: writer.ownerId,
      reference,
      loadModules,
      loadHostFactory,
      enabled: overrides.enabled ?? true,
    },
    {
      loadDatabase,
      verifyStorageRoot,
      hostFactory,
      ...overrides.testPorts,
    },
  );
  pendingStops.push(() => runtime.stop());
  return {
    runtime,
    trace,
    writer,
    reference,
    database,
    store,
    hostFactory,
    loadDatabase,
    loadModules,
    loadHostFactory,
    verifyStorageRoot,
    proofs,
    options: () => sqlOptions!,
  };
}

describe('native once Worker runtime', () => {
  it('disabled performs no database, storage or Host work', async () => {
    const f = fixture({ enabled: false });
    await expect(f.runtime.tick()).resolves.toEqual({
      processed: 0,
      limitReached: false,
    });
    await f.runtime.stop();
    expect(f.loadModules).not.toHaveBeenCalled();
    expect(f.loadHostFactory).not.toHaveBeenCalled();
    expect(f.verifyStorageRoot).not.toHaveBeenCalled();
    expect(f.loadDatabase).not.toHaveBeenCalled();
    expect(f.hostFactory).not.toHaveBeenCalled();
    expect(f.runtime.status().state).toBe('disabled');
  });

  it('starts lazily, coalesces ticks and runs the controller before the consumer', async () => {
    let remaining = 2;
    const f = fixture({ dispatch: async () => remaining-- > 0 });
    expect(f.trace).toEqual([]);
    const tick = f.runtime.tick();
    expect(f.runtime.tick()).toBe(tick);
    await expect(tick).resolves.toEqual({ processed: 2, limitReached: false });
    expect(f.trace.indexOf('mount')).toBeLessThan(f.trace.indexOf('dispatch'));
    await f.runtime.tick();
    expect(f.loadModules).toHaveBeenCalledTimes(1);
    expect(f.database.initializeNativeOncePartition).toHaveBeenCalledTimes(1);
    expect(f.store.renewWriter).toHaveBeenCalledTimes(1);
    expect(f.database.lockNativeOnceAdmissions).toBe(f.options().lockAdmission);
    expect(f.runtime.status().processedCount).toBe(2);
  });

  it('loads the approved private Host factory once when using the production delegation path', async () => {
    const f = fixture({ testPorts: { hostFactory: undefined } });
    await f.runtime.tick();
    await f.runtime.tick();
    expect(f.loadHostFactory).toHaveBeenCalledTimes(1);
    expect(f.hostFactory).toHaveBeenCalledTimes(1);
    await f.runtime.stop();
  });

  it.each([
    'enabled',
    'storageReady',
    'legacyClockExcluded',
    'controlArtifactApproved',
  ] as const)(
    'does not infer %s activation from a nonempty partition ID',
    async (key) => {
      const f = fixture();
      vi.mocked(f.database.initializeNativeOncePartition).mockResolvedValueOnce(
        {
          partitionId: f.writer.partitionId,
          reference: f.reference,
          activation: {
            enabled: true,
            storageReady: true,
            legacyClockExcluded: true,
            controlArtifactApproved: true,
            [key]: false,
          },
        },
      );
      await expect(f.runtime.tick()).rejects.toMatchObject({
        fault: { phase: 'initialization', code: 'binding_invalid' },
      });
      expect(f.database.createNativeOnceSqlStore).not.toHaveBeenCalled();
      expect(f.hostFactory).not.toHaveBeenCalled();
      expect(
        f.database.dispatchNextNativeOnceOccurrence,
      ).not.toHaveBeenCalled();
    },
  );

  it('rejects the old string initializer result and a different persisted reference', async () => {
    for (const result of [
      'allrice-once-v1',
      {
        partitionId: 'allrice-once-v1',
        reference: { artifactId: 'different' },
        activation: {
          enabled: true,
          storageReady: true,
          legacyClockExcluded: true,
          controlArtifactApproved: true,
        },
      },
    ]) {
      const f = fixture();
      vi.mocked(f.database.initializeNativeOncePartition).mockResolvedValueOnce(
        result as NativeOncePartitionActivation,
      );
      await expect(f.runtime.tick()).rejects.toMatchObject({
        fault: { phase: 'initialization', code: 'binding_invalid' },
      });
      expect(f.hostFactory).not.toHaveBeenCalled();
    }
  });

  it('refuses SQL stores without both workspace ports before acquiring a writer', async () => {
    const f = fixture();
    Object.assign(f.store, { commitWorkspaceWrite: undefined });
    await expect(f.runtime.tick()).rejects.toMatchObject({
      fault: { phase: 'initialization', code: 'database_api_unavailable' },
    });
    expect(f.store.acquireWriter).not.toHaveBeenCalled();
    expect(f.hostFactory).not.toHaveBeenCalled();
  });

  it('bounds a hot outbox by count, then renews the controller on the next tick', async () => {
    const f = fixture({ dispatch: async () => true });
    await expect(f.runtime.tick()).resolves.toEqual({
      processed: NATIVE_ONCE_CONSUMER_LIMIT,
      limitReached: true,
    });
    expect(f.database.dispatchNextNativeOnceOccurrence).toHaveBeenCalledTimes(
      NATIVE_ONCE_CONSUMER_LIMIT,
    );
    f.trace.length = 0;
    await f.runtime.tick();
    expect(f.trace[0]).toBe('renew');
    expect(f.runtime.status().processedCount).toBe(
      NATIVE_ONCE_CONSUMER_LIMIT * 2,
    );
  });

  it('also bounds a slow successful burst by monotonic time', async () => {
    let clock = 0;
    const f = fixture({
      testPorts: { now: () => clock },
      dispatch: async () => {
        clock += 600;
        return true;
      },
    });
    await expect(f.runtime.tick()).resolves.toEqual({
      processed: 2,
      limitReached: true,
    });
    expect(f.database.dispatchNextNativeOnceOccurrence).toHaveBeenCalledTimes(
      2,
    );
  });

  it('ends the burst on consumer errors, reports safe SQLSTATE and retries only on a new tick', async () => {
    let first = true;
    const f = fixture({
      dispatch: async () => {
        if (first) {
          first = false;
          throw Object.assign(
            new Error('postgres://user:provider-secret@host'),
            { code: '55P03' },
          );
        }
        return false;
      },
    });
    await expect(f.runtime.tick()).rejects.toMatchObject({
      fault: { phase: 'consumer', code: '55P03' },
    });
    expect(f.database.dispatchNextNativeOnceOccurrence).toHaveBeenCalledTimes(
      1,
    );
    expect(JSON.stringify(f.runtime.status())).not.toContain('provider-secret');
    await f.runtime.tick();
    expect(f.database.dispatchNextNativeOnceOccurrence).toHaveBeenCalledTimes(
      2,
    );
    expect(f.runtime.status().faultCount).toBe(1);
  });

  it('does not dispatch if the controller tick fails', async () => {
    const f = fixture();
    vi.mocked(f.store.acquireWriter).mockRejectedValueOnce(
      new NativeScheduleOnceError('ack_unknown'),
    );
    await expect(f.runtime.tick()).rejects.toMatchObject({
      fault: { phase: 'controller', code: 'ack_unknown' },
    });
    expect(f.database.dispatchNextNativeOnceOccurrence).not.toHaveBeenCalled();
    expect(f.hostFactory).not.toHaveBeenCalled();
  });

  it('leaves an unclosed old writer alone when acquisition grants nothing', async () => {
    const f = fixture({ noGrant: true });
    await f.runtime.tick();
    await f.runtime.stop();
    expect(f.hostFactory).not.toHaveBeenCalled();
    expect(f.store.releaseClosedWriter).not.toHaveBeenCalled();
    expect(f.options().readiness?.().enabled).toBe(true);
    expect(f.proofs).toEqual([]);
  });

  it('emits proof only after Host and backend drain at the controller release boundary', async () => {
    const gate = deferred<void>();
    const f = fixture({ hostCloseGate: gate.promise });
    await f.runtime.tick();
    await expect(f.options().proveClosed(f.writer)).resolves.toBeNull();
    const stopping = f.runtime.stop();
    await vi.waitFor(() => expect(f.trace).toContain('host-close-start'));
    expect(f.store.releaseClosedWriter).not.toHaveBeenCalled();
    await expect(f.options().proveClosed(f.writer)).resolves.toBeNull();
    gate.resolve();
    await stopping;
    expect(f.trace.indexOf('host-close-completed')).toBeLessThan(
      f.trace.indexOf('release'),
    );
    expect(f.proofs).toHaveLength(1);
    expect(f.proofs[0]).toMatchObject({
      kind: 'public_host_backend_drained',
      partitionId: f.writer.partitionId,
      ownerId: f.writer.ownerId,
      epoch: f.writer.epoch,
      evidence: {
        publicHostCloseCompletedAt: expect.any(String),
        scheduleBackendDrainCompletedAt: expect.any(String),
        auxiliaryBackendDrainCompletedAt: expect.any(String),
        backendDrainCompletedAt: expect.any(String),
        controllerReleaseBoundaryAt: expect.any(String),
      },
    });
    expect(JSON.stringify(f.proofs)).not.toContain(f.writer.token);
    await expect(
      f.options().proveClosed({ ...f.writer, epoch: f.writer.epoch + 1 }),
    ).resolves.toBeNull();
    await expect(
      f.options().proveClosed({ ...f.writer, token: 'different-token' }),
    ).resolves.toBeNull();
    expect(f.runtime.status().state).toBe('closed');
  });

  it('never releases a writer after a failed public close', async () => {
    const f = fixture({ closeFails: true });
    await f.runtime.tick();
    const stopping = f.runtime.stop();
    await expect(stopping).rejects.toMatchObject({
      fault: { phase: 'shutdown', code: 'shutdown_failed' },
    });
    expect(f.runtime.stop()).toBe(stopping);
    expect(f.store.releaseClosedWriter).not.toHaveBeenCalled();
    await expect(f.options().proveClosed(f.writer)).resolves.toBeNull();
    expect(f.runtime.status().state).toBe('blocked');
    expect(JSON.stringify(f.runtime.status())).not.toContain('provider-secret');
  });

  it('waits for the auxiliary backend drain before emitting the close proof', async () => {
    const gate = deferred<void>(),
      f = fixture({ auxiliaryCloseGate: gate.promise });
    await f.runtime.tick();
    const stopping = f.runtime.stop();
    await vi.waitFor(() => expect(f.trace).toContain('auxiliary-close-start'));
    await expect(f.options().proveClosed(f.writer)).resolves.toBeNull();
    expect(f.store.releaseClosedWriter).not.toHaveBeenCalled();
    gate.resolve();
    await stopping;
    expect(f.trace.indexOf('auxiliary-close-completed')).toBeLessThan(
      f.trace.indexOf('release'),
    );
    expect(f.proofs).toHaveLength(1);
  });

  it('does not release ownership or report closed if auxiliary drain fails', async () => {
    const f = fixture({ auxiliaryCloseFails: true });
    await f.runtime.tick();
    await expect(f.runtime.stop()).rejects.toMatchObject({
      fault: { phase: 'shutdown', code: 'shutdown_failed' },
    });
    await expect(f.options().proveClosed(f.writer)).resolves.toBeNull();
    expect(f.store.releaseClosedWriter).not.toHaveBeenCalled();
    expect(f.runtime.status().state).toBe('blocked');
  });

  it('stops scheduling consumer calls and drains an in-flight dispatch before closing', async () => {
    const gate = deferred<boolean>();
    const f = fixture({ dispatch: () => gate.promise });
    const tick = f.runtime.tick();
    await vi.waitFor(() =>
      expect(f.database.dispatchNextNativeOnceOccurrence).toHaveBeenCalledTimes(
        1,
      ),
    );
    const stopping = f.runtime.stop();
    expect(f.trace).not.toContain('host-close-start');
    await f.runtime.tick();
    expect(f.database.dispatchNextNativeOnceOccurrence).toHaveBeenCalledTimes(
      1,
    );
    gate.resolve(true);
    await tick;
    await stopping;
    expect(f.database.dispatchNextNativeOnceOccurrence).toHaveBeenCalledTimes(
      1,
    );
    expect(f.runtime.status().state).toBe('closed');
  });

  it('does not finish late initialization after stop was requested', async () => {
    const gate = deferred<NativeSchedulePublicModules>();
    const f = fixture({ loadModules: () => gate.promise });
    const tick = f.runtime.tick();
    const stopping = f.runtime.stop();
    gate.resolve({} as NativeSchedulePublicModules);
    await tick;
    await stopping;
    expect(f.loadDatabase).not.toHaveBeenCalled();
    expect(f.hostFactory).not.toHaveBeenCalled();
  });

  it('reports missing production APIs explicitly without starting a Host', async () => {
    const f = fixture({ testPorts: { loadDatabase: undefined } });
    await expect(f.runtime.tick()).rejects.toMatchObject({
      fault: { phase: 'initialization', code: 'database_api_unavailable' },
    });
    expect(f.hostFactory).not.toHaveBeenCalled();
  });

  it('does not fall back to other modules or touch the DB when approved loading fails', async () => {
    const f = fixture({
      loadModules: async () => {
        throw new Error('private-provider-key');
      },
    });
    await expect(f.runtime.tick()).rejects.toMatchObject({
      fault: { phase: 'initialization', code: 'initialization_failed' },
    });
    expect(f.loadDatabase).not.toHaveBeenCalled();
    expect(f.hostFactory).not.toHaveBeenCalled();
    expect(JSON.stringify(f.runtime.status())).not.toContain(
      'private-provider-key',
    );
  });
});
