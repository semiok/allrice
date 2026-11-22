import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ScheduleId,
  type ScheduleCatalogEntry,
  type ScheduleTask,
} from '@deepseek-ai/dsh-schedule';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { StorageBackend } from '@deepseek-ai/dsh-storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openPublicNativeScheduleOnceHost,
  type NativeScheduleControlHost,
  type NativeScheduleControlSource,
  type NativeSchedulePublicModules,
} from './native-schedule-once.js';
import { readNativeScheduleObservations } from './native-schedule-observation.js';

const target = '2099-01-01T00:00:00.000Z';
const signal = () => new AbortController().signal;
const common = {
  title: 'Native reminder',
  prompt: 'Private native instruction',
  scheduledAt: target,
  sessionId: SessionId('original-session'),
  status: 'active' as const,
};
const entries: ScheduleCatalogEntry[] = [
  { ...common, id: ScheduleId('after'), kind: 'after', afterSeconds: 60 },
  { ...common, id: ScheduleId('at'), kind: 'at' },
  { ...common, id: ScheduleId('every'), kind: 'every', everySeconds: 3600 },
  {
    ...common,
    id: ScheduleId('daily'),
    kind: 'daily',
    time: '09:00:00.000',
    timeZone: 'Asia/Shanghai',
  },
  {
    ...common,
    id: ScheduleId('weekly'),
    kind: 'weekly',
    time: '09:00:00.000',
    timeZone: 'Asia/Shanghai',
    weekdays: [1, 7],
  },
  {
    ...common,
    id: ScheduleId('cron'),
    kind: 'cron',
    expression: '0 9 * * *',
    timeZone: 'Asia/Shanghai',
  },
];
const receipt = {
  scheduledAt: '2026-01-01T00:00:00.000Z',
  deliveredAt: '2026-01-01T00:00:01.000Z',
  messageId: 'native-message' as NonNullable<
    ScheduleTask['lastDelivery']
  >['messageId'],
};
const read = (rows: unknown) =>
  readNativeScheduleObservations(
    { catalog: vi.fn(async () => rows as ScheduleCatalogEntry[]) },
    signal(),
  );

afterEach(() => vi.restoreAllMocks());

