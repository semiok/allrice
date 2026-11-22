import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres, { type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertRuntimeFixtureDatabase } from '../runtime-fixture-database.ts';
import {
  createPostgresNativeScheduleObservationLedger,
  type NativeScheduleSnapshotReceiptInput,
} from './native-schedule-observation-ledger.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'actual observation receipt migration/SQL; no producer, native, model or VM authority',
  () => {
    let admin: ReturnType<typeof postgres>, db: ReturnType<typeof postgres>;
    const schema = 'met285_ledger_' + randomUUID().replaceAll('-', '');
    const origin = {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      personId: randomUUID(),
      vmId: randomUUID(),
      instanceId: randomUUID(),
      leaseEpoch: 1,
      employeeInstanceId: randomUUID(),
      employeeRevision: 1,
      employeeVersionId: randomUUID(),
      bindingRef: 'isolated-provenance-not-authority',
    };
    const items = [
      {
        fingerprint: 'sha256:' + 'a'.repeat(64),
        id: 'native-task',
        scheduledAt: '2099-01-01T00:00:00.000Z',
        sessionId: 'native-session',
        status: 'active' as const,
      },
    ];
    const batch = {
      items,
      fingerprint:
        'sha256:' +
        createHash('sha256').update(JSON.stringify(items)).digest('hex'),
    };
    const input = (
      extra: Partial<NativeScheduleSnapshotReceiptInput> = {},
    ): NativeScheduleSnapshotReceiptInput => ({
      kind: 'snapshot',
      receiptId: randomUUID(),
      origin,
      batch,
      invalidateReceiptIds: [],
      ...extra,
    });
    const ledger = () => createPostgresNativeScheduleObservationLedger(db);

    beforeAll(async () => {
      // Apply the allocated product migration, never replacement fixture DDL.
      const ddl = await readFile(
        new URL(
          '../../migrations/0254_native_schedule_observation_receipts.sql',
          import.meta.url,
        ),
        'utf8',
      );
      const source = process.env.ALLRICE_TEST_DATABASE_URL;
      if (!source) throw Error('Dedicated ALLRICE_TEST_DATABASE_URL required');
      assertRuntimeFixtureDatabase(new URL(source));
      admin = postgres(source, { max: 1 });
      await admin.unsafe(`create schema ${schema}`);
      db = postgres(source, {
        max: 4,
        connection: { search_path: schema, application_name: schema },
      });
      await db.unsafe(ddl);
    });
    afterAll(async () => {
      try {
        await db?.end({ timeout: 5 });
      } finally {
        try {
          if (admin)
            await admin.unsafe(`drop schema if exists ${schema} cascade`);
        } finally {
          await admin?.end({ timeout: 5 });
        }
      }
    });

    it('stores complete immutable facts and reconciles the exact original operation across a new reader', async () => {
      const request = input(),
        first = await ledger().commitBatch(request);
      expect(first.operation).toEqual(request);
      expect(await ledger().readExactReceipt(request)).toEqual(first);
      expect(await ledger().commitBatch(structuredClone(request))).toEqual(
        first,
      );
      expect(await ledger().readExactReceipt(input())).toBeNull();
      expect(first).not.toHaveProperty('current');
      expect(first).not.toHaveProperty('wakeEligible');
    });

    it('commits concurrent identical receipts once and rejects changed or cross-scope reuse', async () => {
      const request = input();
      const [a, b] = await Promise.all([
        ledger().commitBatch(request),
        ledger().commitBatch(request),
      ]);
      expect(a).toEqual(b);
      await expect(
        ledger().commitBatch({
          ...request,
          origin: { ...origin, employeeRevision: 2 },
        }),
      ).rejects.toMatchObject({ code: 'receipt_conflict' });
      const foreign = {
        ...request,
        origin: { ...origin, personId: randomUUID() },
      };
      expect(await ledger().readExactReceipt(foreign)).toBeNull();
      await expect(ledger().commitBatch(foreign)).rejects.toMatchObject({
        code: 'receipt_conflict',
      });
    });

    it('uses the real migration to forbid mutation or deletion of an existing receipt', async () => {
      const request = input();
      const stored = await ledger().commitBatch(request);
      await expect(
        db`update allrice_native_schedule_observation_receipts set received_at=now() where receipt_id=${request.receiptId}`,
      ).rejects.toBeDefined();
      await expect(
        db`delete from allrice_native_schedule_observation_receipts where receipt_id=${request.receiptId}`,
      ).rejects.toBeDefined();
      expect(await ledger().readExactReceipt(request)).toEqual(stored);
    });

    it('uses the real migration to bind payload scope and reject an incomplete snapshot shape', async () => {
      const request = input();
      for (const payload of [
        { ...request, origin: { ...origin, personId: randomUUID() } },
        { ...request, batch: { items: [] } },
      ]) {
        await expect(
          db`insert into allrice_native_schedule_observation_receipts
            (receipt_id,organization_id,workspace_id,person_id,vm_id,employee_instance_id,input_digest,input_payload)
            values(${request.receiptId},${origin.organizationId},${origin.workspaceId},${origin.personId},${origin.vmId},${origin.employeeInstanceId},
              ${'sha256:' + 'a'.repeat(64)},${db.json(JSON.parse(JSON.stringify(payload)))})`,
        ).rejects.toMatchObject({ code: '23514' });
      }
      expect(await ledger().readExactReceipt(request)).toBeNull();
    });

    it('atomically records a new snapshot and exact old invalidations, retaining the old evidence', async () => {
      const old = input();
      await ledger().commitBatch(old);
      const next = input({
        invalidateReceiptIds: [old.receiptId],
        origin: { ...origin, leaseEpoch: 2, instanceId: randomUUID() },
        batch: {
          items: [],
          fingerprint:
            'sha256:' + createHash('sha256').update('[]').digest('hex'),
        },
      });
      expect((await ledger().commitBatch(next)).operation).toEqual(next);
      expect((await ledger().readExactReceipt(old))!.operation).toEqual(old);
      const missing = input({ invalidateReceiptIds: [randomUUID()] });
      await expect(ledger().commitBatch(missing)).rejects.toMatchObject({
        code: 'invalid_receipt_reference',
      });
      expect(await ledger().readExactReceipt(missing)).toBeNull();
    });

    it('records explicit invalidation and refuses cross-scope or non-snapshot targets', async () => {
      const old = input();
      await ledger().commitBatch(old);
      const invalidation = {
        kind: 'invalidation' as const,
        receiptId: randomUUID(),
        origin,
        invalidateReceiptIds: [old.receiptId],
        reasonRef: 'owner-observed-source-loss',
      };
      expect(
        (await ledger().invalidateReceipts(invalidation)).operation,
      ).toEqual(invalidation);
      expect(await ledger().readExactReceipt(invalidation)).not.toBeNull();
      await expect(
        ledger().invalidateReceipts({
          ...invalidation,
          receiptId: randomUUID(),
          invalidateReceiptIds: [invalidation.receiptId],
        }),
      ).rejects.toMatchObject({ code: 'invalid_receipt_reference' });
      await expect(
        ledger().invalidateReceipts({
          ...invalidation,
          receiptId: randomUUID(),
          origin: { ...origin, employeeInstanceId: randomUUID() },
        }),
      ).rejects.toMatchObject({ code: 'invalid_receipt_reference' });
    });

    it('reads the original durable receipt after the real COMMIT succeeds but its reply is lost', async () => {
      const request = input(),
        error = Error('synthetic reply lost after actual commit');
      const lost = new Proxy(db, {
        get(target, key, receiver) {
          if (key === 'begin')
            return async (run: (tx: TransactionSql) => Promise<unknown>) => {
              await target.begin(run);
              throw error;
            };
          return Reflect.get(target, key, receiver);
        },
      });
      await expect(
        createPostgresNativeScheduleObservationLedger(lost).commitBatch(
          request,
        ),
      ).rejects.toBe(error);
      expect((await ledger().readExactReceipt(request))!.operation).toEqual(
        request,
      );
      const [row] = await db<
        { count: number }[]
      >`select count(*)::int count from allrice_native_schedule_observation_receipts where receipt_id=${request.receiptId}`;
      expect(row!.count).toBe(1);
    });

    it('cancels real lock-wait SQL and joins rollback before returning both observed failures', async () => {
      let release!: () => void, ready!: () => void;
      const locked = new Promise<void>((done) => {
        ready = done;
      });
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const holder = db.begin(async (tx) => {
        await tx`lock table allrice_native_schedule_observation_receipts in access exclusive mode`;
        ready();
        await gate;
      });
      await locked;
      const request = input(),
        abort = new AbortController();
      const result = ledger().commitBatch(request, abort.signal);
      const caught = result.catch((error: unknown) => error);
      try {
        await expect
          .poll(async () => {
            const [row] = await admin<
              { n: number }[]
            >`select count(*)::int n from pg_stat_activity where application_name=${schema} and wait_event_type='Lock'`;
            return row!.n;
          })
          .toBeGreaterThan(0);
        abort.abort();
        const error = await caught;
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors.at(-1)).toBe(
          abort.signal.reason,
        );
        expect((error as Error).cause).not.toBe(abort.signal.reason);
      } finally {
        abort.abort();
        release();
        await holder;
        await caught;
      }
      expect(await ledger().readExactReceipt(request)).toBeNull();
    });
  },
);
