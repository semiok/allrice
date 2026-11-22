import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { UuidSchema } from '@allrice/contracts';
import type { Sql, TransactionSql } from 'postgres';
import { z } from 'zod';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.iso
  .datetime({ precision: 3 })
  .refine((value) => !value.startsWith('0000-'));
const originSchema = z
  .object({
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    personId: UuidSchema,
    vmId: UuidSchema,
    instanceId: UuidSchema,
    leaseEpoch: z.number().int().positive(),
    employeeInstanceId: UuidSchema,
    employeeRevision: z.number().int().positive(),
    employeeVersionId: UuidSchema,
    bindingRef: z.string().min(1),
  })
  .strict();
const batchSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().min(1),
            sessionId: z.string().min(1),
            status: z.enum(['active', 'inactive']),
            scheduledAt: instant,
            fingerprint: digestSchema,
          })
          .strict(),
      )
      .readonly(),
    fingerprint: digestSchema,
  })
  .strict();
const shared = {
  receiptId: UuidSchema,
  origin: originSchema,
  invalidateReceiptIds: z.array(UuidSchema).readonly(),
};
const snapshotSchema = z
  .object({
    ...shared,
    kind: z.literal('snapshot'),
    batch: batchSchema,
  })
  .strict();
const invalidationSchema = z
  .object({
    ...shared,
    kind: z.literal('invalidation'),
    reasonRef: z.string().min(1),
  })
  .strict();
const operationSchema = z.discriminatedUnion('kind', [
  snapshotSchema,
  invalidationSchema,
]);

/** Provenance supplied by the host owner; parsing it does not authenticate it. */
export type NativeScheduleLedgerOrigin = z.infer<typeof originSchema>;
export type NativeScheduleSnapshotReceiptInput = z.infer<typeof snapshotSchema>;
export type NativeScheduleInvalidationReceiptInput = z.infer<
  typeof invalidationSchema
>;
type Operation =
  NativeScheduleSnapshotReceiptInput | NativeScheduleInvalidationReceiptInput;
export type NativeScheduleObservationReceipt = Readonly<{
  receiptId: string;
  inputDigest: string;
  operation: Operation;
  receivedAt: string;
}>;
type Row = {
  receipt_id: string;
  input_digest: string;
  input_payload: unknown;
  received_at: Date;
};

class LedgerError extends Error {
  constructor(
    readonly code:
      | 'receipt_conflict'
      | 'invalid_receipt_reference'
      | 'stored_receipt_invalid'
      | 'invalid_input',
  ) {
    super(code);
  }
}

/** Exact JSON hashing: no omitted fields, getters, sparse arrays or toJSON. */
function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (!value || typeof value !== 'object')
    throw new LedgerError('invalid_input');
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1)
      throw new LedgerError('invalid_input');
    return (
      '[' +
      Array.from({ length: value.length }, (_, index) => {
        const field = Object.getOwnPropertyDescriptor(value, String(index));
        if (!field?.enumerable || !('value' in field))
          throw new LedgerError('invalid_input');
        return canonical(field.value);
      }).join(',') +
      ']'
    );
  }
  if (Object.getPrototypeOf(value) !== Object.prototype)
    throw new LedgerError('invalid_input');
  const fields: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !field?.enumerable || !('value' in field))
      throw new LedgerError('invalid_input');
    fields.push([key, field.value]);
  }
  fields.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    '{' +
    fields
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
      .join(',') +
    '}'
  );
}
const digest = (value: string) =>
  'sha256:' + createHash('sha256').update(value).digest('hex');

function prepare(value: unknown, kind?: Operation['kind']) {
  const serialized = canonical(value);
  const operation = operationSchema.parse(value);
  if (!isDeepStrictEqual(operation, value) || (kind && operation.kind !== kind))
    throw new LedgerError('invalid_input');
  const ids = operation.invalidateReceiptIds.map((id) => id.toLowerCase());
  if (
    new Set(ids).size !== ids.length ||
    ids.includes(operation.receiptId.toLowerCase()) ||
    (operation.kind === 'invalidation' && ids.length === 0)
  )
    throw new LedgerError('invalid_input');
  if (operation.kind === 'snapshot') {
    const items = operation.batch.items;
    if (
      items.some((item, i) => i > 0 && items[i - 1]!.id >= item.id) ||
      digest(canonical(items)) !== operation.batch.fingerprint
    )
      throw new LedgerError('invalid_input');
  }
  return { operation, inputDigest: digest(serialized) };
}

function receipt(row: Row): NativeScheduleObservationReceipt {
  const expected = prepare(row.input_payload);
  if (
    row.receipt_id !== expected.operation.receiptId.toLowerCase() ||
    row.input_digest !== expected.inputDigest ||
    !(row.received_at instanceof Date) ||
    !Number.isFinite(row.received_at.getTime())
  )
    throw new LedgerError('stored_receipt_invalid');
  return {
    receiptId: row.receipt_id,
    inputDigest: row.input_digest,
    operation: expected.operation,
    receivedAt: row.received_at.toISOString(),
  };
}

