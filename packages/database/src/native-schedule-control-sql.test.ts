import { describe, expect, it, vi } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
import {
  createNativeScheduleControlSqlStore,
  NativeOnceSqlError,
  type NativeOnceClosedProof,
  type NativeScheduleControlPartition,
} from './native-schedule-control-sql.ts';
import {
  createNativeOnceSqlStore,
  NativeOnceSqlError as OnceExportedError,
} from './native-schedule-once-sql.ts';
import {
  nativeOnceDigest,
  type NativeOnceWriter,
} from './native-schedule-once-state.ts';
import {
  nativeOnceWorkspaceDigest,
  type NativeOnceWorkspaceWrite,
} from './native-schedule-workspace-state.ts';

// Keep these adapter checks independent of runtime-policy's product/DB imports.
// Digest policy itself has separate tests; all SQL here is an in-memory stub.
vi.mock('./runtime-policy.ts', async () => {
  const { createHash } = await import('node:crypto');
  const ordered = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(ordered)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, ordered(child)]),
          )
        : value;
  return {
    runtimePolicyDigest: (value: unknown) =>
      'sha256:' +
      createHash('sha256')
        .update(JSON.stringify(ordered(value)))
        .digest('hex'),
  };
});

const ready = {
  enabled: true,
  storageReady: true,
  legacyClockExcluded: true,
  controlArtifactApproved: true,
};
const reference = {
  artifactId: `sha256:${'a'.repeat(64)}`,
  profileId: 'approved-control-profile',
  storageId: 'stable-control-storage',
  stateRoot: '/owned/control-root',
};
const writer: NativeOnceWriter = {
  partitionId: 'partition-a',
  ownerId: 'worker-a',
  epoch: 1,
  token: 'synthetic-token',
};
type Query = { text: string; values: unknown[] };

function fixture<C extends { controlSessionId: string }>(controls: C[]) {
  let p: NativeScheduleControlPartition = {
    partition_id: writer.partitionId,
    owner_id: writer.ownerId,
    epoch: writer.epoch,
    token_digest: nativeOnceDigest(writer.token),
    expires_at_ms: 31_000,
    closed: false,
    reference: structuredClone(reference),
    activation: { ...ready },
    workspace_snapshot: null,
    close_proof: null,
  };
  const state = {
    now: 1_000,
    journal: null as Record<string, unknown> | null,
    proof: null as NativeOnceClosedProof | null,
    queries: [] as Query[],
    begins: [] as boolean[],
    unknown: null as 'committed' | 'absent' | 'deferred-fence' | null,
    expireAfterJournal: false,
    afterLoad: () => {},
    loadTransactions: [] as TransactionSql[],
  };
  const unknownError = new Error('synthetic lost COMMIT ACK');
  const deferredError = Object.assign(new Error('synthetic deferred fence'), {
    code: 'P1920',
  });
  const tx = Object.assign(
    async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.join('?').replace(/\s+/g, ' ').trim();
      state.queries.push({ text, values: structuredClone(values) });
      if (text.startsWith('select set_config')) return [];
      if (text.includes('clock_timestamp())*1000'))
        return [{ now_ms: state.now }];
      if (text.startsWith('select proof from allrice_native_once_close_proofs'))
        return state.proof ? [{ proof: structuredClone(state.proof) }] : [];
      if (
        text.startsWith('select') &&
        text.includes('from allrice_native_once_partitions')
      )
        return [structuredClone(p)];
      if (
        text.startsWith('select') &&
        text.includes('from allrice_native_once_journal')
      )
        return state.journal ? [structuredClone(state.journal)] : [];
      if (
        text.startsWith('update allrice_native_once_partitions set owner_id=')
      ) {
        p.owner_id = values[0] as string;
        p.epoch = values[1] as number;
        p.token_digest = values[2] as string;
        p.expires_at_ms = values[3] as number;
        p.closed = false;
        p.close_proof = null;
        return [];
      }
      if (
        text.startsWith(
          'update allrice_native_once_partitions set workspace_snapshot=',
        )
      ) {
        p.workspace_snapshot = structuredClone(
          values[0],
        ) as typeof p.workspace_snapshot;
        return [{ partition_id: p.partition_id }];
      }
      if (text.startsWith('insert into allrice_native_once_journal')) {
        state.journal = {
          entry_kind: 'workspace',
          control_id: null,
          occurrence_id: null,
          writer_owner_id: values[2],
          writer_epoch: values[3],
          writer_token_digest: values[4],
          reference: values[5],
          write_digest: values[6],
          mutation: values[7],
          journal: values[8],
          after_snapshot: values[9],
          after_digest: values[10],
        };
        if (state.expireAfterJournal) state.now = p.expires_at_ms!;
        return [];
      }
      if (text.startsWith('insert into allrice_native_once_close_proofs')) {
        state.proof = structuredClone(values[3]) as NativeOnceClosedProof;
        return [];
      }
      if (
        text.startsWith('update allrice_native_once_partitions set closed=true')
      ) {
        p.closed = true;
        p.close_proof = structuredClone(values[0]) as NativeOnceClosedProof;
        return [{ partition_id: p.partition_id }];
      }
      throw new Error('unexpected pure fixture SQL: ' + text);
    },
    { json: (value: unknown) => structuredClone(value) },
  ) as unknown as TransactionSql;
  const db = {
    begin: async (...args: unknown[]) => {
      state.begins.push(typeof args[0] === 'string');
      const before = structuredClone({
        p,
        journal: state.journal,
        proof: state.proof,
      });
      try {
        const result = await (
          args.at(-1) as (tx: TransactionSql) => Promise<unknown>
        )(tx);
        const unknown = state.unknown;
        state.unknown = null;
        if (unknown) {
          if (unknown !== 'committed') {
            p = before.p;
            state.journal = before.journal;
            state.proof = before.proof;
          }
          throw unknown === 'deferred-fence' ? deferredError : unknownError;
        }
        return result;
      } catch (error) {
        if (error !== unknownError) {
          p = before.p;
          state.journal = before.journal;
          state.proof = before.proof;
        }
        throw error;
      }
    },
  } as unknown as Sql;
  const options = {
    db,
    partitionId: writer.partitionId,
    ownerId: writer.ownerId,
    reference: structuredClone(reference),
    readiness: () => ({ ...ready }),
    proveClosed: async (): Promise<NativeOnceClosedProof | null> => null,
    loadControls: async (given: TransactionSql) => {
      state.loadTransactions.push(given);
      state.afterLoad();
      return controls;
    },
  };
  return {
    options,
    state,
    tx,
    unknownError,
    deferredError,
    partition: () => p,
    store: createNativeScheduleControlSqlStore(options),
  };
}

