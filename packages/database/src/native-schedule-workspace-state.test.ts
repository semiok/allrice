import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nativeOnceDigest } from './native-schedule-once-state.ts';
import {
  NativeOnceWorkspaceError,
  applyNativeOnceWorkspaceWrite,
  nativeOnceWorkspaceDigest,
  validateNativeOnceWorkspaceSnapshot,
  validateNativeOnceWorkspaceWrite,
  type NativeOnceWorkspaceGlobal,
  type NativeOnceWorkspaceMutation,
  type NativeOnceWorkspaceRecord,
  type NativeOnceWorkspaceScope,
  type NativeOnceWorkspaceSnapshot,
  type NativeOnceWorkspaceWrite,
} from './native-schedule-workspace-state.ts';

const at = '2030-01-01T00:00:00.000Z';
const scope: NativeOnceWorkspaceScope = {
  stateRoot: '/approved/native-once',
  controlSessionIds: new Set(['control-session-a', 'control-session-b']),
};
function record(
  overrides: Partial<NativeOnceWorkspaceRecord> = {},
): NativeOnceWorkspaceRecord {
  return {
    path: scope.stateRoot,
    title: 'Once control',
    sessionIds: ['control-session-a', 'control-session-b'],
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}
function global(
  overrides: Partial<NativeOnceWorkspaceGlobal> = {},
): NativeOnceWorkspaceGlobal {
  return {
    initialized: true,
    workspaceIds: ['workspace-a'],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    ...overrides,
  };
}
function snapshot(
  overrides: Partial<NativeOnceWorkspaceSnapshot> = {},
): NativeOnceWorkspaceSnapshot {
  return {
    unitVersion: 2,
    revision: 0,
    tables: { workspaces: {} },
    global: null,
    ...overrides,
  };
}
function write(
  mutation: NativeOnceWorkspaceMutation,
  expectedRevision = 0,
): NativeOnceWorkspaceWrite {
  return {
    writeId: '9bf69cbd-41cd-4257-bc5c-5a8a93297809',
    expectedRevision,
    mutation,
    digest: nativeOnceWorkspaceDigest(
      { entryKind: 'workspace', unitVersion: 2, expectedRevision, mutation },
      true,
    ),
  };
}
const put = (): Extract<
  NativeOnceWorkspaceMutation,
  { kind: 'put_record' }
> => ({
  kind: 'put_record',
  table: 'workspaces',
  key: 'workspace-a',
  value: record(),
});

describe('native once workspace mutations', () => {
  it('preserves a never-written global while header bootstrap persists a record', () => {
    const before = snapshot();
    const submitted = write(put());
    const original = structuredClone({ before, submitted });
    const after = applyNativeOnceWorkspaceWrite(before, submitted, scope);
    expect(after).toEqual({
      unitVersion: 2,
      revision: 1,
      tables: { workspaces: { 'workspace-a': record() } },
      global: null,
    });
    expect({ before, submitted }).toEqual(original);
  });

  it('replaces one record without aliasing the caller or changing its input', () => {
    const before = snapshot({
      revision: 4,
      tables: { workspaces: { 'workspace-a': record() } },
      global: global(),
    });
    const mutation: NativeOnceWorkspaceMutation = {
      ...put(),
      value: record({ title: 'Renamed' }),
    };
    const submitted = write(mutation, 4);
    const after = applyNativeOnceWorkspaceWrite(before, submitted, scope);
    mutation.value.title = 'Changed after submission';
    expect(before.tables.workspaces['workspace-a']?.title).toBe('Once control');
    expect(after.tables.workspaces['workspace-a']?.title).toBe('Renamed');
    expect(after.revision).toBe(5);
  });

  it('consumes one revision even when deleting a missing record', () => {
    const before = snapshot({ revision: 7 });
    const after = applyNativeOnceWorkspaceWrite(
      before,
      write({ kind: 'delete_record', table: 'workspaces', key: 'missing' }, 7),
      scope,
    );
    expect(after).toEqual({ ...before, revision: 8 });
  });

  it.each(['create', 'delete'] as const)(
    'keeps recoverable %s marker states until the public registry finishes recovery',
    (operation) => {
      const before = snapshot({
        revision: 1,
        tables: { workspaces: { 'workspace-a': record() } },
      });
      const marked = applyNativeOnceWorkspaceWrite(
        before,
        write(
          {
            kind: 'set_global',
            value: global({
              workspaceIds: [],
              pendingMutation: { operation, workspaceId: 'workspace-a' },
            }),
          },
          1,
        ),
        scope,
      );
      expect(marked.global?.pendingMutation).toEqual({
        operation,
        workspaceId: 'workspace-a',
      });
      expect(marked.tables.workspaces['workspace-a']).toBeDefined();
      const removed = applyNativeOnceWorkspaceWrite(
        marked,
        write(
          { kind: 'delete_record', table: 'workspaces', key: 'workspace-a' },
          2,
        ),
        scope,
      );
      const recovered = applyNativeOnceWorkspaceWrite(
        removed,
        write({ kind: 'set_global', value: global({ workspaceIds: [] }) }, 3),
        scope,
      );
      expect(recovered.revision).toBe(4);
      expect(recovered.tables.workspaces).toEqual({});
      expect(recovered.global).not.toHaveProperty('pendingMutation');
    },
  );

  it('retains a deleted default workspace identity without recreating its record', () => {
    const after = applyNativeOnceWorkspaceWrite(
      snapshot(),
      write({
        kind: 'set_global',
        value: global({
          workspaceIds: [],
          defaultWorkspaceId: 'deleted-default',
        }),
      }),
      scope,
    );
    expect(after.tables.workspaces).toEqual({});
    expect(after.global?.defaultWorkspaceId).toBe('deleted-default');
  });

  it('rejects an attempt to materialize a second workspace without changing the first', () => {
    const before = snapshot({
      revision: 1,
      tables: { workspaces: { 'workspace-a': record() } },
    });
    const original = structuredClone(before);
    expect(() =>
      applyNativeOnceWorkspaceWrite(
        before,
        write({ ...put(), key: 'workspace-b' }, 1),
        scope,
      ),
    ).toThrow('workspace_limit');
    expect(before).toEqual(original);
  });

  it('rejects stale CAS revisions without changing the supplied snapshot', () => {
    const before = snapshot({ revision: 8 });
    expect(() =>
      applyNativeOnceWorkspaceWrite(before, write(put(), 7), scope),
    ).toThrow('revision_conflict');
    expect(before).toEqual(snapshot({ revision: 8 }));
  });

  it('allows the last safe revision and refuses another write at the limit', () => {
    const revision = Number.MAX_SAFE_INTEGER - 1;
    const after = applyNativeOnceWorkspaceWrite(
      snapshot({ revision }),
      write(
        { kind: 'set_global', value: global({ workspaceIds: [] }) },
        revision,
      ),
      scope,
    );
    expect(after.revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(() =>
      applyNativeOnceWorkspaceWrite(
        after,
        write(
          { kind: 'delete_record', table: 'workspaces', key: 'missing' },
          Number.MAX_SAFE_INTEGER,
        ),
        scope,
      ),
    ).toThrow('write_identity');
  });
});

describe('native once workspace schema and scope', () => {
  it('accepts two approved control sessions and an empty public-schema title', () => {
    expect(() =>
      validateNativeOnceWorkspaceSnapshot(
        snapshot({
          tables: { workspaces: { 'workspace-a': record({ title: '' }) } },
          global: global(),
        }),
        scope,
      ),
    ).not.toThrow();
  });

  it.each([
    ['foreign stateRoot', () => record({ path: '/other/storage' })],
    [
      'unknown business session',
      () => record({ sessionIds: ['business-session-a'] }),
    ],
    [
      'duplicate control session',
      () => record({ sessionIds: ['control-session-a', 'control-session-a'] }),
    ],
    [
      'noncanonical timestamp',
      () => record({ updatedAt: '2030-01-01T00:00:00Z' }),
    ],
    ['invalid timestamp', () => record({ createdAt: 'not-a-date' })],
    [
      'unknown record key',
      () => ({ ...record(), businessPrompt: 'forbidden' }),
    ],
  ] satisfies Array<[string, () => unknown]>)(
    'rejects %s',
    (_description, makeRecord) => {
      expect(() =>
        validateNativeOnceWorkspaceSnapshot(
          snapshot({
            tables: {
              workspaces: {
                'workspace-a': makeRecord() as NativeOnceWorkspaceRecord,
              },
            },
          }),
          scope,
        ),
      ).toThrow(NativeOnceWorkspaceError);
    },
  );

  it.each([
    ['foreign unit', () => ({ ...snapshot(), unitVersion: 1 })],
    ['fractional revision', () => ({ ...snapshot(), revision: 0.5 })],
    ['foreign table', () => ({ ...snapshot(), tables: { tasks: {} } })],
    [
      'unknown snapshot key',
      () => ({ ...snapshot(), filename: 'workspace.json' }),
    ],
    [
      'unknown global key',
      () => ({
        ...snapshot(),
        global: { ...global(), businessSessionId: 'x' },
      }),
    ],
    [
      'foreign archive session',
      () => ({
        ...snapshot(),
        global: global({ archivedSessionIds: ['foreign'] }),
      }),
    ],
    [
      'archive and pin overlap',
      () => ({
        ...snapshot(),
        global: global({
          archivedSessionIds: ['control-session-a'],
          pinnedSessionIds: ['control-session-a'],
        }),
      }),
    ],
    [
      'duplicate global order',
      () => ({
        ...snapshot(),
        global: global({ workspaceIds: ['workspace-a', 'workspace-a'] }),
      }),
    ],
    [
      'undefined pending marker',
      () => ({
        ...snapshot(),
        global: { ...global(), pendingMutation: undefined },
      }),
    ],
  ] satisfies Array<[string, () => unknown]>)(
    'rejects %s independently at the SQL boundary',
    (_description, value) => {
      expect(() => validateNativeOnceWorkspaceSnapshot(value(), scope)).toThrow(
        NativeOnceWorkspaceError,
      );
    },
  );

  it.each([['create'], ['delete']])(
    'rejects an array operation discriminant %j without string coercion',
    (operation) => {
      const invalid = {
        ...snapshot(),
        global: {
          ...global({ workspaceIds: [] }),
          pendingMutation: {
            operation: [operation],
            workspaceId: 'workspace-a',
          },
        },
      };
      expect(() => validateNativeOnceWorkspaceSnapshot(invalid, scope)).toThrow(
        'pending_mutation',
      );
    },
  );

  it('measures title and session identifiers in UTF-8 bytes', () => {
    const maxSession = '😀'.repeat(16);
    const utf8Scope = {
      ...scope,
      controlSessionIds: new Set([maxSession, maxSession + 'x']),
    };
    const maxRecord = record({
      title: '😀'.repeat(128),
      sessionIds: [maxSession],
    });
    const valid = snapshot({
      tables: { workspaces: { 'workspace-a': maxRecord } },
    });
    expect(() =>
      validateNativeOnceWorkspaceSnapshot(valid, utf8Scope),
    ).not.toThrow();
    expect(() =>
      validateNativeOnceWorkspaceSnapshot(
        snapshot({
          tables: {
            workspaces: {
              'workspace-a': { ...maxRecord, title: maxRecord.title + 'x' },
            },
          },
        }),
        utf8Scope,
      ),
    ).toThrow('record');
    expect(() =>
      validateNativeOnceWorkspaceSnapshot(
        snapshot({
          tables: {
            workspaces: {
              'workspace-a': { ...maxRecord, sessionIds: [maxSession + 'x'] },
            },
          },
        }),
        utf8Scope,
      ),
    ).toThrow('identities');
  });

  it('supports 10,000 control sessions without enlarging the control-only JSON cap', () => {
    const ids = Array.from(
      { length: 10_000 },
      (_, index) => 'control-session-' + String(index).padStart(5, '0'),
    );
    const capacityScope = { ...scope, controlSessionIds: new Set(ids) };
    const full = snapshot({
      tables: {
        workspaces: { 'workspace-a': record({ sessionIds: ids }) },
      },
      global: global({ archivedSessionIds: ids }),
    });
    expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(65_536);
    expect(() =>
      validateNativeOnceWorkspaceSnapshot(full, capacityScope),
    ).not.toThrow();
    expect(() => nativeOnceDigest(full)).toThrow('json_limit');
    expect(() =>
      validateNativeOnceWorkspaceSnapshot(
        snapshot({
          tables: {
            workspaces: {
              'workspace-a': record({ sessionIds: [...ids, 'overflow'] }),
            },
          },
        }),
        { ...scope, controlSessionIds: new Set([...ids, 'overflow']) },
      ),
    ).toThrow('identities');
  });
});

describe('native once workspace canonical JSON and write identity', () => {
  it('hashes the existing sorted-key canonical bytes and preserves array order', () => {
    const expectedCanonical = '{"a":{"b":[null,"é"],"c":true},"z":1}';
    const expected =
      'sha256:' + createHash('sha256').update(expectedCanonical).digest('hex');
    expect(
      nativeOnceWorkspaceDigest({ z: 1, a: { c: true, b: [null, 'é'] } }),
    ).toBe(expected);
    expect(
      nativeOnceWorkspaceDigest({ a: { b: [null, 'é'], c: true }, z: 1 }),
    ).toBe(expected);
    expect(
      nativeOnceWorkspaceDigest({ a: { b: ['é', null], c: true }, z: 1 }),
    ).not.toBe(expected);
  });

  it('binds the digest to unit kind, expected revision and the complete mutation', () => {
    const submitted = write(put());
    expect(() =>
      validateNativeOnceWorkspaceWrite(submitted, scope),
    ).not.toThrow();
    expect(
      write({ ...put(), value: record({ title: 'Changed' }) }).digest,
    ).not.toBe(submitted.digest);
    expect(write(put(), 1).digest).not.toBe(submitted.digest);
    expect(
      nativeOnceWorkspaceDigest(
        {
          entryKind: 'control',
          unitVersion: 2,
          expectedRevision: 0,
          mutation: submitted.mutation,
        },
        true,
      ),
    ).not.toBe(submitted.digest);
    expect(() =>
      validateNativeOnceWorkspaceWrite(
        {
          ...submitted,
          mutation: { ...put(), value: record({ title: 'Changed' }) },
        },
        scope,
      ),
    ).toThrow('write_digest');
  });

  it.each([
    ['foreign table', { kind: 'delete_record', table: 'tasks', key: 'task-a' }],
    ['control mutation', { kind: 'session_ready', controlId: 'control-a' }],
  ])('rejects %s on the workspace write port', (_description, mutation) => {
    expect(() =>
      validateNativeOnceWorkspaceWrite(
        write(mutation as NativeOnceWorkspaceMutation),
        scope,
      ),
    ).toThrow(NativeOnceWorkspaceError);
  });

  it.each([
    { writeId: 'not-a-uuid' },
    { expectedRevision: -1 },
    { expectedRevision: 0.5 },
    { expectedRevision: Number.MAX_SAFE_INTEGER },
  ])('rejects invalid write identity %j', (change) => {
    expect(() =>
      validateNativeOnceWorkspaceWrite({ ...write(put()), ...change }, scope),
    ).toThrow('write_identity');
  });

  const invalidJson: Array<[string, () => unknown]> = [
    [
      'null prototype',
      () => Object.assign(Object.create(null), { value: true }),
    ],
    ['undefined', () => ({ value: undefined })],
    ['NaN', () => ({ value: NaN })],
    ['Infinity', () => ({ value: Infinity })],
    ['BigInt', () => ({ value: 1n })],
    ['function', () => ({ value: () => undefined })],
    ['Date instance', () => ({ value: new Date(at) })],
    ['array hole', () => new Array(2)],
    [
      'accessor',
      () =>
        Object.defineProperty({}, 'value', {
          enumerable: true,
          get() {
            throw new Error('getter must not run');
          },
        }),
    ],
    [
      'array accessor',
      () =>
        Object.defineProperty([], '0', {
          enumerable: true,
          get() {
            throw new Error('array getter must not run');
          },
        }),
    ],
    [
      'symbol key',
      () => Object.assign({ value: true }, { [Symbol('hidden')]: true }),
    ],
    [
      'nonenumerable property',
      () => Object.defineProperty({}, 'value', { value: true }),
    ],
    [
      'cycle',
      () => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return value;
      },
    ],
  ];
  it.each(invalidJson)(
    'rejects %s before canonicalization',
    (_name, makeValue) => {
      expect(() => nativeOnceWorkspaceDigest(makeValue())).toThrow(
        NativeOnceWorkspaceError,
      );
      expect(() => nativeOnceWorkspaceDigest(makeValue())).toThrow(
        'invalid_json',
      );
    },
  );

  it('accepts repeated references when they do not form a cycle', () => {
    const shared = { value: true };
    expect(nativeOnceWorkspaceDigest({ a: shared, b: shared })).toBe(
      nativeOnceWorkspaceDigest({ a: { value: true }, b: { value: true } }),
    );
  });

  it('enforces independent snapshot and envelope byte, node and depth bounds', () => {
    const snapshotBytes = 2 * 1024 * 1024;
    expect(() =>
      nativeOnceWorkspaceDigest('x'.repeat(snapshotBytes - 2)),
    ).not.toThrow();
    expect(() =>
      nativeOnceWorkspaceDigest('x'.repeat(snapshotBytes - 1)),
    ).toThrow('json_limit');
    expect(() =>
      nativeOnceWorkspaceDigest('x'.repeat(snapshotBytes), true),
    ).not.toThrow();
    expect(() =>
      nativeOnceWorkspaceDigest('x'.repeat(4 * 1024 * 1024 - 1), true),
    ).toThrow('json_limit');

    const manyNodes = Array.from({ length: 40_000 }, () => null);
    expect(() => nativeOnceWorkspaceDigest(manyNodes)).toThrow('json_limit');
    expect(() => nativeOnceWorkspaceDigest(manyNodes, true)).not.toThrow();

    let deep: unknown = null;
    for (let index = 0; index < 17; index++) deep = { child: deep };
    expect(() => nativeOnceWorkspaceDigest(deep)).toThrow('json_limit');
    expect(() => nativeOnceWorkspaceDigest(deep, true)).not.toThrow();
  });
});