type Pending<T> = PromiseLike<T> & { cancel(): void };
type Query = <T>(pending: Pending<T>) => Promise<T>;

/** Own actual SQL cancellation and await the whole transaction, including its
 * COMMIT/ROLLBACK. Internal COMMIT has no public cancel handle: join it instead.
 * Keep separately observed query/transaction failures and the caller's reason. */
async function joined<T>(
  signal: AbortSignal | undefined,
  work: (query: Query, recordFailure: (error: unknown) => void) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const failures: unknown[] = [];
  const query: Query = async (pending) => {
    const cancel = () => pending.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (signal?.aborted) cancel();
      const result = await pending;
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      failures.push(error);
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  };
  try {
    const result = await work(query, (error) => {
      failures.push(error);
    });
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (!failures.includes(error)) failures.push(error);
    const errors = failures.filter(
      (item, index) =>
        failures.indexOf(item) === index &&
        (!signal?.aborted || item !== signal.reason),
    );
    if (signal?.aborted) errors.push(signal.reason);
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(
      errors,
      'native_schedule_ledger_operation_failed',
      { cause: errors[0] },
    );
  }
}

/** Concrete storage backend for this module's own append-only receipt table.
 * No current-authority/producer ordering, native identity, latest head or wake.
 * Caller owns the SQL client and trusted composition; this factory creates none.
 * A rejected write has unknown commit status until its exact receipt is found. */
export function createPostgresNativeScheduleObservationLedger(db: Sql) {
  async function existing(
    sql: Sql | TransactionSql,
    operation: Operation,
    query: Query,
  ) {
    const o = operation.origin;
    const rows = await query(sql<
      Row[]
    >`select receipt_id,input_digest,input_payload,received_at
      from allrice_native_schedule_observation_receipts
      where receipt_id=${operation.receiptId} and organization_id=${o.organizationId}
        and workspace_id=${o.workspaceId} and person_id=${o.personId}
        and vm_id=${o.vmId} and employee_instance_id=${o.employeeInstanceId}`);
    return rows[0];
  }
  function exact(row: Row, expected: ReturnType<typeof prepare>) {
    const stored = receipt(row);
    if (
      stored.inputDigest !== expected.inputDigest ||
      !isDeepStrictEqual(stored.operation, expected.operation)
    )
      throw new LedgerError('receipt_conflict');
    return stored;
  }
  function write(
    input: Operation,
    kind: Operation['kind'],
    signal?: AbortSignal,
  ) {
    return joined(signal, async (query, recordFailure) => {
      const expected = prepare(input, kind);
      const { operation, inputDigest } = expected;
      const o = operation.origin;
      const transaction = async (tx: TransactionSql) => {
        const previous = await existing(tx, operation, query);
        if (previous) return exact(previous, expected);
        if (operation.invalidateReceiptIds.length) {
          const targets = await query(tx<
            Row[]
          >`select receipt_id,input_digest,input_payload,received_at
            from allrice_native_schedule_observation_receipts
            where receipt_id in ${tx([...operation.invalidateReceiptIds])} and organization_id=${o.organizationId}
              and workspace_id=${o.workspaceId} and person_id=${o.personId}
              and vm_id=${o.vmId} and employee_instance_id=${o.employeeInstanceId}`);
          if (
            targets.length !== operation.invalidateReceiptIds.length ||
            targets.some((row) => receipt(row).operation.kind !== 'snapshot')
          )
            throw new LedgerError('invalid_receipt_reference');
        }
        signal?.throwIfAborted();
        const rows = await query(tx<
          Row[]
        >`insert into allrice_native_schedule_observation_receipts
          (receipt_id,organization_id,workspace_id,person_id,vm_id,employee_instance_id,input_digest,input_payload)
          values(${operation.receiptId},${o.organizationId},${o.workspaceId},${o.personId},${o.vmId},${o.employeeInstanceId},
            ${inputDigest},${tx.json(JSON.parse(canonical(operation)))})
          on conflict(receipt_id) do nothing returning receipt_id,input_digest,input_payload,received_at`);
        const row = rows[0] ?? (await existing(tx, operation, query));
        if (!row) throw new LedgerError('receipt_conflict');
        return exact(row, expected);
      };
      return db.begin(async (tx) => {
        try {
          return await transaction(tx);
        } catch (error) {
          // The driver may replace this rejection if its rollback also fails.
          recordFailure(error);
          throw error;
        }
      });
    });
  }
  return {
    commitBatch(
      input: NativeScheduleSnapshotReceiptInput,
      signal?: AbortSignal,
    ) {
      return write(input, 'snapshot', signal);
    },
    invalidateReceipts(
      input: NativeScheduleInvalidationReceiptInput,
      signal?: AbortSignal,
    ) {
      return write(input, 'invalidation', signal);
    },
    readExactReceipt(input: Operation, signal?: AbortSignal) {
      return joined(signal, async (query) => {
        const expected = prepare(input);
        const row = await existing(db, expected.operation, query);
        // Absence is only lack of exact commit evidence, never proof of rollback.
        return row ? exact(row, expected) : null;
      });
    },
  };
}