function workspaceWrite(
  session = 'control-session-a',
): NativeOnceWorkspaceWrite {
  const mutation = {
    kind: 'put_record' as const,
    table: 'workspaces' as const,
    key: 'workspace-a',
    value: {
      path: reference.stateRoot,
      title: 'control',
      sessionIds: [session],
      createdAt: '2030-01-01T00:00:00.000Z',
      updatedAt: '2030-01-01T00:00:00.000Z',
    },
  };
  return {
    writeId: '9bf69cbd-41cd-4257-bc5c-5a8a93297809',
    expectedRevision: 0,
    mutation,
    digest: nativeOnceWorkspaceDigest(
      { entryKind: 'workspace', unitVersion: 2, expectedRevision: 0, mutation },
      true,
    ),
  };
}

describe('shared native control SQL without a DB or scheduler', () => {
  it('preserves the old error constructor and exact once method surface', () => {
    expect(OnceExportedError).toBe(NativeOnceSqlError);
    const f = fixture([]);
    const once = createNativeOnceSqlStore({
      ...f.options,
      decodeTask: (value) => value as never,
      lockAdmission: async () => new Map(),
    });
    expect(Object.keys(once).sort()).toEqual(
      [
        'acquireWriter',
        'assertWriter',
        'commitMutation',
        'commitMutationBatch',
        'commitWorkspaceWrite',
        'loadControls',
        'loadTaskRecords',
        'loadWorkspaceUnit',
        'readExactCommit',
        'releaseClosedWriter',
        'renewWriter',
      ].sort(),
    );
    expect(f.state.begins).toEqual([]);
  });

  it('keeps format-owned control fields and uses the supplied transaction', async () => {
    for (const format of ['once', 'recurring']) {
      const original = [
        { controlSessionId: 'control-session-a', format, revision: 7 },
      ];
      const f = fixture(original);
      const loaded = await f.store.loadControls(writer);
      expect(loaded).toEqual(original);
      expect(f.state.loadTransactions).toEqual([f.tx]);
      loaded[0]!.revision = 99;
      expect(original[0]!.revision).toBe(7);
    }
  });

  it('acquires only a genuinely closed partition and clones generic controls/reference', async () => {
    const f = fixture([
      { controlSessionId: 'control-session-a', recurringRule: 'format-owned' },
    ]);
    Object.assign(f.partition(), {
      owner_id: null,
      epoch: 0,
      token_digest: null,
      expires_at_ms: null,
      closed: true,
      close_proof: { kind: 'never_acquired' },
    });
    f.options.reference.storageId = 'caller-mutation';
    const grant = await f.store.acquireWriter();
    expect(grant?.reference).toEqual(reference);
    expect(grant?.controls[0]?.recurringRule).toBe('format-owned');
    expect(grant?.writer.epoch).toBe(1);
  });

  it('does not treat an expired live writer as closed', async () => {
    const f = fixture([]);
    f.state.now = f.partition().expires_at_ms! + 1;
    expect(await f.store.acquireWriter()).toBeNull();
    expect(f.state.loadTransactions).toEqual([]);
  });

  it('requires the immutable persisted audit proof before reacquiring a closed epoch', async () => {
    const f = fixture([]);
    Object.assign(f.partition(), {
      closed: true,
      close_proof: {
        kind: 'public_host_backend_drained',
        proofId: 'proof-a',
        partitionId: writer.partitionId,
        ownerId: writer.ownerId,
        epoch: writer.epoch,
        tokenDigest: nativeOnceDigest(writer.token),
        evidence: { drained: true },
      },
    });
    expect(await f.store.acquireWriter()).toBeNull();
  });

  it('rechecks DB wall time after the format control read', async () => {
    const f = fixture([{ controlSessionId: 'control-session-a' }]);
    f.state.afterLoad = () => {
      f.state.now = f.partition().expires_at_ms!;
    };
    await expect(f.store.loadControls(writer)).rejects.toMatchObject({
      code: 'lease_lost',
    });
  });

  it('requires both deployed and persisted readiness', async () => {
    const f = fixture([]);
    f.partition().activation.controlArtifactApproved = false;
    expect(await f.store.assertWriter(writer)).toBe(false);
  });

  it('refuses release without real close evidence before opening a transaction', async () => {
    const f = fixture([]);
    await expect(f.store.releaseClosedWriter(writer)).rejects.toBeInstanceOf(
      OnceExportedError,
    );
    expect(f.state.begins).toEqual([]);
  });

  it('writes and retains the identical close proof on an idempotent release', async () => {
    const f = fixture([]);
    const proof: NativeOnceClosedProof = {
      kind: 'public_host_backend_drained',
      proofId: 'proof-a',
      partitionId: writer.partitionId,
      ownerId: writer.ownerId,
      epoch: writer.epoch,
      tokenDigest: nativeOnceDigest(writer.token),
      evidence: { bothBackendsDrained: true },
    };
    f.options.proveClosed = async () => proof;
    await f.store.releaseClosedWriter(writer);
    await f.store.releaseClosedWriter(writer);
    expect(f.state.proof).toEqual(proof);
    expect(
      f.state.queries.filter((r) =>
        r.text.startsWith('insert into allrice_native_once_close_proofs'),
      ),
    ).toHaveLength(1);
  });

  it('restricts the shared workspace to the format-owned control sessions', async () => {
    const f = fixture([{ controlSessionId: 'control-session-a' }]);
    await expect(
      f.store.commitWorkspaceWrite(writer, workspaceWrite('foreign-session')),
    ).rejects.toThrow();
    expect(f.state.queries.some((r) => r.text.startsWith('update '))).toBe(
      false,
    );
  });

  it('keeps workspace-only journal rows independent of business control foreign keys', async () => {
    const f = fixture([{ controlSessionId: 'control-session-a' }]);
    expect(
      await f.store.commitWorkspaceWrite(writer, workspaceWrite()),
    ).toEqual({ revision: 1 });
    expect(f.state.journal).toMatchObject({
      entry_kind: 'workspace',
      control_id: null,
      occurrence_id: null,
    });
    expect(
      f.state.queries.some((r) =>
        /allrice_native_once_(controls|occurrences)/.test(r.text),
      ),
    ).toBe(false);
  });

  it('resolves a lost COMMIT ACK with one exact read and never resends the mutation', async () => {
    const f = fixture([{ controlSessionId: 'control-session-a' }]);
    f.state.unknown = 'committed';
    expect(
      await f.store.commitWorkspaceWrite(writer, workspaceWrite()),
    ).toEqual({ revision: 1 });
    expect(f.state.begins).toEqual([false, true]);
    expect(
      f.state.queries.filter((r) =>
        r.text.startsWith('insert into allrice_native_once_journal'),
      ),
    ).toHaveLength(1);
  });

  it('preserves the original unknown error if the exact historical write is absent', async () => {
    const f = fixture([{ controlSessionId: 'control-session-a' }]);
    f.state.unknown = 'absent';
    await expect(
      f.store.commitWorkspaceWrite(writer, workspaceWrite()),
    ).rejects.toBe(f.unknownError);
    expect(f.state.begins).toEqual([false, true]);
    expect(
      f.state.queries.filter((r) =>
        r.text.startsWith('insert into allrice_native_once_journal'),
      ),
    ).toHaveLength(1);
  });

  it('rolls the workspace and journal back if the final DB-time fence fails', async () => {
    const f = fixture([{ controlSessionId: 'control-session-a' }]);
    f.state.expireAfterJournal = true;
    await expect(
      f.store.commitWorkspaceWrite(writer, workspaceWrite()),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    expect(f.partition().workspace_snapshot).toBeNull();
    expect(f.state.journal).toBeNull();
    expect(f.state.begins).toEqual([false]);
  });

  it('preserves the deferred COMMIT fence rejection without an exact-read success claim', async () => {
    const f = fixture([{ controlSessionId: 'control-session-a' }]);
    f.state.unknown = 'deferred-fence';
    await expect(
      f.store.commitWorkspaceWrite(writer, workspaceWrite()),
    ).rejects.toBe(f.deferredError);
    expect(f.state.begins).toEqual([false]);
    expect(f.state.journal).toBeNull();
  });

  it('retains transaction-local timeout bounds for repeatable historical reads', async () => {
    const f = fixture([]);
    await f.store.bounded(async () => 'historical', true);
    expect(f.state.begins).toEqual([true]);
    expect(f.state.queries[0]?.values).toEqual(['500', '2000']);
    expect(f.state.queries[0]?.text).toContain(
      "idle_in_transaction_session_timeout', '10000'",
    );
  });
});
