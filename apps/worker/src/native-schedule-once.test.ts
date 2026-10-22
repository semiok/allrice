import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SessionId } from '@deepseek-ai/dsh-session';
import {
  ScheduleId,
  scheduleDomain,
  type ScheduleCatalogEntry,
  type ScheduleTask,
} from '@deepseek-ai/dsh-schedule';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { KvUnit } from '@deepseek-ai/dsh-storage';
import {
  workspaceRecord,
  workspaceDomainState,
} from '@deepseek-ai/dsh-workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNativeScheduleOnceController,
  NativeScheduleOnceError,
  openPublicNativeScheduleOnceHost,
  type NativeScheduleControl,
  type NativeScheduleAnyControl,
  type NativeScheduleRecurringControl,
  type NativeScheduleRecurringRule,
  type NativeScheduleControlHost,
  type NativeScheduleControlReference,
  type NativeScheduleControlSource,
  type NativeScheduleHostFactory,
  type NativeScheduleHostModule,
  type NativeScheduleMutation,
  type NativeScheduleOnceStore,
  type NativeSchedulePublicModules,
  type NativeScheduleWrite,
  type NativeScheduleWriter,
  type NativeScheduleWorkspaceSnapshot,
  type NativeScheduleWorkspaceWrite,
} from './native-schedule-once.js';

