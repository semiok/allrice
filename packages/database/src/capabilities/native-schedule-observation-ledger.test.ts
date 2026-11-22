import { createHash, randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import {
  createPostgresNativeScheduleObservationLedger,
  type NativeScheduleSnapshotReceiptInput,
} from './native-schedule-observation-ledger.ts';

function input(): NativeScheduleSnapshotReceiptInput {
  const items = [
    {
      fingerprint: 'sha256:' + 'a'.repeat(64),
      id: 'native-task',
      scheduledAt: '2099-01-01T00:00:00.000Z',
      sessionId: 'native-session',
      status: 'active' as const,
    },
  ];
  return {
    kind: 'snapshot',
    receiptId: randomUUID(),
    invalidateReceiptIds: [],
    origin: {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      personId: randomUUID(),
      vmId: randomUUID(),
      instanceId: randomUUID(),
      leaseEpoch: 1,
      employeeInstanceId: randomUUID(),
      employeeRevision: 1,
      employeeVersionId: randomUUID(),
      bindingRef: 'actual-host-reference-required',
    },
    batch: {
      items,
      fingerprint:
        'sha256:' +
        createHash('sha256').update(JSON.stringify(items)).digest('hex'),
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function pending<T>(promise: Promise<T>) {
  return Object.assign(promise, { cancel: vi.fn() });
}

describe('receipt storage contracts; scripted SQL is not migration or authority evidence', () => {
  it.each(['commitBatch', 'readExactReceipt'] as const)(
    'does not start a pre-canceled %s',
    async (method) => {
      const db = Object.assign(vi.fn(), { begin: vi.fn() }) as unknown as Sql;
      const abort = new AbortController();
      abort.abort();
      await expect(
        createPostgresNativeScheduleObservationLedger(db)[method](
          input(),
          abort.signal,
        ),
      ).rejects.toBe(abort.signal.reason);
      expect(db).not.toHaveBeenCalled();
      expect(db.begin).not.toHaveBeenCalled();
    },
  );

  it.each([
    (value: NativeScheduleSnapshotReceiptInput) => ({
      ...value,
      unexpected: true,
    }),
    (value: NativeScheduleSnapshotReceiptInput) => ({
      ...value,
      batch: { ...value.batch, fingerprint: 'sha256:' + 'b'.repeat(64) },
    }),
    (value: NativeScheduleSnapshotReceiptInput) => ({
      ...value,
      invalidateReceiptIds: [value.receiptId],
    }),
    (value: NativeScheduleSnapshotReceiptInput) => ({
      ...value,
      invalidateReceiptIds: [value.origin.vmId, value.origin.vmId],
    }),
    (value: NativeScheduleSnapshotReceiptInput) => ({
      ...value,
      origin: { ...value.origin, leaseEpoch: 0 },
    }),
    (value: NativeScheduleSnapshotReceiptInput) => ({
      ...value,
      batch: {
        ...value.batch,
        items: [
          { ...value.batch.items[0]!, prompt: 'must not enter the ledger' },
        ],
      },
    }),
  ])('rejects malformed envelopes before any SQL', async (change) => {
    const db = Object.assign(vi.fn(), { begin: vi.fn() }) as unknown as Sql;
    await expect(
      createPostgresNativeScheduleObservationLedger(db).commitBatch(
        change(input()) as NativeScheduleSnapshotReceiptInput,
      ),
    ).rejects.toBeDefined();
    expect(db.begin).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  it('cancels actual pending SQL, waits for settlement, and does not manufacture an empty receipt', async () => {
    const gate = deferred<[]>(),
      query = pending(gate.promise);
    const db = vi.fn(() => query) as unknown as Sql;
    const abort = new AbortController();
    const result = createPostgresNativeScheduleObservationLedger(
      db,
    ).readExactReceipt(input(), abort.signal);
    const settled = vi.fn();
    const handled = result.then(settled, settled);
    abort.abort();
    await Promise.resolve();
    expect(query.cancel).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    gate.resolve([]);
    await expect(result).rejects.toBe(abort.signal.reason);
    await handled;
  });

  it('retains the actual SQL error and cancellation reason without inferring SQLSTATE', async () => {
    const gate = deferred<[]>(),
      query = pending(gate.promise);
    const db = vi.fn(() => query) as unknown as Sql;
    const abort = new AbortController(),
      sqlError = Error('actual SQL failure');
    const result = createPostgresNativeScheduleObservationLedger(
      db,
    ).readExactReceipt(input(), abort.signal);
    const caught = result.catch((error: unknown) => error);
    abort.abort();
    gate.reject(sqlError);
    const error = await caught;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      sqlError,
      abort.signal.reason,
    ]);
    expect((error as Error).cause).toBe(sqlError);
  });

  function transactionFixture() {
    const committing = deferred<void>(),
      commit = deferred<void>();
    const tx = Object.assign(
      vi.fn((parts: TemplateStringsArray, ...values: unknown[]) => {
        const rows = parts.join('').includes('insert into')
          ? [
              {
                receipt_id: values[0],
                input_digest: values[6],
                input_payload: values[7],
                received_at: new Date('2026-11-22T00:00:00.000Z'),
              },
            ]
          : [];
        return pending(Promise.resolve(rows));
      }),
      { json: (value: unknown) => structuredClone(value) },
    ) as unknown as TransactionSql;
    const db = Object.assign(vi.fn(), {
      begin: vi.fn(async (run: (value: TransactionSql) => Promise<unknown>) => {
        const result = await run(tx);
        committing.resolve();
        await commit.promise;
        return result;
      }),
    }) as unknown as Sql;
    return { db, tx, committing, commit };
  }

  it('joins a pending transaction COMMIT before suppressing a canceled success', async () => {
    const f = transactionFixture(),
      abort = new AbortController();
    const result = createPostgresNativeScheduleObservationLedger(
      f.db,
    ).commitBatch(input(), abort.signal);
    const settled = vi.fn(),
      handled = result.then(settled, settled);
    await f.committing.promise;
    abort.abort();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    f.commit.resolve();
    await expect(result).rejects.toBe(abort.signal.reason);
    await handled;
    expect(f.db.begin).toHaveBeenCalledOnce();
  });

  it('preserves a lost COMMIT acknowledgement error and never retries the write', async () => {
    const f = transactionFixture(),
      error = Error('commit acknowledgement unknown');
    const result = createPostgresNativeScheduleObservationLedger(
      f.db,
    ).commitBatch(input());
    const caught = result.catch((failure: unknown) => failure);
    await f.committing.promise;
    f.commit.reject(error);
    expect(await caught).toBe(error);
    expect(f.db.begin).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'joins rollback and retains the original callback and rollback failures (abort=%s)',
    async (cancelDuringRollback) => {
      const rollingBack = deferred<unknown>(),
        rollback = deferred<void>();
      const rollbackError = Error('driver rollback failed');
      // Empty reads make the real ledger reject a missing reference. The SQL
      // list helper is a fragment; only tagged requests return pending results.
      const tx = vi.fn((parts: TemplateStringsArray | string[]) =>
        'raw' in parts ? pending(Promise.resolve([])) : { values: parts },
      ) as unknown as TransactionSql;
      const db = Object.assign(vi.fn(), {
        begin: vi.fn(
          async (run: (value: TransactionSql) => Promise<unknown>) => {
            let original: unknown;
            try {
              await run(tx);
            } catch (error) {
              original = error;
            }
            rollingBack.resolve(original);
            await rollback.promise;
            // Model the driver's distinct rollback rejection replacing the
            // actual callback error; do not synthesize a ledger error here.
            if (original !== undefined) throw rollbackError;
          },
        ),
      }) as unknown as Sql;
      const abort = new AbortController();
      const result = createPostgresNativeScheduleObservationLedger(
        db,
      ).commitBatch(
        { ...input(), invalidateReceiptIds: [randomUUID()] },
        abort.signal,
      );
      const settled = vi.fn();
      const outcome = result.finally(settled).catch((error: unknown) => error);
      try {
        const original = await rollingBack.promise;
        expect(original).toMatchObject({ code: 'invalid_receipt_reference' });
        if (cancelDuringRollback)
          abort.abort(Error('caller canceled during rollback'));
        // Drain the event-loop turn without a timer or settling the driver.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).not.toHaveBeenCalled();
        rollback.resolve();
        const error = await outcome;
        expect(error).toBeInstanceOf(AggregateError);
        const failures = (error as AggregateError).errors as unknown[];
        expect((error as Error).cause).toBe(original);
        expect(failures).toHaveLength(cancelDuringRollback ? 3 : 2);
        expect(failures[0]).toBe(original);
        expect(failures[1]).toBe(rollbackError);
        if (cancelDuringRollback) expect(failures[2]).toBe(abort.signal.reason);
        expect(db.begin).toHaveBeenCalledOnce();
      } finally {
        rollback.resolve();
        await outcome;
      }
    },
  );
});
