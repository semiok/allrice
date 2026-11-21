import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertRuntimeFixtureDatabase } from '../../database/src/runtime-fixture-database.ts';
import { PostgresPersonVmStore } from './store.ts';
import { PersonVmError, PERSON_VM_COLD_MS } from './contract.ts';
import { context, harness, running, signal } from './test-support.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'person VM real PostgreSQL storage through public lifecycle entrypoints (no VM/model)',
  () => {
    const schema = 'person_vm_' + randomUUID().replaceAll('-', '');
    const appName = 'person-vm-test-' + randomUUID();
    let admin: postgres.Sql, db: postgres.Sql, store: PostgresPersonVmStore;
    beforeAll(async () => {
      const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
      assertRuntimeFixtureDatabase(url);
      admin = postgres(url.toString(), { max: 2, onnotice: () => {} });
      await admin.unsafe(`create schema "${schema}"`);
      db = postgres(url.toString(), {
        max: 1,
        onnotice: () => {},
        connection: { search_path: schema, application_name: appName },
      });
      await db.unsafe(
        await readFile(
          new URL(
            '../../database/migrations/0247_person_virtual_machines.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      store = new PostgresPersonVmStore(db);
    });
    afterEach(async () => {
      await db?.unsafe('truncate person_vm_audit, person_virtual_machines');
    });
    afterAll(async () => {
      await db?.end({ timeout: 2 });
      if (admin) {
        await admin.unsafe(`drop schema if exists "${schema}" cascade`);
        await admin.end({ timeout: 2 });
      }
    });
    async function terminateWorker() {
      const rows =
        await admin`select pid from pg_stat_activity where application_name=${appName}`;
      expect(rows).toHaveLength(1);
      const [killed] =
        await admin`select pg_terminate_backend(${rows[0]!.pid}) as killed`;
      expect(killed!.killed).toBe(true);
    }
    it('“进入员工页后可以输入”：入口落库本人唯一盘、精确binding、开停审计；返回不含ownerToken', async () => {
      const h = harness(store),
        rc = context();
      const first = await h.service.prewarm(rc, { trigger: 'page' }, signal());
      expect(
        (await h.service.prewarm(rc, { trigger: 'input' }, signal())).vmId,
      ).toBe(first.vmId);
      expect(first.ready).toBe(true);
      const [row] =
        await db`select * from person_virtual_machines where person_id=${rc.actor.id}`;
      expect(row!.phase).toBe('running');
      expect(row!.lease_owner).toBe(null);
      expect(Number(row!.lease_epoch)).toBe(1);
      const binding = await h.service.resolve(rc, signal());
      expect(row!.egress_receipt.binding).toEqual(binding);
      expect(JSON.stringify(first)).not.toMatch(
        /ownerToken|leaseOwner|bindingId|sparseimage/,
      );
      await h.service.stop(rc, signal());
      h.advance(PERSON_VM_COLD_MS + 1);
      expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('cold');
      expect((await h.service.start(rc, signal())).vmId).toBe(first.vmId);
      expect(h.log.filter((event) => event === 'native:create')).toHaveLength(
        1,
      );
      const audits =
        await db`select action,result from person_vm_audit order by id`;
      expect(audits).toEqual(
        expect.arrayContaining([
          { action: 'start', result: 'succeeded' },
          { action: 'stop', result: 'succeeded' },
          { action: 'cold', result: 'succeeded' },
        ]),
      );
    });
    it('两个worker并发争同一人，数据库lease拒绝第二次开停且不重复native create', async () => {
      // Each worker needs its own pool; max:1 on the same pool would queue before lock admission.
      const url = process.env.ALLRICE_TEST_DATABASE_URL!;
      const db2 = postgres(url, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: schema },
      });
      const first = harness(store),
        second = harness(new PostgresPersonVmStore(db2)),
        rc = context();
      await first.service.create(rc, signal());
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      first.runtime.start = async () => {
        entered();
        await gate;
      };
      const opening = first.service.start(rc, signal());
      try {
        await started;
        await expect(second.service.start(rc, signal())).rejects.toMatchObject({
          code: 'LEASE_CONFLICT',
        });
        await expect(second.service.stop(rc, signal())).rejects.toMatchObject({
          code: 'LEASE_CONFLICT',
        });
      } finally {
        release();
        await opening;
        await db2.end({ timeout: 2 });
      }
      expect(await db`select vm_id from person_virtual_machines`).toHaveLength(
        1,
      );
      expect(second.log).not.toContain('native:create');
    });
    it('普通非domain异常也释放租约，不把所有unknown Error永久当数据库断线', async () => {
      const h = harness(store),
        rc = context();
      await h.service.create(rc, signal());
      await expect(
        store.withLease(rc.actor.id, { now: h.now, ttlMs: 90000 }, async () => {
          throw new Error('synthetic ordinary provider error');
        }),
      ).rejects.toThrow('synthetic ordinary provider error');
      expect((await store.read(rc.actor.id))!.leaseOwner).toBe(null);
      expect((await h.service.start(rc, signal())).ready).toBe(true);
    });
    it('真实pg_terminate_backend后同进程settled fence恢复；新进程未知fence不能TTL偷租约', async () => {
      const h = harness(store),
        { rc, binding } = await running(h);
      await expect(
        store.withLease(
          rc.actor.id,
          { now: h.now, ttlMs: 90000 },
          async (lease) => {
            await terminateWorker();
            await lease.guard();
          },
        ),
      ).rejects.toBeDefined();
      const orphan = await store.read(rc.actor.id);
      expect(orphan!.leaseOwner).not.toBe(null);
      h.advance(90001);
      const unknown = new PostgresPersonVmStore(db);
      const unknownHost = harness(unknown);
      unknownHost.advance(90001);
      await expect(
        unknownHost.service.recoverExpired(rc, signal()),
      ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
      expect(unknownHost.log).not.toContain('egress:revoke');
      expect((await h.service.recoverExpired(rc, signal())).phase).toBe(
        'stopped',
      );
      expect((await store.read(rc.actor.id))!.leaseOwner).toBe(null);
      expect(h.states.get(binding.vmId)).toBe('stopped');
      expect(h.mounts.size).toBe(0);
      expect(h.active.size).toBe(0);
      expect((await h.service.start(rc, signal())).ready).toBe(true);
    });
    it('native create完成但host save的真实PG连接断开，恢复能认领已有原盘而不是永久false', async () => {
      const h = harness(store),
        rc = context();
      await h.service.create(rc, signal());
      h.native.create = async (binding) => {
        h.log.push('native:create');
        h.states.set(binding.vmId, 'running');
        await terminateWorker();
      };
      await expect(h.service.start(rc, signal())).rejects.toBeInstanceOf(
        PersonVmError,
      );
      const saved = await store.read(rc.actor.id);
      expect(saved!.leaseOwner).not.toBe(null);
      expect(saved!.nativeCreated).toBe(false);
      expect(h.states.get(saved!.vmId)).toBe('stopped');
      h.advance(90001);
      expect((await h.service.recoverExpired(rc, signal())).phase).toBe(
        'stopped',
      );
      expect((await store.read(rc.actor.id))!.nativeCreated).toBe(true);
      expect((await h.service.start(rc, signal())).ready).toBe(true);
      expect(h.log.filter((event) => event === 'native:create')).toHaveLength(
        1,
      );
      expect(h.log).toContain('native:start');
    });
    it('个人盘无employee级联关系；删盘拒绝及最终显式删除审计真正落库', async () => {
      const h = harness(store),
        { rc, binding } = await running(h);
      const constraints =
        await db`select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='person_virtual_machines'::regclass`;
      expect(constraints.map((row) => row.definition).join('\n')).not.toMatch(
        /employee|ON DELETE CASCADE/i,
      );
      await h.service.delete(rc, {}, signal());
      expect((await store.read(rc.actor.id))!.diskRetained).toBe(true);
      expect(h.disks.has(binding.vmId)).toBe(true);
      await expect(
        h.service.delete(rc, { deleteDisk: true }, signal()),
      ).rejects.toMatchObject({ code: 'DISK_DELETE_NOT_AUTHORIZED' });
      h.authorizeDiskDelete(true);
      await h.service.delete(rc, { deleteDisk: true }, signal());
      expect((await store.read(rc.actor.id))!.diskRetained).toBe(false);
      const rows =
        await db`select result,error_code from person_vm_audit where action='delete-disk' order by id`;
      expect(rows).toEqual(
        expect.arrayContaining([
          { result: 'denied', error_code: 'DISK_DELETE_NOT_AUTHORIZED' },
          { result: 'succeeded', error_code: null },
        ]),
      );
    });
  },
);