const TITLE = 'AllRice once control',
  PROMPT = 'Synthetic schedule control only. Never execute business work.';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(test: () => boolean, label: string) {
  const deadline = Date.now() + 8000;
  while (!test()) {
    if (Date.now() > deadline) throw Error(label);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function row(
  overrides: Partial<NativeScheduleControl> = {},
): NativeScheduleControl {
  return {
    controlId: randomUUID(),
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    automationId: randomUUID(),
    revision: 1,
    controlSessionId: `control-${randomUUID()}`,
    at: '2030-01-01T00:00:00.000Z',
    sessionState: 'reserved',
    nativeTaskId: null,
    taskDeleted: false,
    command: { id: randomUUID(), kind: 'create', status: 'pending' },
    ...overrides,
  };
}
function recurringRecordFields(rule: NativeScheduleRecurringRule) {
  if (rule.kind === 'every')
    return { kind: 'every' as const, everySeconds: rule.seconds };
  if (rule.kind === 'weekly')
    return {
      kind: 'weekly' as const,
      time: `${rule.time}.000`,
      timeZone: rule.timezone,
      weekdays: [...rule.weekdays],
    };
  return {
    kind: 'daily' as const,
    time: `${rule.time}.000`,
    timeZone: rule.timezone,
  };
}
function fixture<C extends NativeScheduleAnyControl = NativeScheduleControl>(
  initial: C[] = [row()] as unknown as C[],
) {
  const trace: string[] = [],
    rows = structuredClone(initial),
    records = new Map<string, ScheduleTask>(),
    journal = new Map<string, NativeScheduleWrite>();
  let workspace: NativeScheduleWorkspaceSnapshot = {
    unitVersion: 2,
    revision: 0,
    tables: { workspaces: {} },
    global: null,
  };
  const workspaceJournal = new Map<string, NativeScheduleWorkspaceWrite>();
  const persistedSessions = new Set(
    rows
      .filter((c) => c.sessionState === 'ready')
      .map((c) => c.controlSessionId),
  );
  const reference: NativeScheduleControlReference = {
    artifactId: 'synthetic-artifact',
    profileId: 'schedule-once-control-v1',
    storageId: 'synthetic-storage',
    stateRoot: join(tmpdir(), 'synthetic-never-created'),
  };
  let epoch = 0,
    validFence = true,
    faultKind: NativeScheduleMutation['kind'] | undefined,
    commitBeforeFault = true,
    readUnknown = false;
  let ttl = 30_000,
    initializationGate: Promise<void> | undefined,
    closeGate: Promise<void> | undefined,
    failClose = false;
  const writer = (): NativeScheduleWriter => ({
    partitionId: 'control-partition',
    ownerId: 'worker',
    epoch,
    token: `lease-${epoch}`,
  });
  function apply(write: NativeScheduleWrite) {
    const m = write.mutation,
      c = rows.find((r) => r.controlId === m.controlId)!;
    if (!c || c.kind === 'calendar') throw Error('fixture mapping missing');
    if (m.kind === 'session_initializing') c.sessionState = 'initializing';
    if (m.kind === 'session_ready') c.sessionState = 'ready';
    if (m.kind === 'put_task') {
      if (c.nativeTaskId && c.nativeTaskId !== m.task.record.id)
        throw Error('fixture rebinding');
      c.nativeTaskId = m.task.record.id;
      records.set(m.task.record.id, structuredClone(m.task));
    }
    if (m.kind === 'delete_task') {
      records.delete(m.nativeTaskId);
      c.taskDeleted = true;
    }
    if (m.kind === 'confirm_command') {
      c.command.status = 'confirmed';
      if (c.kind === 'recurring' && c.command.kind !== 'delete') {
        c.appliedRevision = c.revision;
        c.appliedRule = structuredClone(c.rule);
      }
    }
    if (m.kind === 'reject_command') c.command.status = 'blocked';
    journal.set(write.writeId, structuredClone(write));
  }
  const store: NativeScheduleOnceStore = {
    acquireWriter: vi.fn(async () => {
      epoch++;
      trace.push(`acquire:${epoch}`);
      return {
        writer: writer(),
        remainingMs: ttl,
        reference,
        controls: structuredClone(rows),
      };
    }),
    renewWriter: vi.fn(async (lease) => ({
      writer: { ...lease },
      remainingMs: ttl,
    })),
    assertWriter: vi.fn(async (lease) => validFence && lease.epoch === epoch),
    loadControls: vi.fn(async () => structuredClone(rows)),
    loadTaskRecords: vi.fn(async () =>
      Object.fromEntries(
        [...records.entries()].map(([key, value]) => [
          key,
          structuredClone(value),
        ]),
      ),
    ),
    commitMutation: vi.fn(async (lease, write) => {
      trace.push(`commit:${write.mutation.kind}:${lease.epoch}`);
      if (!validFence || lease.epoch !== epoch) return 'rejected';
      if (write.mutation.kind === faultKind) {
        faultKind = undefined;
        if (commitBeforeFault) apply(write);
        throw Error('injected ACK loss, not a SQL transaction proof');
      }
      apply(write);
      return 'committed';
    }),
    readExactCommit: vi.fn(async (_, write) => {
      trace.push('exact-readback');
      return !readUnknown &&
        JSON.stringify(journal.get(write.writeId)) === JSON.stringify(write)
        ? 'committed'
        : 'unknown';
    }),
    loadWorkspaceUnit: vi.fn(async () => structuredClone(workspace)),
    commitWorkspaceWrite: vi.fn(async (lease, write) => {
      if (
        !validFence ||
        lease.epoch !== epoch ||
        write.expectedRevision !== workspace.revision
      )
        throw Error('fixture workspace fence/CAS rejected');
      trace.push(`workspace-write:${lease.epoch}`);
      const next = structuredClone(workspace),
        mutation = write.mutation;
      if (mutation.kind === 'put_record')
        next.tables.workspaces[mutation.key] = structuredClone(mutation.value);
      else if (mutation.kind === 'delete_record')
        delete next.tables.workspaces[mutation.key];
      else next.global = structuredClone(mutation.value);
      next.revision++;
      workspace = next;
      workspaceJournal.set(write.writeId, structuredClone(write));
      return { revision: workspace.revision };
    }),
    releaseClosedWriter: vi.fn(async (lease) => {
      trace.push(`release:${lease.epoch}`);
    }),
  };
  const source: NativeScheduleControlSource = {
    reference,
    loadModules: vi.fn(
      async () =>
        ({
          workspace: { workspaceRecord, workspaceDomainState },
        }) as NativeSchedulePublicModules,
    ),
    loadHostFactory: vi.fn(async () => {
      throw Error('fake Host test must not load a public Host');
    }),
  };
  type FakeHost = NativeScheduleControlHost & {
    unit?: KvUnit;
    auxiliaryUnit?: KvUnit;
    cache: Map<string, ScheduleTask>;
    receipt(id: string): Promise<void>;
    number: number;
  };
  const hosts: FakeHost[] = [];
  let creations = 0;
  let updates = 0,
    updateConflict = false;
  const factory: NativeScheduleHostFactory = vi.fn(
    async ({ backend, auxiliaryBackend }) => {
      const number = hosts.length + 1,
        cache = new Map<string, ScheduleTask>(),
        inFlight = new Set<Promise<unknown>>();
      for (const [name, port] of [
        ['schedule', backend],
        ['auxiliary', auxiliaryBackend],
      ] as const) {
        const close = port.close.bind(port);
        port.close = async () => {
          await close();
          trace.push(`${name}-backend-drained:${number}`);
        };
      }
      function track<T>(work: () => Promise<T>): Promise<T> {
        const task = Promise.resolve().then(work);
        inFlight.add(task);
        void task.finally(() => inFlight.delete(task)).catch(() => undefined);
        return task;
      }
      const h: FakeHost = {
        number,
        cache,
        async boot() {
          trace.push(`boot:${number}`);
          h.auxiliaryUnit = await auxiliaryBackend.kv!.open({
            name: 'workspace',
            version: 2,
            tables: ['workspaces'],
            hasGlobal: true,
          });
          await h.auxiliaryUnit!.loadAll();
        },
        decodeTask(value) {
          return scheduleDomain.tables.tasks.valueSchema.parse(value);
        },
        initializeSession(id) {
          return track(async () => {
            trace.push(`init:${id}`);
            await initializationGate;
            persistedSessions.add(id);
          });
        },
        async resumeSession(id) {
          trace.push(`resume:${id}`);
          if (!persistedSessions.has(id)) throw Error('missing SDK history');
        },
        async mountSchedule() {
          trace.push(`mount:${number}`);
          const unit = await backend.kv!.open({
            name: 'schedule',
            version: 1,
            tables: ['tasks'],
            hasGlobal: false,
          });
          h.unit = unit;
          const loaded = await unit.loadAll();
          for (const [id, value] of Object.entries(loaded.tables.tasks!))
            cache.set(id, h.decodeTask(value));
        },
        async catalog() {
          return [...cache.values()].map((task) => ({
            ...task.record,
            sessionId: task.sessionId,
            status: task.status,
            ...(task.lastDelivery ? { lastDelivery: task.lastDelivery } : {}),
          }));
        },
        createOnce(id, at) {
          return track(async () => {
            creations++;
            trace.push(`create:${number}`);
            const task: ScheduleTask = {
              sessionId: SessionId(id),
              record: {
                id: ScheduleId(`native-${creations}`),
                kind: 'at',
                title: TITLE,
                prompt: PROMPT,
                scheduledAt: at,
              },
              status: 'active',
              deliveryHistory: {
                records: [],
                earlierRecordsUnavailable: false,
              },
            };
            await h.unit!.putRecord('tasks', task.record.id, task);
            cache.set(task.record.id, task);
            return task.record;
          });
        },
        createRecurring(id, rule) {
          return track(async () => {
            creations++;
            trace.push(`create-recurring:${number}`);
            const task: ScheduleTask = {
              sessionId: SessionId(id),
              status: 'active',
              record: {
                id: ScheduleId(`native-${creations}`),
                title: TITLE,
                prompt: PROMPT,
                scheduledAt: '2030-01-01T00:00:00.000Z',
                ...recurringRecordFields(rule),
              },
              deliveryHistory: {
                records: [],
                earlierRecordsUnavailable: false,
              },
            };
            await h.unit!.putRecord('tasks', task.record.id, task);
            cache.set(task.record.id, task);
            return task.record;
          });
        },
        updateRecurring(sessionId, id, expected, rule) {
          return track(async () => {
            updates++;
            trace.push(`update-recurring:${number}`);
            const old = cache.get(id)!;
            if (
              old.sessionId !== sessionId ||
              JSON.stringify(old.record) !== JSON.stringify(expected)
            )
              throw Error('expected must contain the full exact record');
            if (updateConflict) {
              updateConflict = false;
              return null;
            }
            const same =
              old.record.kind === rule.kind &&
              (rule.kind === 'every'
                ? old.record.kind === 'every' &&
                  old.record.everySeconds === rule.seconds
                : (old.record.kind === 'daily' ||
                    old.record.kind === 'weekly') &&
                  old.record.time === `${rule.time}.000` &&
                  old.record.timeZone === rule.timezone &&
                  (rule.kind !== 'weekly' ||
                    (old.record.kind === 'weekly' &&
                      JSON.stringify(old.record.weekdays) ===
                        JSON.stringify(rule.weekdays))));
            if (same) return old.record; // Public Schedule no-op performs no KV write.
            const task: ScheduleTask = {
              ...old,
              record: {
                id: old.record.id,
                title: TITLE,
                prompt: PROMPT,
                scheduledAt: '2030-01-01T01:00:00.000Z',
                ...recurringRecordFields(rule),
              },
            };
            await h.unit!.putRecord('tasks', id, task);
            cache.set(id, task);
            return task.record;
          });
        },
        deleteOnce(_session, id) {
          return track(async () => {
            await h.unit!.deleteRecord('tasks', id);
            cache.delete(id);
          });
        },
        receipt(id) {
          return track(async () => {
            const old = cache.get(id)!;
            const task: ScheduleTask = {
              ...old,
              status: 'inactive',
              lastDelivery: {
                scheduledAt: old.record.scheduledAt,
                deliveredAt: new Date().toISOString(),
                messageId: `message-${id}` as NonNullable<
                  ScheduleTask['lastDelivery']
                >['messageId'],
              },
            };
            task.deliveryHistory = {
              records: [{ ...task.lastDelivery!, prompt: PROMPT }],
              earlierRecordsUnavailable: false,
            };
            await h.unit!.putRecord('tasks', id, task);
            cache.set(id, task);
          });
        },
        async close() {
          trace.push(`schedule-drain:${number}`);
          await closeGate;
          await Promise.allSettled([...inFlight]);
          await h.unit?.close();
          await h.auxiliaryUnit?.close();
          trace.push(`sdk-shutdown:${number}`);
          trace.push(`root-dispose:${number}`);
          if (failClose) throw Error('injected public shutdown failure');
        },
      };
      hosts.push(h);
      return h;
    },
  );
  return {
    store,
    source,
    factory,
    trace,
    rows,
    records,
    journal,
    workspaceJournal,
    hosts,
    persistedSessions,
    workspace: () => structuredClone(workspace),
    setWorkspace(value: NativeScheduleWorkspaceSnapshot) {
      workspace = value;
    },
    setFence(value: boolean) {
      validFence = value;
    },
    setEpoch(value: number) {
      epoch = value;
    },
    setTtl(value: number) {
      ttl = value;
    },
    setInitGate(value: Promise<void>) {
      initializationGate = value;
    },
    setCloseGate(value: Promise<void>) {
      closeGate = value;
    },
    failShutdown() {
      failClose = true;
    },
    loseAck(
      kind: NativeScheduleMutation['kind'],
      commit = true,
      unknown = false,
    ) {
      faultKind = kind;
      commitBeforeFault = commit;
      readUnknown = unknown;
    },
    create(options: { enabled?: boolean } = { enabled: true }) {
      return createNativeScheduleOnceController({
        ...options,
        store,
        source,
        hostFactory: factory,
        now: () => Date.now(),
      });
    },
    creations() {
      return creations;
    },
    updates() {
      return updates;
    },
    conflictNextUpdate() {
      updateConflict = true;
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it('reopens before admitting a Session added between refresh and calendar commands', async () => {
  const first = row(),
    second = row(),
    f = fixture([first]);
  const unexpected = vi.fn(async () => {
    throw Error('unexpected calendar Task mutation');
  });
  f.store.calendar = {
    loadCalendarState: vi.fn(async () => ({ controls: [], bindings: [] })),
    materialize: vi.fn(async () => false),
    beginCalendarArmCreate: unexpected,
    confirmCalendarArmAbsent: unexpected,
    prepareCalendarArm: unexpected,
    readExactCalendarArm: unexpected,
    readExactCalendarRetirement: unexpected,
  };
  let added = false;
  vi.spyOn(f.store, 'loadControls').mockImplementation(async () => {
    if (!added && f.trace.includes('mount:1')) {
      added = true;
      f.rows.push(structuredClone(second));
    }
    return structuredClone(f.rows);
  });
  const controller = f.create();
  try {
    await controller.tick();
    expect(added).toBe(true);
    expect(controller.status().state).toBe('cold');
    expect(f.creations()).toBe(0);
    expect(f.trace).toContain('release:1');
    await controller.tick();
    expect(controller.status().state).toBe('active');
    expect(f.trace.indexOf(`init:${second.controlSessionId}`)).toBeLessThan(
      f.trace.indexOf('mount:2'),
    );
    expect(f.trace).toContain(`resume:${first.controlSessionId}`);
    expect(f.creations()).toBe(2);
  } finally {
    await controller.stop();
  }
});

describe('once target_not_future catalog absence', () => {
  function rejectedCreate() {
    const f = fixture(),
      open = vi.mocked(f.factory).getMockImplementation()!,
      create = vi
        .fn<NativeScheduleControlHost['createOnce']>()
        .mockRejectedValue(new NativeScheduleOnceError('target_not_future')),
      catalog = vi
        .fn<NativeScheduleControlHost['catalog']>()
        .mockResolvedValue([]);
    vi.mocked(f.factory).mockImplementation(async (input) => {
      const host = await open(input);
      host.createOnce = create;
      host.catalog = catalog;
      return host;
    });
    return { ...f, createOnce: create, catalog };
  }
  function task(
    sessionId: string,
    status: 'active' | 'inactive',
  ): ScheduleCatalogEntry {
    return {
      id: ScheduleId('existing-native-task'),
      kind: 'at',
      prompt: PROMPT,
      scheduledAt: '2030-01-01T00:00:00.000Z',
      sessionId: SessionId(sessionId),
      status,
      title: TITLE,
      ...(status === 'inactive'
        ? {
            lastDelivery: {
              scheduledAt: '2030-01-01T00:00:00.000Z',
              deliveredAt: '2030-01-01T00:00:01.000Z',
              messageId: 'existing-delivery' as NonNullable<
                ScheduleTask['lastDelivery']
              >['messageId'],
            },
          }
        : {}),
    };
  }
  const rejections = (f: ReturnType<typeof rejectedCreate>) =>
    vi
      .mocked(f.store.commitMutation)
      .mock.calls.map(([, write]) => write)
      .filter((write) => write.mutation.kind === 'reject_command');

  it('records a fresh empty catalog and wall-clock observation exactly once', async () => {
    const f = rejectedCreate(),
      c = f.create(),
      startedAt = Date.now();
    try {
      await c.tick();
      const [write] = rejections(f);
      expect(write?.mutation).toEqual({
        kind: 'reject_command',
        controlId: f.rows[0]!.controlId,
        commandId: f.rows[0]!.command.id,
        reason: 'target_not_future',
        absence: {
          controlSessionId: f.rows[0]!.controlSessionId,
          catalogDigest:
            'sha256:' + createHash('sha256').update('[]').digest('hex'),
          observedAt: expect.any(String),
          taskCount: 0,
        },
      });
      if (write?.mutation.kind !== 'reject_command')
        throw Error('missing rejection');
      const observedAt = write.mutation.absence!.observedAt;
      expect(new Date(observedAt).toISOString()).toBe(observedAt);
      expect(Date.parse(observedAt)).toBeGreaterThanOrEqual(startedAt);
      expect(Date.parse(observedAt)).toBeLessThanOrEqual(Date.now());
      expect(f.catalog).toHaveBeenCalledTimes(2);
      expect(f.createOnce).toHaveBeenCalledTimes(1);
      expect(f.catalog.mock.invocationCallOrder[1]).toBeGreaterThan(
        f.createOnce.mock.invocationCallOrder[0]!,
      );
      expect(f.rows[0]!.command.status).toBe('blocked');
      await c.tick();
      expect(rejections(f)).toHaveLength(1);
      expect(f.createOnce).toHaveBeenCalledTimes(1);
    } finally {
      await c.stop();
    }
  });

  it('hashes the complete catalog while allowing another Session task', async () => {
    const f = rejectedCreate(),
      other = task('another-control-session', 'active'),
      c = f.create();
    f.catalog.mockResolvedValueOnce([]).mockResolvedValueOnce([other]);
    try {
      await c.tick();
      const [write] = rejections(f);
      if (write?.mutation.kind !== 'reject_command')
        throw Error('missing rejection');
      // The fixture record above is already in the digest's canonical key order.
      expect(write.mutation.absence?.catalogDigest).toBe(
        'sha256:' +
          createHash('sha256')
            .update(JSON.stringify([other]))
            .digest('hex'),
      );
      expect(write.mutation.absence?.taskCount).toBe(0);
    } finally {
      await c.stop();
    }
  });

  it.each(['active', 'inactive'] as const)(
    'refuses a rejection when the fresh catalog contains a %s Task for this Session',
    async (status) => {
      const f = rejectedCreate(),
        c = f.create();
      f.catalog
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([task(f.rows[0]!.controlSessionId, status)]);
      try {
        await expect(c.tick()).rejects.toMatchObject({ code: 'task_invalid' });
        expect(rejections(f)).toHaveLength(0);
        expect(f.rows[0]!.command.status).toBe('pending');
        expect(f.trace.indexOf('schedule-drain:1')).toBeLessThan(
          f.trace.indexOf('release:1'),
        );
      } finally {
        await c.stop();
      }
    },
  );

  it('drains without a rejection when the fresh catalog read fails', async () => {
    const f = rejectedCreate(),
      c = f.create();
    f.catalog
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(Error('catalog unavailable'));
    try {
      await expect(c.tick()).rejects.toThrow('catalog unavailable');
      expect(rejections(f)).toHaveLength(0);
      expect(f.rows[0]!.command.status).toBe('pending');
      expect(c.status().fault).toBe('host_failed');
      expect(f.trace).toContain('root-dispose:1');
      expect(f.trace).toContain('release:1');
    } finally {
      await c.stop();
    }
  });

  it('refuses a malformed catalog entry without asserting absence', async () => {
    const f = rejectedCreate(),
      c = f.create();
    f.catalog
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{} as ScheduleCatalogEntry]);
    try {
      await expect(c.tick()).rejects.toMatchObject({ code: 'task_invalid' });
      expect(rejections(f)).toHaveLength(0);
    } finally {
      await c.stop();
    }
  });

  it('reads the exact absence write after an unknown ACK and never creates a replacement', async () => {
    const f = rejectedCreate(),
      c = f.create();
    f.loseAck('reject_command', true, true);
    try {
      await expect(c.tick()).rejects.toMatchObject({ code: 'ack_unknown' });
      const [write] = rejections(f);
      expect(write?.mutation.kind).toBe('reject_command');
      expect(f.store.readExactCommit).toHaveBeenCalledTimes(1);
      expect(vi.mocked(f.store.readExactCommit).mock.calls[0]?.[1]).toEqual(
        write,
      );
      await c.tick();
      expect(f.hosts).toHaveLength(2);
      expect(f.trace.indexOf('root-dispose:1')).toBeLessThan(
        f.trace.indexOf('acquire:2'),
      );
      expect(rejections(f)).toHaveLength(1);
      expect(f.createOnce).toHaveBeenCalledTimes(1);
      expect(f.records.size).toBe(0);
      expect(f.rows[0]!.command.status).toBe('blocked');
    } finally {
      await c.stop();
    }
  });
});

describe('default-off once Worker controller; store is a scripted control fixture, not SQL admission', () => {
  it('does nothing unless explicitly enabled, including no module/DB/Host loading', async () => {
    const f = fixture(),
      c = f.create({});
    await c.tick();
    await c.stop();
    expect(c.status().state).toBe('disabled');
    expect(f.store.acquireWriter).not.toHaveBeenCalled();
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.source.loadModules).not.toHaveBeenCalled();
    expect(f.source.loadHostFactory).not.toHaveBeenCalled();
  });
  it('initializes only fixed reserved Sessions, then mounts Schedule, preserving one binding per revision', async () => {
    const f = fixture([row(), row()]),
      c = f.create();
    try {
      await c.tick();
      expect(c.status().state).toBe('active');
      for (const control of f.rows)
        expect(
          f.trace.indexOf(`init:${control.controlSessionId}`),
        ).toBeLessThan(f.trace.indexOf('mount:1'));
      expect(f.creations()).toBe(2);
      expect(
        f.rows.every(
          (r) =>
            r.sessionState === 'ready' &&
            r.nativeTaskId &&
            r.command.status === 'confirmed',
        ),
      ).toBe(true);
      await c.tick();
      expect(f.creations()).toBe(2);
      const writes = vi
        .mocked(f.store.commitMutation)
        .mock.calls.map(([, write]) => write);
      expect(
        writes.every((write) => /^sha256:[a-f0-9]{64}$/.test(write.digest)),
      ).toBe(true);
      expect(new Set(writes.map((write) => write.writeId)).size).toBe(
        writes.length,
      );
    } finally {
      await c.stop();
    }
    expect(f.trace.indexOf('schedule-drain:1')).toBeLessThan(
      f.trace.indexOf('sdk-shutdown:1'),
    );
    expect(f.trace.indexOf('root-dispose:1')).toBeLessThan(
      f.trace.indexOf('release:1'),
    );
  });
  it.each(['ready', 'initializing'] as const)(
    'restores %s history by SDK only and fails missing history without replacement',
    async (sessionState) => {
      const f = fixture([row({ sessionState })]);
      f.persistedSessions.clear();
      const c = f.create();
      await expect(c.tick()).rejects.toMatchObject({ code: 'history_missing' });
      expect(f.trace.some((t) => t.startsWith('init:'))).toBe(false);
      expect(f.trace).not.toContain('mount:1');
      expect(f.creations()).toBe(0);
      await c.stop();
    },
  );
  it('repairs committed-write ACK only by this exact journal digest and keeps the current cache aligned', async () => {
    const f = fixture(),
      c = f.create();
    f.loseAck('put_task');
    try {
      await c.tick();
      expect(c.status().state).toBe('active');
      expect(f.creations()).toBe(1);
      expect(f.store.readExactCommit).toHaveBeenCalledTimes(1);
      const [, read] = vi.mocked(f.store.readExactCommit).mock.calls[0]!;
      const original = vi
        .mocked(f.store.commitMutation)
        .mock.calls.find(([, write]) => write.writeId === read.writeId)![1];
      expect(read).toEqual(original);
      expect(f.trace).not.toContain('sdk-shutdown:1');
    } finally {
      await c.stop();
    }
  });
  it('unknown create ACK stops current KV admission, closes it, then adopts the bound task without another create', async () => {
    const f = fixture(),
      c = f.create();
    f.loseAck('put_task', true, true);
    await expect(c.tick()).rejects.toMatchObject({ code: 'ack_unknown' });
    expect(f.creations()).toBe(1);
    expect(f.records.size).toBe(1);
    const attempts = vi.mocked(f.store.commitMutation).mock.calls.length;
    await expect(
      f.hosts[0]!.unit!.putRecord(
        'tasks',
        'native-1',
        [...f.records.values()][0],
      ),
    ).rejects.toBeInstanceOf(NativeScheduleOnceError);
    expect(f.store.commitMutation).toHaveBeenCalledTimes(attempts);
    await c.tick();
    expect(f.hosts.length).toBe(2);
    expect(f.creations()).toBe(1);
    expect(f.trace.indexOf('root-dispose:1')).toBeLessThan(
      f.trace.indexOf('acquire:2'),
    );
    expect(
      f.trace.indexOf(`resume:${f.rows[0]!.controlSessionId}`),
    ).toBeLessThan(f.trace.indexOf('mount:2'));
    expect(f.rows[0]!.command.status).toBe('confirmed');
    await c.stop();
  });
  it('unknown receipt ACK does not self-await disposal and preserves exact occurrence target, not current time', async () => {
    const f = fixture(),
      c = f.create();
    await c.tick();
    f.loseAck('put_task', true, true);
    await expect(f.hosts[0]!.receipt('native-1')).rejects.toMatchObject({
      code: 'ack_unknown',
    });
    await until(
      () => f.trace.includes('release:1'),
      'Host failed to drain outside putRecord',
    );
    const task = f.records.get('native-1')!;
    expect(task.lastDelivery?.scheduledAt).toBe(f.rows[0]!.at);
    await c.tick();
    expect(f.creations()).toBe(1);
    expect(f.hosts[1]!.cache.get('native-1')?.status).toBe('inactive');
    await c.stop();
  });
  it('quarantines writes immediately and waits for the old public Host to finish before reacquiring', async () => {
    const f = fixture(),
      c = f.create(),
      gate = deferred<void>();
    await c.tick();
    f.setCloseGate(gate.promise);
    f.loseAck('put_task', true, true);
    await expect(f.hosts[0]!.receipt('native-1')).rejects.toMatchObject({
      code: 'ack_unknown',
    });
    const attempts = vi.mocked(f.store.commitMutation).mock.calls.length;
    await expect(
      f.hosts[0]!.unit!.putRecord(
        'tasks',
        'native-1',
        f.records.get('native-1'),
      ),
    ).rejects.toMatchObject({ code: 'ack_unknown' });
    const recovering = c.tick();
    await Promise.resolve();
    expect(f.store.acquireWriter).toHaveBeenCalledTimes(1);
    expect(f.store.releaseClosedWriter).not.toHaveBeenCalled();
    expect(f.store.commitMutation).toHaveBeenCalledTimes(attempts);
    gate.resolve();
    await recovering;
    expect(f.store.acquireWriter).toHaveBeenCalledTimes(2);
    expect(f.creations()).toBe(1);
    await c.stop();
  });
  it('does not report active when an already bound native task is missing on cold load', async () => {
    const f = fixture(),
      first = f.create();
    await first.tick();
    await first.stop();
    f.records.clear();
    const second = f.create();
    await expect(second.tick()).rejects.toMatchObject({ code: 'task_invalid' });
    expect(f.creations()).toBe(1);
    expect(second.status().state).toBe('quarantined');
    await second.stop();
  });
  it('rejects non-synthetic native task content before DB write and closes the cached Host', async () => {
    const f = fixture(),
      c = f.create();
    await c.tick();
    const task = structuredClone(f.records.get('native-1')!);
    task.record = { ...task.record, prompt: 'Forbidden business instruction' };
    const attempts = vi.mocked(f.store.commitMutation).mock.calls.length;
    await expect(
      f.hosts[0]!.unit!.putRecord('tasks', 'native-1', task),
    ).rejects.toMatchObject({ code: 'task_invalid' });
    await until(
      () => f.trace.includes('release:1'),
      'invalid task did not close Host',
    );
    expect(f.store.commitMutation).toHaveBeenCalledTimes(attempts);
    await c.stop();
  });
  it('an uncommitted write with unknown readback cannot be accepted from a later row', async () => {
    const f = fixture(),
      c = f.create();
    f.loseAck('put_task', false, true);
    await expect(c.tick()).rejects.toMatchObject({ code: 'ack_unknown' });
    expect(f.records.size).toBe(0);
    expect(f.hosts[0]!.cache.size).toBe(0);
    expect(f.store.readExactCommit).toHaveBeenCalledTimes(1);
    await c.stop();
  });
  it('unknown command-confirm ACK recovers the existing native ID rather than creating again', async () => {
    const f = fixture(),
      c = f.create();
    f.loseAck('confirm_command', false, true);
    await expect(c.tick()).rejects.toMatchObject({ code: 'ack_unknown' });
    expect(f.rows[0]!.nativeTaskId).toBe('native-1');
    await c.tick();
    expect(f.creations()).toBe(1);
    expect(f.rows[0]!.command.status).toBe('confirmed');
    await c.stop();
  });
  it.each(['lease', 'epoch'] as const)(
    '%s rejection closes the Host and denies later native writes before store commit',
    async (kind) => {
      const f = fixture(),
        c = f.create();
      await c.tick();
      if (kind === 'lease') f.setFence(false);
      else f.setEpoch(99);
      await expect(c.tick()).rejects.toMatchObject({ code: 'lease_lost' });
      const attempts = vi.mocked(f.store.commitMutation).mock.calls.length;
      await expect(f.hosts[0]!.receipt('native-1')).rejects.toBeInstanceOf(
        NativeScheduleOnceError,
      );
      expect(f.store.commitMutation).toHaveBeenCalledTimes(attempts);
      await c.stop();
    },
  );
  it('conservative local lease expiry stops new admission without another producer tick', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T00:00:00.000Z'));
    const f = fixture(),
      c = f.create();
    f.setTtl(1000);
    await c.tick();
    await vi.advanceTimersByTimeAsync(1001);
    expect(c.status().fault).toBe('lease_lost');
    const attempts = vi.mocked(f.store.commitMutation).mock.calls.length;
    await expect(f.hosts[0]!.receipt('native-1')).rejects.toBeInstanceOf(
      NativeScheduleOnceError,
    );
    expect(f.store.commitMutation).toHaveBeenCalledTimes(attempts);
    await c.stop();
  });
  it('new control revisions cold-rebuild only after the old public Host has closed', async () => {
    const f = fixture(),
      c = f.create();
    await c.tick();
    f.rows.push(row({ automationId: f.rows[0]!.automationId, revision: 2 }));
    await c.tick();
    expect(c.status().state).toBe('cold');
    expect(f.hosts.length).toBe(1);
    await c.tick();
    expect(f.hosts.length).toBe(2);
    expect(f.creations()).toBe(2);
    expect(f.trace.indexOf('release:1')).toBeLessThan(
      f.trace.indexOf('acquire:2'),
    );
    await c.stop();
  });
  it.each(['session', 'revision', 'native-id'] as const)(
    'rejects duplicate %s bindings before opening a Host',
    async (kind) => {
      const first = row(),
        second = row();
      if (kind === 'session') second.controlSessionId = first.controlSessionId;
      if (kind === 'revision') {
        second.automationId = first.automationId;
        second.revision = first.revision;
      }
      if (kind === 'native-id') {
        first.sessionState = second.sessionState = 'ready';
        first.nativeTaskId = second.nativeTaskId = 'same-id';
      }
      const f = fixture([first, second]),
        c = f.create();
      await expect(c.tick()).rejects.toMatchObject({ code: 'binding_invalid' });
      expect(f.factory).not.toHaveBeenCalled();
      await c.stop();
    },
  );
  it('refuses a different artifact/storage tuple before module loading', async () => {
    const f = fixture();
    const source = {
      ...f.source,
      reference: { ...f.source.reference, storageId: 'different' },
    };
    const c = createNativeScheduleOnceController({
      enabled: true,
      store: f.store,
      source,
      hostFactory: f.factory,
    });
    await expect(c.tick()).rejects.toMatchObject({ code: 'binding_invalid' });
    expect(f.factory).not.toHaveBeenCalled();
    await c.stop();
  });
  it('stops while initialization is in flight without mounting Schedule or releasing the writer early', async () => {
    const f = fixture(),
      c = f.create(),
      gate = deferred<void>();
    f.setInitGate(gate.promise);
    const tick = c.tick();
    const rejected = expect(tick).rejects.toMatchObject({ code: 'closed' });
    await until(
      () => f.trace.some((s) => s.startsWith('init:')),
      'initialization not entered',
    );
    const stopped = c.stop();
    expect(f.store.releaseClosedWriter).not.toHaveBeenCalled();
    gate.resolve();
    await rejected;
    await stopped;
    expect(f.trace).not.toContain('mount:1');
    expect(c.status().state).toBe('closed');
  });
  it('drains an already admitted command CAS before releasing the closed Host writer', async () => {
    const f = fixture(),
      c = f.create(),
      entered = deferred<void>(),
      gate = deferred<void>();
    const commit = vi.mocked(f.store.commitMutation).getMockImplementation()!;
    vi.mocked(f.store.commitMutation).mockImplementation(
      async (writer, write) => {
        if (write.mutation.kind === 'confirm_command') {
          entered.resolve();
          await gate.promise;
        }
        return commit(writer, write);
      },
    );
    const ticking = c.tick();
    await entered.promise;
    const stopped = c.stop();
    await until(
      () => f.trace.includes('root-dispose:1'),
      'public Host did not close',
    );
    expect(f.store.releaseClosedWriter).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([ticking, stopped]);
    expect(f.rows[0]!.command.status).toBe('confirmed');
    expect(f.store.releaseClosedWriter).toHaveBeenCalledTimes(1);
  });
  it('does not acquire another writer or release ownership if public shutdown fails', async () => {
    const f = fixture(),
      c = f.create();
    await c.tick();
    f.failShutdown();
    await expect(c.stop()).rejects.toMatchObject({ code: 'shutdown_failed' });
    await c.tick();
    expect(c.status().state).toBe('blocked');
    expect(f.store.acquireWriter).toHaveBeenCalledTimes(1);
    expect(f.store.releaseClosedWriter).not.toHaveBeenCalled();
  });
  it('deletes only the exact bound task and retains its mapping/tombstone', async () => {
    const f = fixture(),
      c = f.create();
    await c.tick();
    const original = f.rows[0]!.nativeTaskId;
    f.rows[0]!.command = {
      id: randomUUID(),
      kind: 'delete',
      status: 'pending',
    };
    await c.tick();
    expect(f.rows[0]!.nativeTaskId).toBe(original);
    expect(f.rows[0]!.taskDeleted).toBe(true);
    expect(f.records.size).toBe(0);
    expect(f.creations()).toBe(1);
    await c.stop();
  });
});

const emptyWorkspaceGlobal = () => ({
  initialized: true,
  workspaceIds: [],
  archivedSessionIds: [],
  pinnedSessionIds: [],
});
function recurringRow(
  rule: NativeScheduleRecurringRule = { kind: 'every', seconds: 60 },
): NativeScheduleRecurringControl {
  const base: Omit<ReturnType<typeof row>, 'at'> & { at?: string } = row();
  delete base.at;
  return {
    ...base,
    kind: 'recurring',
    rule,
    appliedRevision: null,
    appliedRule: null,
  };
}

describe('recurring control union over the same fenced Host and KV lifecycle', () => {
  it.each<NativeScheduleRecurringRule>([
    { kind: 'every', seconds: 60 },
    { kind: 'daily', time: '09:30:00', timezone: 'Asia/Shanghai' },
    {
      kind: 'weekly',
      time: '09:30:00',
      timezone: 'Asia/Shanghai',
      weekdays: [1, 7],
    },
  ])('creates %j once across repeated ticks', async (rule) => {
    const f = fixture([recurringRow(rule)]),
      c = f.create();
    await c.tick();
    await c.tick();
    expect(f.creations()).toBe(1);
    expect(f.rows[0]!.command.status).toBe('confirmed');
    expect(f.rows[0]!.appliedRule).toEqual(rule);
    expect(f.records.get(f.rows[0]!.nativeTaskId!)!.record.kind).toBe(
      rule.kind,
    );
    await c.stop();
  });

  it.each(
    [[], [0], [8], [1, 1], [7, 1], [1.5]].map((weekdays) => ({ weekdays })),
  )(
    'rejects malformed weekly weekdays $weekdays before opening a Host',
    async ({ weekdays }) => {
      const f = fixture([
          recurringRow({
            kind: 'weekly',
            time: '09:30:00',
            timezone: 'UTC',
            weekdays,
          }),
        ]),
        c = f.create();
      try {
        await expect(c.tick()).rejects.toMatchObject({
          code: 'binding_invalid',
        });
        expect(f.factory).not.toHaveBeenCalled();
      } finally {
        await c.stop();
      }
    },
  );

  it('keeps weekly Task and Session identities across an update and cold restore', async () => {
    const f = fixture([
        recurringRow({
          kind: 'weekly',
          time: '09:30:00',
          timezone: 'UTC',
          weekdays: [1],
        }),
      ]),
      first = f.create();
    let second: ReturnType<typeof f.create> | undefined;
    try {
      await first.tick();
      const id = f.rows[0]!.nativeTaskId!,
        session = f.rows[0]!.controlSessionId;
      f.rows[0]!.revision = 2;
      f.rows[0]!.rule = {
        kind: 'weekly',
        time: '08:00:00',
        timezone: 'Europe/London',
        weekdays: [2, 7],
      };
      f.rows[0]!.command = {
        id: randomUUID(),
        kind: 'update',
        status: 'pending',
      };
      await first.tick();
      const saved = structuredClone(f.records.get(id)!);
      expect(saved.record).toMatchObject({
        kind: 'weekly',
        time: '08:00:00.000',
        timeZone: 'Europe/London',
        weekdays: [2, 7],
      });
      await first.stop();
      second = f.create();
      await second.tick();
      expect(f.rows[0]!.nativeTaskId).toBe(id);
      expect(f.rows[0]!.controlSessionId).toBe(session);
      expect(f.rows[0]!.appliedRevision).toBe(2);
      expect(f.records.get(id)).toEqual(saved);
      expect(f.creations()).toBe(1);
      expect(f.updates()).toBe(1);
      expect(f.trace).toContain(`resume:${session}`);
    } finally {
      await second?.stop();
      await first.stop();
    }
  });

  it('confirms metadata-only edits through a same-rule SDK update without resetting target', async () => {
    const f = fixture([recurringRow()]),
      c = f.create();
    await c.tick();
    const id = f.rows[0]!.nativeTaskId!,
      before = structuredClone(f.records.get(id)!);
    f.rows[0]!.revision = 2;
    f.rows[0]!.command = {
      id: randomUUID(),
      kind: 'update',
      status: 'pending',
    };
    await c.tick();
    await c.tick();
    expect(f.updates()).toBe(1);
    expect(f.creations()).toBe(1);
    expect(f.hosts).toHaveLength(1);
    expect(f.records.get(id)).toEqual(before);
    expect(f.rows[0]!.appliedRevision).toBe(2);
    expect(f.rows[0]!.nativeTaskId).toBe(id);
    await c.stop();
  });

  it('updates interval to daily with the complete observed record and keeps both IDs', async () => {
    const f = fixture([recurringRow()]),
      c = f.create();
    await c.tick();
    const id = f.rows[0]!.nativeTaskId!,
      session = f.rows[0]!.controlSessionId;
    f.rows[0]!.revision = 2;
    f.rows[0]!.rule = {
      kind: 'daily',
      time: '08:00:00',
      timezone: 'Europe/London',
    };
    f.rows[0]!.command = {
      id: randomUUID(),
      kind: 'update',
      status: 'pending',
    };
    await c.tick();
    expect(f.updates()).toBe(1);
    expect(f.creations()).toBe(1);
    expect(f.hosts).toHaveLength(1);
    expect(f.rows[0]!.nativeTaskId).toBe(id);
    expect(f.rows[0]!.controlSessionId).toBe(session);
    expect(f.records.get(id)!.record).toMatchObject({
      kind: 'daily',
      time: '08:00:00.000',
      timeZone: 'Europe/London',
    });
    await c.stop();
  });

  it('does not confirm an explicit non-mutating SDK conflict, then refreshes its expected record', async () => {
    const f = fixture([recurringRow()]),
      c = f.create();
    await c.tick();
    f.rows[0]!.revision = 2;
    f.rows[0]!.rule = { kind: 'every', seconds: 120 };
    f.rows[0]!.command = {
      id: randomUUID(),
      kind: 'update',
      status: 'pending',
    };
    f.conflictNextUpdate();
    await c.tick();
    expect(f.rows[0]!.command.status).toBe('pending');
    await c.tick();
    expect(f.rows[0]!.command.status).toBe('confirmed');
    expect(f.updates()).toBe(2);
    expect(f.creations()).toBe(1);
    await c.stop();
  });

  it('retains oldest-first full history and allows the native 200-record prune on cold restore', async () => {
    const f = fixture([recurringRow()]),
      first = f.create();
    await first.tick();
    const id = f.rows[0]!.nativeTaskId!,
      original = f.records.get(id)!;
    const history = Array.from({ length: 200 }, (_, index) => ({
      scheduledAt: new Date(Date.UTC(2030, 0, 1, 0, index)).toISOString(),
      deliveredAt: new Date(Date.UTC(2030, 0, 1, 0, index, 1)).toISOString(),
      messageId: `message-${index}` as NonNullable<
        ScheduleTask['lastDelivery']
      >['messageId'],
      prompt: PROMPT,
    }));
    const { prompt, ...lastDelivery } = history.at(-1)!;
    expect(prompt).toBe(PROMPT);
    const retained: ScheduleTask = {
      ...original,
      lastDelivery,
      record: {
        ...original.record,
        scheduledAt: new Date(Date.UTC(2030, 0, 1, 0, 200)).toISOString(),
      },
      deliveryHistory: { records: history, earlierRecordsUnavailable: false },
    };
    await f.hosts[0]!.unit!.putRecord('tasks', id, retained);
    const added = {
      scheduledAt: new Date(Date.UTC(2030, 0, 1, 0, 200)).toISOString(),
      deliveredAt: new Date(Date.UTC(2030, 0, 1, 0, 200, 1)).toISOString(),
      messageId: 'message-200' as NonNullable<
        ScheduleTask['lastDelivery']
      >['messageId'],
    };
    retained.record = {
      ...retained.record,
      scheduledAt: new Date(Date.UTC(2030, 0, 1, 0, 201)).toISOString(),
    };
    retained.lastDelivery = added;
    retained.deliveryHistory = {
      records: [...history.slice(1), { ...added, prompt: PROMPT }],
      earlierRecordsUnavailable: true,
      earlierRecordsPruned: true,
    };
    await f.hosts[0]!.unit!.putRecord('tasks', id, retained);
    expect(f.records.get(id)).toEqual(retained);
    await first.stop();
    const second = f.create();
    await second.tick();
    expect(f.creations()).toBe(1);
    expect(f.hosts[1]!.cache.get(id)).toEqual(retained);
    expect(f.trace).toContain(`resume:${f.rows[0]!.controlSessionId}`);
    await second.stop();
  });

  it('rejects oversized or reversed native receipt history before committing it', async () => {
    for (const reversed of [false, true]) {
      const f = fixture([recurringRow()]),
        c = f.create();
      await c.tick();
      const id = f.rows[0]!.nativeTaskId!,
        task = structuredClone(f.records.get(id)!);
      const records = Array.from(
        { length: reversed ? 2 : 201 },
        (_, index) => ({
          scheduledAt: new Date(
            Date.UTC(2029, 0, 1, 0, reversed ? 2 - index : index),
          ).toISOString(),
          deliveredAt: new Date(Date.UTC(2029, 0, 1, 0, index)).toISOString(),
          messageId: `history-${index}` as NonNullable<
            ScheduleTask['lastDelivery']
          >['messageId'],
        }),
      );
      task.lastDelivery = records.at(-1)!;
      task.deliveryHistory = { records, earlierRecordsUnavailable: false };
      const before = vi.mocked(f.store.commitMutation).mock.calls.length;
      await expect(
        f.hosts[0]!.unit!.putRecord('tasks', id, task),
      ).rejects.toMatchObject({ code: 'task_invalid' });
      expect(vi.mocked(f.store.commitMutation).mock.calls).toHaveLength(before);
      await c.stop();
    }
  });

  it('does not resend an unknown native receipt or create a replacement after recovery', async () => {
    const f = fixture([recurringRow()]),
      c = f.create();
    await c.tick();
    const id = f.rows[0]!.nativeTaskId!,
      task = structuredClone(f.records.get(id)!);
    task.lastDelivery = {
      scheduledAt: task.record.scheduledAt,
      deliveredAt: '2030-01-01T00:00:01.000Z',
      messageId: 'one-native-receipt' as NonNullable<
        ScheduleTask['lastDelivery']
      >['messageId'],
    };
    task.record = { ...task.record, scheduledAt: '2030-01-01T00:01:00.000Z' };
    task.deliveryHistory = {
      records: [{ ...task.lastDelivery, prompt: PROMPT }],
      earlierRecordsUnavailable: false,
    };
    f.loseAck('put_task', true, true);
    await expect(
      f.hosts[0]!.unit!.putRecord('tasks', id, task),
    ).rejects.toMatchObject({ code: 'ack_unknown' });
    await c.tick();
    expect(f.creations()).toBe(1);
    expect(
      vi
        .mocked(f.store.commitMutation)
        .mock.calls.filter(([, w]) => w.mutation.kind === 'put_task'),
    ).toHaveLength(2);
    await c.stop();
  });

  it('deletes through the existing durable KV tombstone and confirms only after it persists', async () => {
    const f = fixture([recurringRow()]),
      c = f.create();
    await c.tick();
    const id = f.rows[0]!.nativeTaskId!;
    f.rows[0]!.command = {
      id: randomUUID(),
      kind: 'delete',
      status: 'pending',
    };
    await c.tick();
    expect(f.records.has(id)).toBe(false);
    expect(f.rows[0]!.taskDeleted).toBe(true);
    expect(f.rows[0]!.command.status).toBe('confirmed');
    expect(f.rows[0]!.nativeTaskId).toBe(id);
    await c.stop();
  });
});

describe('recurring control public Host selector adapter with scripted services only', () => {
  async function adapter() {
    const record = {
      id: ScheduleId('stable-task'),
      kind: 'every' as const,
      everySeconds: 60,
      scheduledAt: '2030-01-01T00:00:00.000Z',
      title: TITLE,
      prompt: PROMPT,
    };
    let result: Record<string, unknown> = {
      id: record.id,
      updated: false,
      record,
    };
    const schedule = {
      create: vi.fn<(...args: unknown[]) => Promise<typeof record>>(
        async () => record,
      ),
      update: vi.fn<(...args: unknown[]) => Promise<typeof result>>(
        async () => result,
      ),
    };
    class Context {
      schedule = schedule;
      on() {}
    }
    const modules = {
      cordis: { Context },
      llm: { LlmAdapter: class {} },
      sessions: { SessionId },
      schedule: { ScheduleId },
      credentials: {
        credentialKey: () => 'browser-signing-only',
        CredentialProvider: class {},
      },
    } as unknown as NativeSchedulePublicModules;
    const f = fixture([]);
    const { openNativeScheduleControlHost } = (await import(
      new URL('../dsh/native-schedule-host-factory.mjs', import.meta.url).href
    )) as { openNativeScheduleControlHost: NativeScheduleHostModule };
    const host = await openNativeScheduleControlHost(
      {
        source: { ...f.source, loadModules: async () => modules },
        backend: { async close() {} },
        auxiliaryBackend: { async close() {} },
        stats: {
          preStepDenials: 0,
          modelGateDenials: 0,
          adapterCalls: 0,
          toolDenials: 0,
        },
      },
      NativeScheduleOnceError,
    );
    return {
      host,
      schedule,
      record,
      setResult(value: Record<string, unknown>) {
        result = value;
      },
    };
  }

  it('uses public every_seconds and daily.time_zone without calculating targets', async () => {
    const f = await adapter();
    await f.host.createRecurring!('same-session', {
      kind: 'every',
      seconds: 120,
    });
    await f.host.createRecurring!('same-session', {
      kind: 'daily',
      time: '09:30:00',
      timezone: 'Asia/Shanghai',
    });
    expect(f.schedule.create.mock.calls.map((args) => args[1])).toEqual([
      { title: TITLE, prompt: PROMPT, every_seconds: 120 },
      {
        title: TITLE,
        prompt: PROMPT,
        daily: { time: '09:30:00', time_zone: 'Asia/Shanghai' },
      },
    ]);
  });

  it('passes the complete expected record and accepts a proven no-op update', async () => {
    const f = await adapter();
    expect(
      await f.host.updateRecurring!('same-session', f.record.id, f.record, {
        kind: 'every',
        seconds: 60,
      }),
    ).toEqual(f.record);
    expect(f.schedule.update.mock.calls[0]![0]).toEqual({
      sessionId: SessionId('same-session'),
      id: f.record.id,
      expected: f.record,
      change: { kind: 'every', every_seconds: 60 },
      title: TITLE,
      prompt: PROMPT,
    });
  });

  it('uses the public weekly selector and complete expected-record CAS for timing edits', async () => {
    const f = await adapter();
    const rule: NativeScheduleRecurringRule = {
      kind: 'weekly',
      time: '04:15:00',
      timezone: 'Asia/Shanghai',
      weekdays: [1, 7],
    };
    await f.host.createRecurring!('same-session', rule);
    expect(f.schedule.create).toHaveBeenCalledWith(SessionId('same-session'), {
      title: TITLE,
      prompt: PROMPT,
      weekly: {
        time: '04:15:00',
        time_zone: 'Asia/Shanghai',
        weekdays: [1, 7],
      },
    });
    await f.host.updateRecurring!('same-session', f.record.id, f.record, rule);
    expect(f.schedule.update).toHaveBeenCalledWith({
      sessionId: SessionId('same-session'),
      id: f.record.id,
      expected: f.record,
      title: TITLE,
      prompt: PROMPT,
      change: {
        kind: 'weekly',
        weekly: {
          time: '04:15:00',
          time_zone: 'Asia/Shanghai',
          weekdays: [1, 7],
        },
      },
    });
  });

  it.each(
    [[], [0], [8], [1, 1], [7, 1], [1.5]].map((weekdays) => ({ weekdays })),
  )(
    'rejects noncanonical weekly selector $weekdays at the actual factory boundary',
    async ({ weekdays }) => {
      const f = await adapter();
      const rule: NativeScheduleRecurringRule = {
        kind: 'weekly',
        time: '04:15:00',
        timezone: 'Asia/Shanghai',
        weekdays,
      };
      await expect(
        f.host.createRecurring!('same-session', rule),
      ).rejects.toMatchObject({ code: 'binding_invalid' });
      await expect(
        f.host.updateRecurring!('same-session', f.record.id, f.record, rule),
      ).rejects.toMatchObject({ code: 'binding_invalid' });
      expect(f.schedule.create).not.toHaveBeenCalled();
      expect(f.schedule.update).not.toHaveBeenCalled();
    },
  );

  it('defers only an explicit non-mutating schedule_conflict', async () => {
    const f = await adapter();
    f.setResult({ id: f.record.id, updated: false, code: 'schedule_conflict' });
    expect(
      await f.host.updateRecurring!('same-session', f.record.id, f.record, {
        kind: 'every',
        seconds: 60,
      }),
    ).toBeNull();
    f.setResult({
      id: f.record.id,
      updated: false,
      code: 'schedule_not_found',
    });
    await expect(
      f.host.updateRecurring!('same-session', f.record.id, f.record, {
        kind: 'every',
        seconds: 60,
      }),
    ).rejects.toMatchObject({ code: 'task_invalid' });
  });
});

describe('generation-bound workspace auxiliary port; scripted SQL semantics only', () => {
  it.each(['foreign path', 'UTF-8 title bound'] as const)(
    'rejects %s before persisting a workspace record',
    async (kind) => {
      const f = fixture([]),
        c = f.create();
      try {
        await c.tick();
        await expect(
          f.hosts[0]!.auxiliaryUnit!.putRecord('workspaces', 'w', {
            path:
              kind === 'foreign path'
                ? '/foreign'
                : f.source.reference.stateRoot,
            title: kind === 'UTF-8 title bound' ? '肤'.repeat(171) : '',
            sessionIds: [],
            createdAt: '2026-10-20T00:00:00.000Z',
            updatedAt: '2026-10-20T00:00:00.000Z',
          }),
        ).rejects.toMatchObject({ code: 'auxiliary_invalid' });
        expect(f.store.commitWorkspaceWrite).not.toHaveBeenCalled();
      } finally {
        await c.stop();
      }
    },
  );

  it('rejects a malformed existing workspace snapshot without replacing it with virgin state', async () => {
    const f = fixture([]),
      c = f.create();
    f.setWorkspace({
      unitVersion: 1,
      revision: 7,
      tables: { workspaces: {} },
      global: null,
    } as unknown as NativeScheduleWorkspaceSnapshot);
    await expect(c.tick()).rejects.toMatchObject({ code: 'auxiliary_invalid' });
    expect(f.workspace().revision).toBe(7);
    expect(f.store.commitWorkspaceWrite).not.toHaveBeenCalled();
    await c.stop();
  });

  it('normalizes only the public optional undefined fields, preserving the canonical write digest', async () => {
    const first = fixture([]),
      second = fixture([]),
      a = first.create(),
      b = second.create();
    try {
      await a.tick();
      await b.tick();
      await first.hosts[0]!.auxiliaryUnit!.setGlobal({
        ...emptyWorkspaceGlobal(),
        defaultWorkspaceId: undefined,
        pendingMutation: undefined,
      });
      await second.hosts[0]!.auxiliaryUnit!.setGlobal(emptyWorkspaceGlobal());
      const x = [...first.workspaceJournal.values()][0]!,
        y = [...second.workspaceJournal.values()][0]!;
      expect(x.digest).toBe(y.digest);
      expect(x.mutation).toEqual({
        kind: 'set_global',
        value: emptyWorkspaceGlobal(),
      });
      expect(x.writeId).not.toBe(y.writeId);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it.each([
    ['unknown key', () => ({ ...emptyWorkspaceGlobal(), unexpected: true })],
    [
      'other undefined',
      () => ({ ...emptyWorkspaceGlobal(), archivedSessionIds: undefined }),
    ],
    [
      'array discriminant',
      () => ({
        ...emptyWorkspaceGlobal(),
        pendingMutation: { operation: ['create'], workspaceId: 'w' },
      }),
    ],
    [
      'null prototype',
      () => Object.assign(Object.create(null), emptyWorkspaceGlobal()),
    ],
    [
      'array holes',
      () => ({ ...emptyWorkspaceGlobal(), workspaceIds: new Array(1) }),
    ],
    [
      'foreign session',
      () => ({
        ...emptyWorkspaceGlobal(),
        pinnedSessionIds: ['foreign-session'],
      }),
    ],
    [
      'nonplain array',
      () => ({
        ...emptyWorkspaceGlobal(),
        workspaceIds: new (class extends Array {})(),
      }),
    ],
  ] as const)(
    'rejects %s before submitting a workspace write',
    async (_name, value) => {
      const f = fixture([]),
        c = f.create();
      try {
        await c.tick();
        await expect(
          f.hosts[0]!.auxiliaryUnit!.setGlobal(value()),
        ).rejects.toMatchObject({ code: 'auxiliary_invalid' });
        expect(f.store.commitWorkspaceWrite).not.toHaveBeenCalled();
      } finally {
        await c.stop();
      }
    },
  );

  it('rejects accessors without invoking them', async () => {
    const f = fixture([]),
      c = f.create(),
      getter = vi.fn(() => true);
    try {
      await c.tick();
      const value = Object.defineProperty(
        emptyWorkspaceGlobal(),
        'initialized',
        { enumerable: true, get: getter },
      );
      await expect(
        f.hosts[0]!.auxiliaryUnit!.setGlobal(value),
      ).rejects.toMatchObject({ code: 'auxiliary_invalid' });
      expect(getter).not.toHaveBeenCalled();
      expect(f.store.commitWorkspaceWrite).not.toHaveBeenCalled();
    } finally {
      await c.stop();
    }
  });

  it.each([
    { name: 'workspace', version: 1, tables: ['workspaces'], hasGlobal: true },
    { name: 'workspace', version: 2, tables: ['foreign'], hasGlobal: true },
    {
      name: 'workspace',
      version: 2,
      tables: ['workspaces'],
      hasGlobal: true,
      compatibleVersions: [1],
    },
    {
      name: 'workspace',
      version: 2,
      tables: ['workspaces'],
      hasGlobal: true,
      layout: 'split',
    },
  ])(
    'rejects a descriptor outside the one public workspace v2 unit: %j',
    async (descriptor) => {
      const f = fixture([]),
        original = vi.mocked(f.factory).getMockImplementation()!;
      vi.mocked(f.factory).mockImplementation(async (input) => {
        const host = await original(input);
        return {
          ...host,
          async boot() {
            await input.auxiliaryBackend.kv!.open(descriptor as never);
          },
        };
      });
      const c = f.create();
      await expect(c.tick()).rejects.toMatchObject({
        code: 'auxiliary_invalid',
      });
      expect(f.store.loadWorkspaceUnit).not.toHaveBeenCalled();
      await c.stop();
    },
  );

  it('keeps legitimate pendingMutation and an empty public title across a cold same-ID recovery', async () => {
    const f = fixture(),
      first = f.create();
    await first.tick();
    const unit = f.hosts[0]!.auxiliaryUnit!,
      id = f.rows[0]!.nativeTaskId;
    await unit.putRecord('workspaces', 'workspace-1', {
      path: f.source.reference.stateRoot,
      title: '',
      sessionIds: [f.rows[0]!.controlSessionId],
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
    });
    await unit.setGlobal({
      ...emptyWorkspaceGlobal(),
      pendingMutation: { operation: 'create', workspaceId: 'workspace-1' },
    });
    const before = f.workspace();
    await first.stop();
    const second = f.create();
    try {
      await second.tick();
      expect(f.rows[0]!.nativeTaskId).toBe(id);
      expect(f.creations()).toBe(1);
      expect(await f.hosts[1]!.auxiliaryUnit!.loadAll()).toEqual({
        tables: before.tables,
        global: before.global,
      });
      await f.hosts[1]!.auxiliaryUnit!.setGlobal({
        ...emptyWorkspaceGlobal(),
        pendingMutation: undefined,
      });
      expect(f.workspace().global).not.toHaveProperty('pendingMutation');
    } finally {
      await second.stop();
    }
  });

  it('does not resend an unknown committed workspace write or let an old callback borrow the new writer', async () => {
    const f = fixture([]),
      c = f.create(),
      commit = vi.mocked(f.store.commitWorkspaceWrite).getMockImplementation()!;
    await c.tick();
    vi.mocked(f.store.commitWorkspaceWrite).mockImplementationOnce(
      async (writer, write) => {
        await commit(writer, write);
        throw Error('injected COMMIT ACK unknown');
      },
    );
    const old = f.hosts[0]!.auxiliaryUnit!;
    await expect(old.setGlobal(emptyWorkspaceGlobal())).rejects.toMatchObject({
      code: 'auxiliary_write_unknown',
    });
    await until(
      () => f.trace.includes('release:1'),
      'unknown workspace write did not drain',
    );
    await c.tick();
    expect(c.status().state).toBe('blocked');
    expect(f.hosts).toHaveLength(1);
    expect(f.store.acquireWriter).toHaveBeenCalledTimes(1);
    await c.stop();
    // A separately authorized recovery may load the already committed snapshot.
    const recovered = f.create();
    await recovered.tick();
    expect(f.hosts).toHaveLength(2);
    expect(f.workspace().revision).toBe(1);
    await expect(old.setGlobal(emptyWorkspaceGlobal())).rejects.toBeInstanceOf(
      NativeScheduleOnceError,
    );
    expect(f.store.commitWorkspaceWrite).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(f.store.commitWorkspaceWrite).mock.calls[0]![0].epoch,
    ).toBe(1);
    expect(await f.hosts[1]!.auxiliaryUnit!.loadAll()).toEqual({
      tables: { workspaces: {} },
      global: emptyWorkspaceGlobal(),
    });
    await recovered.stop();
  });

  it('drains an in-flight auxiliary write and both backends before releasing ownership', async () => {
    const f = fixture([]),
      c = f.create(),
      entered = deferred<void>(),
      gate = deferred<void>();
    const commit = vi
      .mocked(f.store.commitWorkspaceWrite)
      .getMockImplementation()!;
    vi.mocked(f.store.commitWorkspaceWrite).mockImplementation(
      async (writer, write) => {
        entered.resolve();
        await gate.promise;
        return commit(writer, write);
      },
    );
    await c.tick();
    const writing = f.hosts[0]!.auxiliaryUnit!.setGlobal(
      emptyWorkspaceGlobal(),
    );
    await entered.promise;
    const stopping = c.stop();
    await until(
      () => f.trace.includes('schedule-drain:1'),
      'public close did not start',
    );
    expect(f.store.releaseClosedWriter).not.toHaveBeenCalled();
    gate.resolve();
    await writing;
    await stopping;
    for (const backend of ['schedule', 'auxiliary']) {
      expect(f.trace.indexOf('root-dispose:1')).toBeLessThan(
        f.trace.indexOf(`${backend}-backend-drained:1`),
      );
      expect(f.trace.indexOf(`${backend}-backend-drained:1`)).toBeLessThan(
        f.trace.indexOf('release:1'),
      );
    }
  });
});

const moduleNames = {
  cordis: 'cordis',
  llm: 'dsh-llm',
  sessions: 'dsh-session',
  projections: 'dsh-session-projection',
  systemPrompt: 'dsh-system-prompt',
  files: 'dsh-fs-local',
  directory: 'dsh-working-directory',
  tools: 'dsh-tools',
  agents: 'dsh-agent',
  loop: 'dsh-agent-loop',
  jsonl: 'dsh-session-persistence-jsonl',
  storage: 'dsh-storage',
  domain: 'dsh-storage-domain',
  workspace: 'dsh-workspace',
  typert: 'dsh-typert-registry',
  defaultModel: 'dsh-agent-default-model',
  credentials: 'dsh-credentials',
  commands: 'dsh-commands',
  connection: 'dsh-client-connection',
  attachment: 'dsh-attachment-local',
  upload: 'dsh-client-file-upload',
  query: 'dsh-session-query-sqlite',
  controller: 'dsh-api-session-controller',
  sdk: 'dsh-sdk-jsonrpc-server',
  schedule: 'dsh-schedule',
};

describe('one focused real public Host composition test, zero provider/tool bodies; not production artifact or SQL proof', () => {
  // Opt-in local composition evidence; production dependencies/profile need separate approval.
  it.runIf(!!process.env.ALLRICE_NATIVE_ONCE_PROBE_MODULE_BASE)(
    'permanently denies execution, initializes persisted history, then cold SDK-resumes before Schedule mounts',
    async () => {
      const req = createRequire(
        process.env.ALLRICE_NATIVE_ONCE_PROBE_MODULE_BASE!,
      );
      const componentReq = createRequire(
        req.resolve('@deepseek-ai/dsh-api-session-controller'),
      );
      const root = await mkdtemp(join(tmpdir(), 'public-control-'));
      const contexts: InstanceType<
        NativeSchedulePublicModules['cordis']['Context']
      >[] = [];
      const loaded: Record<string, unknown> = {};
      for (const [key, name] of Object.entries(moduleNames)) {
        const module = await import(
          pathToFileURL(
            (['commands', 'connection'].includes(key)
              ? componentReq
              : req
            ).resolve('@deepseek-ai/' + name),
          ).href
        );
        loaded[key] = module;
      }
      const modules = loaded as unknown as NativeSchedulePublicModules;
      class CapturingContext extends modules.cordis.Context {
        constructor() {
          super();
          contexts.push(this);
        }
      }
      const publicModules = {
        ...modules,
        cordis: { ...modules.cordis, Context: CapturingContext },
      };
      // Cold public Host initialization precedes create. A target that expires
      // there is correctly rejected, so leave startup room within the unchanged
      // eight-second delivery wait and verify actual command admission below.
      const control = row({ at: new Date(Date.now() + 6000).toISOString() });
      const f = fixture([control]);
      f.source.reference.stateRoot = root;
      f.source.loadModules = vi.fn(async () => publicModules);
      f.source.loadHostFactory = vi.fn(async () => {
        const module = await import(
          new URL('../dsh/native-schedule-host-factory.mjs', import.meta.url)
            .href
        );
        return module.openNativeScheduleControlHost;
      });
      const lifecycle: string[] = [];
      const factory: NativeScheduleHostFactory = async (input) => {
        const host = await openPublicNativeScheduleOnceHost(input);
        return {
          ...host,
          async initializeSession(id) {
            lifecycle.push(`initialize:${id}`);
            return host.initializeSession(id);
          },
          async resumeSession(id) {
            lifecycle.push(`resume:${id}`);
            return host.resumeSession(id);
          },
          async mountSchedule() {
            lifecycle.push('mount');
            return host.mountSchedule();
          },
        };
      };
      const first = createNativeScheduleOnceController({
        enabled: true,
        store: f.store,
        source: f.source,
        hostFactory: factory,
      });
      let second:
          ReturnType<typeof createNativeScheduleOnceController> | undefined,
        toolBodies = 0;
      try {
        await first.tick();
        try {
          expect(f.rows[0]!.command.status).toBe('confirmed');
          expect(f.records.size).toBe(1);
          await until(
            () => !![...f.records.values()][0]?.lastDelivery,
            'native once receipt not observed',
          );
        } catch (error) {
          throw new Error(
            'native once command/delivery proof failed: ' +
              JSON.stringify({
                observedAt: new Date().toISOString(),
                targetAt: control.at,
                controller: first.status(),
                controls: f.rows,
                tasks: [...f.records.values()],
                writes: [...f.journal.values()].map(
                  (write) => write.mutation.kind,
                ),
                rejections: [...f.journal.values()]
                  .filter((write) => write.mutation.kind === 'reject_command')
                  .map((write) => write.mutation),
                trace: f.trace,
                events: contexts.map(
                  (ctx) =>
                    ctx.sessions
                      .get(SessionId(control.controlSessionId))
                      ?.ownEvents()
                      .map((event) => ({ seq: event.seq, type: event.type })) ??
                    [],
                ),
              }),
            { cause: error },
          );
        }
        expect(first.status().stats.adapterCalls).toBe(0);
        expect(first.status().stats.preStepDenials).toBeGreaterThan(0);
        const ctx = contexts[0]!;
        const receipt = [...f.records.values()][0]!.lastDelivery!;
        const inboxMessages = ctx.sessions
          .get(SessionId(control.controlSessionId))!
          .ownEvents()
          .flatMap((event) =>
            event.type === 'agent/inbox/spliced'
              ? event.data.inserted
                  .filter((message) => message.id === receipt.messageId)
                  .map((message) => ({
                    seq: event.seq,
                    type: event.type,
                    source: message.source,
                  }))
              : [],
          );
        expect(inboxMessages).toHaveLength(1);
        const inboxMessage = inboxMessages[0]!;
        expect(inboxMessage.source).toEqual({ kind: 'schedule' });
        const nativeReceiptProof = {
          taskId: f.rows[0]!.nativeTaskId,
          sessionId: control.controlSessionId,
          ...receipt,
          eventSeq: inboxMessage.seq,
          eventType: inboxMessage.type,
          source: inboxMessage.source,
        };
        vi.stubEnv('ALLRICE_NATIVE_ONCE_SENTINEL_SECRET', 'synthetic-only');
        expect(
          await ctx.credentials.resolve(
            modules.credentials.credentialRef(
              'ALLRICE_NATIVE_ONCE_SENTINEL_SECRET',
            ),
          ),
        ).toBeUndefined();
        ctx.tools.register({
          name: 'synthetic_control_sentinel',
          description: 'Must never execute',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
          },
          async execute() {
            toolBodies++;
            return 'forbidden';
          },
        });
        const denied = await ctx.tools.execute({
          callId: ToolCallId('synthetic-control'),
          name: 'synthetic_control_sentinel',
          arguments: {},
          signal: new AbortController().signal,
        });
        expect(denied.isError).toBe(true);
        expect(toolBodies).toBe(0);
        expect(first.status().stats.toolDenials).toBe(1);
        const originalId = f.rows[0]!.nativeTaskId;
        expect([...f.records.values()][0]?.lastDelivery?.scheduledAt).toBe(
          control.at,
        );
        await first.stop();
        second = createNativeScheduleOnceController({
          enabled: true,
          store: f.store,
          source: f.source,
          hostFactory: factory,
        });
        await second.tick();
        expect(f.rows[0]!.nativeTaskId).toBe(originalId);
        expect(f.records.size).toBe(1);
        expect(lifecycle).toEqual([
          `initialize:${control.controlSessionId}`,
          'mount',
          `resume:${control.controlSessionId}`,
          'mount',
        ]);
        expect(second.status().stats.adapterCalls).toBe(0);
        if (process.env.ALLRICE_NATIVE_ONCE_CONTROL_REPORT)
          await writeFile(
            process.env.ALLRICE_NATIVE_ONCE_CONTROL_REPORT,
            JSON.stringify(
              {
                passed: true,
                at: new Date().toISOString(),
                lifecycle,
                nativeReceiptProof,
                first: first.status(),
                second: second.status(),
                toolBodies,
                realProviderCalls: 0,
                database: 'scripted in-memory port fixture; no SQL proof',
                packages:
                  'existing 0.2.1-rc.2 probe environment; not product artifact approval',
                productFeatureAdmission: false,
              },
              null,
              2,
            ) + '\n',
          );
      } finally {
        await second?.stop();
        await first.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    20000,
  );
});

describe('weekly real public Host composition; no database or execution grant', () => {
  it.runIf(!!process.env.ALLRICE_NATIVE_ONCE_PROBE_MODULE_BASE)(
    'creates and updates one weekly Task, records a real receipt, then cold-resumes its original Session',
    async () => {
      const req = createRequire(
        process.env.ALLRICE_NATIVE_ONCE_PROBE_MODULE_BASE!,
      );
      const componentReq = createRequire(
        req.resolve('@deepseek-ai/dsh-api-session-controller'),
      );
      const loaded: Record<string, unknown> = {};
      for (const [key, name] of Object.entries(moduleNames))
        loaded[key] = await import(
          pathToFileURL(
            (['commands', 'connection'].includes(key)
              ? componentReq
              : req
            ).resolve('@deepseek-ai/' + name),
          ).href
        );
      const modules = loaded as unknown as NativeSchedulePublicModules;
      const contexts: InstanceType<
        NativeSchedulePublicModules['cordis']['Context']
      >[] = [];
      class CapturingContext extends modules.cordis.Context {
        constructor() {
          super();
          contexts.push(this);
        }
      }
      const publicModules = {
        ...modules,
        cordis: { ...modules.cordis, Context: CapturingContext },
      };
      const root = await mkdtemp(join(tmpdir(), 'public-weekly-control-'));
      const control = recurringRow({
        kind: 'weekly',
        time: new Date(Date.now() + 120_000).toISOString().slice(11, 19),
        timezone: 'UTC',
        weekdays: [1, 2, 3, 4, 5, 6, 7],
      });
      const f = fixture([control]);
      f.source.reference.stateRoot = root;
      f.source.loadModules = vi.fn(async () => publicModules);
      f.source.loadHostFactory = vi.fn(
        async () =>
          (
            await import(
              new URL(
                '../dsh/native-schedule-host-factory.mjs',
                import.meta.url,
              ).href
            )
          ).openNativeScheduleControlHost,
      );
      const lifecycle: string[] = [];
      let creations = 0,
        updates = 0;
      const factory: NativeScheduleHostFactory = async (input) => {
        const host = await openPublicNativeScheduleOnceHost(input);
        return {
          ...host,
          async initializeSession(id) {
            lifecycle.push(`initialize:${id}`);
            return host.initializeSession(id);
          },
          async resumeSession(id) {
            lifecycle.push(`resume:${id}`);
            return host.resumeSession(id);
          },
          async mountSchedule() {
            lifecycle.push('mount');
            return host.mountSchedule();
          },
          async createRecurring(id, rule) {
            creations++;
            return host.createRecurring!(id, rule);
          },
          async updateRecurring(session, id, expected, rule) {
            updates++;
            return host.updateRecurring!(session, id, expected, rule);
          },
        };
      };
      const first = createNativeScheduleOnceController({
        enabled: true,
        store: f.store,
        source: f.source,
        hostFactory: factory,
      });
      let second:
        ReturnType<typeof createNativeScheduleOnceController> | undefined;
      try {
        await first.tick();
        const id = f.rows[0]!.nativeTaskId!,
          session = f.rows[0]!.controlSessionId;
        expect(f.rows[0]!.command.status).toBe('confirmed');
        expect(f.records.get(id)!.record.kind).toBe('weekly');
        // Boot has completed. Only the real public Schedule selects and delivers
        // this near-future target; no receipt or clock result is injected.
        const due = new Date(Math.ceil((Date.now() + 4_000) / 1_000) * 1_000);
        const rule: NativeScheduleRecurringRule = {
          kind: 'weekly',
          time: due.toISOString().slice(11, 19),
          timezone: 'UTC',
          weekdays: [due.getUTCDay() || 7],
        };
        f.rows[0]!.revision = 2;
        f.rows[0]!.rule = rule;
        f.rows[0]!.command = {
          id: randomUUID(),
          kind: 'update',
          status: 'pending',
        };
        await first.tick();
        expect(f.rows[0]!.command.status).toBe('confirmed');
        expect(f.rows[0]!.nativeTaskId).toBe(id);
        expect(f.records.get(id)!.record.scheduledAt).toBe(due.toISOString());
        await until(
          () => !!f.records.get(id)?.lastDelivery,
          'real weekly receipt not observed',
        );
        const receipt = f.records.get(id)!.lastDelivery!;
        expect(receipt.scheduledAt).toBe(due.toISOString());
        const inbox = contexts[0]!.sessions
          .get(SessionId(session))!
          .ownEvents()
          .flatMap((event) =>
            event.type === 'agent/inbox/spliced'
              ? event.data.inserted.filter(
                  (message) => message.id === receipt.messageId,
                )
              : [],
          );
        expect(inbox).toHaveLength(1);
        expect(inbox[0]!.source).toEqual({ kind: 'schedule' });
        const saved = structuredClone(f.records.get(id)!);
        expect(saved.deliveryHistory!.records).toHaveLength(1);
        expect(Date.parse(saved.record.scheduledAt)).toBeGreaterThan(
          due.getTime(),
        );
        await first.stop();
        second = createNativeScheduleOnceController({
          enabled: true,
          store: f.store,
          source: f.source,
          hostFactory: factory,
        });
        await second.tick();
        expect(f.rows[0]!.nativeTaskId).toBe(id);
        expect(f.rows[0]!.controlSessionId).toBe(session);
        expect(f.rows[0]!.appliedRule).toEqual(rule);
        expect(f.records.get(id)).toEqual(saved);
        expect(creations).toBe(1);
        expect(updates).toBe(1);
        expect(lifecycle).toEqual([
          `initialize:${session}`,
          'mount',
          `resume:${session}`,
          'mount',
        ]);
        expect(first.status().stats.adapterCalls).toBe(0);
        expect(second.status().stats.adapterCalls).toBe(0);
      } finally {
        await second?.stop();
        await first.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