describe('native schedule content observations, not execution or authority', () => {
  it('keeps every native kind and committed target without exposing instructions', async () => {
    const snapshot = await read(entries);
    expect(snapshot.items.map((item) => item.id)).toEqual([
      'after',
      'at',
      'cron',
      'daily',
      'every',
      'weekly',
    ]);
    for (const item of snapshot.items) {
      expect(item).toEqual({
        id: item.id,
        sessionId: common.sessionId,
        status: 'active',
        scheduledAt: target,
        fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
      expect(Object.isFrozen(item)).toBe(true);
    }
    expect(JSON.stringify(snapshot)).not.toContain(common.prompt);
    expect(JSON.stringify(snapshot)).not.toContain(common.title);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.items)).toBe(true);
  });

  it('fingerprints the complete original native row and ignores only key/row ordering', async () => {
    const row = { ...entries[1]!, lastDelivery: receipt };
    const ordered = Object.fromEntries(
      Object.entries(row)
        .map(
          ([key, value]) =>
            [
              key,
              key === 'lastDelivery'
                ? Object.fromEntries(
                    Object.entries(receipt).sort(([a], [b]) =>
                      a < b ? -1 : a > b ? 1 : 0,
                    ),
                  )
                : value,
            ] as const,
        )
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    const original = await read([row, entries[0]!]);
    expect(original.items[1]!.fingerprint).toBe(
      'sha256:' +
        createHash('sha256').update(JSON.stringify(ordered)).digest('hex'),
    );
    expect(await read([entries[0]!, ordered])).toEqual(original);
    expect(await read([entries[0]!, structuredClone(row)])).toEqual(original);
  });

  it.each([
    ['title', { title: 'Renamed' }],
    ['prompt', { prompt: 'Changed private instruction' }],
    ['target', { scheduledAt: '2099-02-01T00:00:00.000Z' }],
    ['session', { sessionId: SessionId('another-original-session') }],
    ['status', { status: 'inactive' }],
    ['receipt', { lastDelivery: receipt }],
    ['delay', { afterSeconds: 120 }],
  ] as const)(
    'observes a change of %s even when other facts are identical',
    async (_label, change) => {
      const before = await read([entries[0]!]);
      const after = await read([{ ...entries[0]!, ...change }]);
      expect(after.items[0]!.fingerprint).not.toBe(
        before.items[0]!.fingerprint,
      );
      expect(after.fingerprint).not.toBe(before.fingerprint);
    },
  );

  it.each([
    [2, { everySeconds: 7200 }],
    [3, { time: '10:00:00.000' }],
    [3, { timeZone: 'UTC' }],
    [4, { weekdays: [2, 7] }],
    [5, { expression: '0 10 * * *' }],
  ] as const)(
    'includes native timing fields in the complete row fingerprint (%s)',
    async (index, change) => {
      const row = entries[index]!;
      expect(
        (await read([{ ...row, ...change }])).items[0]!.fingerprint,
      ).not.toBe((await read([row])).items[0]!.fingerprint);
    },
  );

  it.each([
    { scheduledAt: '2026-01-02T00:00:00.000Z' },
    { deliveredAt: '2026-01-01T00:00:02.000Z' },
    { messageId: 'another-native-message' },
  ])(
    'includes every receipt field without exporting the receipt',
    async (change) => {
      const row = { ...entries[1]!, lastDelivery: receipt };
      const after = await read([
        { ...row, lastDelivery: { ...receipt, ...change } },
      ]);
      expect(after.items[0]!.fingerprint).not.toBe(
        (await read([row])).items[0]!.fingerprint,
      );
      expect(after.items[0]).not.toHaveProperty('lastDelivery');
    },
  );

  it('retains inactive last targets and represents absence only in a successful full batch', async () => {
    const row = {
      ...entries[1]!,
      status: 'inactive',
      scheduledAt: receipt.scheduledAt,
      lastDelivery: receipt,
    };
    const before = await read([row]);
    expect(before.items[0]).toMatchObject({
      status: 'inactive',
      scheduledAt: receipt.scheduledAt,
    });
    const absent = await read([]);
    expect(absent.items).toEqual([]);
    expect(absent.fingerprint).not.toBe(before.fingerprint);
  });

  it.each([
    [null],
    [undefined],
    [{}],
    [[entries[1]!]],
    [{ ...entries[1]!, unknown: 'must not disappear' }],
    [{ ...entries[1]!, status: undefined }],
    [{ ...entries[1]!, lastDelivery: undefined }],
    [{ ...entries[1]!, sessionId: '' }],
    [
      {
        ...entries[1]!,
        lastDelivery: { ...receipt, prompt: 'not a receipt field' },
      },
    ],
    [{ ...entries[1]!, lastDelivery: { ...receipt, messageId: '' } }],
    [{ ...entries[1]!, scheduledAt: 'not-an-instant' }],
    [{ ...entries[4]!, weekdays: [7, 1] }],
    [{ ...entries[4]!, weekdays: Object.assign([1, 7], { unknown: 1 }) }],
    [Object.defineProperty({ ...entries[1]! }, 'hidden', { value: 1 })],
    [{ ...entries[1]!, [Symbol('hidden')]: 1 }],
    [
      Object.defineProperty({ ...entries[1]! }, 'prompt', {
        get() {
          throw Error('getter must not run');
        },
        enumerable: true,
      }),
    ],
  ])(
    'rejects malformed or extended native rows without certifying a normalized subset',
    async (row) => {
      await expect(read([row])).rejects.toBeDefined();
    },
  );

  it('rejects incomplete catalogs and duplicate native identities', async () => {
    for (const catalog of [
      null,
      {},
      [entries[1]!, entries[1]!],
      [entries[1]!, {}],
      new Array(1),
      Object.assign([entries[1]!], { unknown: 1 }),
    ])
      await expect(read(catalog)).rejects.toBeDefined();
  });

  it('rejects accessors without invoking them', async () => {
    const getter = vi.fn(() => common.prompt);
    const row = Object.defineProperty({ ...entries[1]! }, 'prompt', {
      get: getter,
      enumerable: true,
    });
    await expect(read([row])).rejects.toBeInstanceOf(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });

  it('preserves a real catalog rejection, including when cancellation also arrives', async () => {
    const error = Error('actual catalog read failed');
    const abort = new AbortController();
    const catalog = vi.fn(async () => {
      abort.abort();
      throw error;
    });
    await expect(
      readNativeScheduleObservations({ catalog }, abort.signal),
    ).rejects.toBe(error);
  });

  it('does not start an already canceled read', async () => {
    const abort = new AbortController();
    abort.abort();
    const catalog = vi.fn(async () => entries);
    await expect(
      readNativeScheduleObservations({ catalog }, abort.signal),
    ).rejects.toBe(abort.signal.reason);
    expect(catalog).not.toHaveBeenCalled();
  });

  it('joins a pending actual catalog read before reporting cancellation and exports no late result', async () => {
    let resolve!: (value: ScheduleCatalogEntry[]) => void;
    const pending = new Promise<ScheduleCatalogEntry[]>((done) => {
      resolve = done;
    });
    const catalog = vi.fn(() => pending);
    const abort = new AbortController();
    const result = readNativeScheduleObservations({ catalog }, abort.signal);
    const settled = vi.fn();
    const handled = result.then(settled, settled);
    abort.abort();
    await Promise.resolve();
    expect(catalog).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    resolve(entries);
    await expect(result).rejects.toBe(abort.signal.reason);
    await handled;
    expect(settled).toHaveBeenCalledExactlyOnceWith(abort.signal.reason);
  });
});

/** Reuse the existing public Host factory, with isolated fixture storage only. */
it('reads a real ScheduleService.catalog with zero Agent/model work and closes the actual Host', async () => {
  const factory = await import(
    new URL('../dsh/native-schedule-host-factory.mjs', import.meta.url).href
  );
  const req = createRequire(new URL('../package.json', import.meta.url));
  const componentReq = createRequire(
    req.resolve('@deepseek-ai/dsh-api-session-controller'),
  );
  const loaded: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(factory.nativeScheduleModuleMap)) {
    const entry = raw as { specifier: string; anchor: string };
    loaded[key] = await import(
      pathToFileURL(
        (entry.anchor === 'controller' ? componentReq : req).resolve(
          entry.specifier,
        ),
      ).href
    );
  }
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
  const openUnits = new Set<string>();
  const writes = vi.fn();
  const backend = (
    name: string,
    tasks: Record<string, ScheduleTask> = {},
  ): StorageBackend => ({
    kv: {
      async open(descriptor) {
        const unit = name + ':' + descriptor.name;
        expect(openUnits.has(unit)).toBe(false);
        openUnits.add(unit);
        const tables: Record<
          string,
          Record<string, unknown>
        > = Object.fromEntries(
          descriptor.tables.map((table) => [
            table,
            table === 'tasks' ? structuredClone(tasks) : {},
          ]),
        );
        let global: unknown = null;
        return {
          async loadAll() {
            return structuredClone({ tables, global });
          },
          async putRecord(table, key, value) {
            writes(table);
            tables[table]![key] = structuredClone(value);
          },
          async deleteRecord(table, key) {
            writes(table);
            delete tables[table]![key];
          },
          async setGlobal(value) {
            writes('global');
            global = structuredClone(value);
          },
          async close() {
            openUnits.delete(unit);
          },
        };
      },
    },
    async close() {
      expect(
        [...openUnits].filter((unit) => unit.startsWith(name + ':')),
      ).toEqual([]);
    },
  });
  const nativeEntry = entries[1]!;
  const { sessionId, status, ...record } = nativeEntry;
  const scheduleBackend = backend('schedule', {
    [record.id]: { sessionId, status, record },
  });
  const auxiliaryBackend = backend('auxiliary');
  const stats = {
    preStepDenials: 0,
    modelGateDenials: 0,
    adapterCalls: 0,
    toolDenials: 0,
  };
  const root = await mkdtemp(join(tmpdir(), 'native-schedule-observation-'));
  const source: NativeScheduleControlSource = {
    reference: {
      artifactId: 'isolated-test-only',
      profileId: 'isolated-test-only',
      storageId: 'memory',
      stateRoot: root,
    },
    async loadModules() {
      return {
        ...modules,
        cordis: { ...modules.cordis, Context: CapturingContext },
      };
    },
    async loadHostFactory() {
      return factory.openNativeScheduleControlHost;
    },
  };
  let host: NativeScheduleControlHost | undefined;
  try {
    host = await openPublicNativeScheduleOnceHost({
      source,
      backend: scheduleBackend,
      auxiliaryBackend,
      stats,
    });
    await host.boot();
    await host.mountSchedule();
    const ctx = contexts[0]!;
    expect(ctx.schedule).toBeInstanceOf(modules.schedule.ScheduleService);
    const catalog = vi.spyOn(ctx.schedule, 'catalog');
    const activate = vi.spyOn(ctx.sessionController, 'resolveAgent');
    const observed = await readNativeScheduleObservations(
      ctx.schedule,
      signal(),
    );
    expect(catalog).toHaveBeenCalledOnce();
    expect(observed).toEqual(await read([nativeEntry]));
    expect(activate).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalledWith('tasks');
    expect(stats).toEqual({
      preStepDenials: 0,
      modelGateDenials: 0,
      adapterCalls: 0,
      toolDenials: 0,
    });
  } finally {
    try {
      await host?.close();
    } finally {
      try {
        await Promise.all([scheduleBackend.close(), auxiliaryBackend.close()]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
  expect(openUnits.size).toBe(0);
  await expect(host!.catalog()).rejects.toMatchObject({ code: 'closed' });
});
