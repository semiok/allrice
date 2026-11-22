import postgres from 'postgres';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertRuntimeFixtureDatabase } from '../../database/src/runtime-fixture-database.ts';
import { PostgresPersonVmStore } from './store.ts';
import { PersonVmError, PERSON_VM_COLD_MS } from './contract.ts';
import { context, harness, running, signal } from './test-support.ts';
import { ApfsPersonVmDisk, FilePersonVmKeyStore } from './encrypted-disk.ts';
import type { CommandRunner } from './process.ts';
import { PersonVmService } from './person-vm.ts';
import type { PersonVmStartingScope } from './guest-bootstrap.ts';

// Actual adapter and filesystem renames, with a synthetic hdiutil protocol.
// These bytes are NOT encrypted and no VM, mount, or hdiutil process is started.
async function syntheticDisk(beforeCreate?: (image: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ar-vm-pg-')));
  const attachments = new Map<string, string>();
  const payload = 'synthetic-container-' + randomUUID();
  const runner: CommandRunner = async ({ executable, args, input }) => {
    if (executable === '/usr/bin/plutil') return Buffer.from(input!).toString();
    if (args[0] === 'info')
      return JSON.stringify({
        images: [...attachments].map(([image, mount]) => ({
          'image-path': image,
          'system-entities': [{ 'mount-point': mount }],
        })),
      });
    if (args[0] === 'create') {
      await beforeCreate?.(args.at(-1)!);
      await writeFile(args.at(-1)!, payload);
    } else if (args[0] === 'imageinfo') {
      if ((await readFile(args[1]!, 'utf8')) !== payload)
        throw new Error('synthetic corrupt image');
    } else if (args[0] === 'attach')
      attachments.set(args[1]!, args[args.indexOf('-mountpoint') + 1]!);
    else if (args[0] === 'detach') {
      for (const [image, mount] of attachments)
        if (mount === args[1]) attachments.delete(image);
    } else throw new Error('unexpected hdiutil protocol');
    return '';
  };
  const volume = join(root, 'volume');
  const disk = new ApfsPersonVmDisk({
    root: volume,
    keys: new FilePersonVmKeyStore(join(root, 'keys')),
    capacityGiB: 40,
    runner,
  });
  return { root, volume, disk, attachments };
}

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'person VM real PostgreSQL storage through public lifecycle entrypoints (no VM/model)',
  () => {
    const schema = 'person_vm_' + randomUUID().replaceAll('-', '');
    const appName = 'person-vm-test-' + randomUUID();
    const workerClosures: Promise<void>[] = [];
    const workerNames: string[] = [];
    let workerQueries = 0;
    let admin: postgres.Sql, db: postgres.Sql, store: PostgresPersonVmStore;
    function openWorker() {
      let closed!: () => void;
      workerClosures.push(
        new Promise<void>((resolve) => {
          closed = resolve;
        }),
      );
      const name = appName + '-' + workerClosures.length;
      workerNames.push(name);
      return postgres(process.env.ALLRICE_TEST_DATABASE_URL!, {
        max: 1,
        onnotice: () => {},
        onclose: () => closed(),
        debug: () => {
          workerQueries += 1;
        },
        connection: { search_path: schema, application_name: name },
      });
    }
    beforeAll(async () => {
      const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
      assertRuntimeFixtureDatabase(url);
      admin = postgres(url.toString(), { max: 2, onnotice: () => {} });
      await admin.unsafe(`create schema "${schema}"`);
      db = postgres(url.toString(), {
        max: 1,
        onnotice: () => {},
        // Fixture inspection/teardown must not borrow a lifecycle-owned client.
        connection: { search_path: schema },
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
      store = new PostgresPersonVmStore(openWorker);
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
    async function terminateWorker(name = workerNames.at(-1)!) {
      const rows =
        await admin`select pid from pg_stat_activity where application_name=${name}`;
      expect(rows).toHaveLength(1);
      const [killed] =
        await admin`select pg_terminate_backend(${rows[0]!.pid}) as killed`;
      expect(killed!.killed).toBe(true);
    }
    it('starting scope使用实际PG owner guard：断线立即失效，bootstrap实际join前不释放/停机', async () => {
      const h = harness(store),
        rc = context();
      await h.service.create(rc, signal());
      let scope!: PersonVmStartingScope,
        entered!: () => void,
        release!: () => void,
        launched = false;
      const inside = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const joined = new Promise<void>((resolve) => {
        release = resolve;
      });
      h.native.bootstrap = async (current) => {
        scope = current;
        await scope.assertCurrent();
        entered();
        await joined;
        await scope.assertCurrent();
        throw new Error('unreachable after real owner loss');
      };
      h.runtime.start = async () => {
        launched = true;
      };
      const opening = h.service.start(rc, signal());
      const failure = expect(opening).rejects.toMatchObject({
        code: 'CLEANUP_INCOMPLETE',
      });
      try {
        await inside;
        const closed = workerClosures.at(-1)!;
        await terminateWorker();
        await closed;
        await expect(scope.assertCurrent()).rejects.toBe(scope.signal.reason);
        expect(scope.signal.reason).toMatchObject({
          code: 'CONNECTION_CLOSED',
        });
        expect(scope.signal.aborted).toBe(true);
        expect(h.log).not.toContain('native:stop');
        expect(h.mounts.size).toBe(1);
      } finally {
        release();
        await failure;
      }
      expect(launched).toBe(false);
      expect(h.log).toContain('native:stop');
      expect((await store.read(rc.actor.id))!.leaseOwner).not.toBe(null);
      await expect(scope.assertCurrent()).rejects.toMatchObject({
        code: 'LEASE_LOST',
      });
    });
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
      h.states.set(binding.vmId, 'stopped'); // Already off; ordinary running stop has no native gate yet.
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
      // Every operation owns a fresh session, so admission reaches the DB lock.
      const first = harness(store),
        second = harness(new PostgresPersonVmStore(openWorker)),
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
    it('普通真实SQL错误释放owner，不因SQL错误一概永久封死租约', async () => {
      const h = harness(store),
        rc = context();
      await h.service.create(rc, signal());
      await expect(
        store.withLease(
          rc.actor.id,
          { now: h.now, ttlMs: 90000 },
          async (lease) => {
            await lease.audit(lease.row!, {
              requestId: 'synthetic-invalid-uuid',
              action: 'synthetic',
              result: 'failed',
            });
          },
        ),
      ).rejects.toMatchObject({ code: '22P02' });
      expect((await store.read(rc.actor.id))!.leaseOwner).toBe(null);
      expect((await h.service.start(rc, signal())).ready).toBe(true);
    });
    it('两个真实独占连接：A断线不使B失效，B收尾后仍可重新领取', async () => {
      const a = harness(store),
        b = harness(store),
        rcA = context(),
        rcB = context();
      await a.service.create(rcA, signal());
      await b.service.create(rcB, signal());
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      b.runtime.start = async () => {
        entered();
        await gate;
      };
      const opening = b.service.start(rcB, signal());
      try {
        await started;
        await expect(
          store.withLease(
            rcA.actor.id,
            { now: a.now, ttlMs: 90000 },
            async (lease) => {
              await terminateWorker();
              await lease.guard();
            },
          ),
        ).rejects.toBeDefined();
      } finally {
        release();
        await opening;
      }
      expect((await store.read(rcB.actor.id))!.leaseOwner).toBe(null);
      await store.withLease(
        rcB.actor.id,
        { now: b.now, ttlMs: 90000 },
        async (lease) => {
          await lease.guard();
        },
      );
      expect((await b.service.resolve(rcB, signal())).personId).toBe(
        rcB.actor.id,
      );
      expect(b.log.filter((item) => item === 'native:create')).toHaveLength(1);
    });
    it('真实PG恢复活动探针重入同一lease；外部请求无权借恢复frame准入', async () => {
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
      h.advance(90001);
      let probed = false;
      h.runtime.activity = async (current) => {
        await h.service.assertCurrentBinding(rc, current, signal());
        const external = context(rc.organizationId, rc.actor.id);
        await expect(
          h.service.assertCurrentBinding(external, current, signal()),
        ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
        probed = true;
        return {
          binding: current,
          observedAt: h.now().toISOString(),
          state: 'known',
          activeTurns: 0,
          activeJobs: 0,
          activeSubtasks: 0,
          pendingApprovals: 0,
        };
      };
      // Reentry succeeds, but no VM-wide freeze exists; zero still cannot stop running work.
      await expect(
        h.service.recoverExpired(rc, signal()),
      ).rejects.toMatchObject({ code: 'ACTIVITY_UNKNOWN' });
      expect(probed).toBe(true);
      expect(h.log).not.toContain('native:stop');
      h.states.set(binding.vmId, 'stopped');
      h.advance(90001); // The in-frame guard renewed the old owner's recovery lease.
      expect((await h.service.recoverExpired(rc, signal())).phase).toBe(
        'stopped',
      );
      expect((await store.read(rc.actor.id))!.leaseOwner).toBe(null);
    });
    it.each(['query-race', 'closed-before-guard'] as const)(
      '真实pg_terminate_backend (%s) 后同进程settled fence恢复；新进程未知fence不能TTL偷租约',
      async (order) => {
        const h = harness(store),
          { rc, binding } = await running(h);
        await expect(
          store.withLease(
            rc.actor.id,
            { now: h.now, ttlMs: 90000 },
            async (lease) => {
              const closed = workerClosures.at(-1)!;
              await terminateWorker();
              if (order === 'closed-before-guard') await closed;
              let loss: unknown;
              try {
                await lease.guard();
              } catch (error) {
                loss = error;
              }
              expect(loss).toBeDefined();
              const issued = workerQueries;
              await expect(lease.guard()).rejects.toBe(loss);
              await expect(lease.save(lease.row!)).rejects.toBe(loss);
              await expect(
                lease.audit(lease.row!, {
                  requestId: rc.requestId,
                  action: 'synthetic',
                  result: 'failed',
                }),
              ).rejects.toBe(loss);
              expect(workerQueries).toBe(issued);
              throw loss;
            },
          ),
        ).rejects.toBeDefined();
        const orphan = await store.read(rc.actor.id);
        expect(orphan!.leaseOwner).not.toBe(null);
        h.advance(90001);
        const unknown = new PostgresPersonVmStore(openWorker);
        const unknownHost = harness(unknown);
        unknownHost.advance(90001);
        await expect(
          unknownHost.service.recoverExpired(rc, signal()),
        ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
        expect(unknownHost.log).not.toContain('egress:revoke');
        h.setActivity({ activeSubtasks: 1 });
        await expect(
          h.service.recoverExpired(rc, signal()),
        ).rejects.toMatchObject({ code: 'VM_ACTIVE' });
        expect(h.states.get(binding.vmId)).toBe('running');
        h.advance(90001); // A failed recovery owns its own renewed lease.
        h.setActivity({ activeSubtasks: 0 });
        await expect(
          h.service.recoverExpired(rc, signal()),
        ).rejects.toMatchObject({ code: 'ACTIVITY_UNKNOWN' });
        h.advance(90001);
        h.states.set(binding.vmId, 'stopped');
        expect((await h.service.recoverExpired(rc, signal())).phase).toBe(
          'stopped',
        );
        expect((await store.read(rc.actor.id))!.leaseOwner).toBe(null);
        expect(h.states.get(binding.vmId)).toBe('stopped');
        expect(h.mounts.size).toBe(0);
        expect(h.active.size).toBe(0);
        expect((await h.service.start(rc, signal())).ready).toBe(true);
      },
    );
    it('恢复A物理provider未settle时再次断PG，B不能沿用原owner证明清理或开机', async () => {
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
      const previous = (await store.read(rc.actor.id))!.leaseOwner!;
      h.states.set(binding.vmId, 'stopped');
      h.advance(90001);
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const revoke = h.egress.revoke;
      let block = true;
      h.egress.revoke = async (...args) => {
        if (block) {
          entered();
          await gate;
        }
        await revoke(...args);
      };
      const recoveringA = h.service.recoverExpired(rc, signal()).then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error }),
      );
      const fenceTokens: string[] = [];
      const storeB = new PostgresPersonVmStore(openWorker, {
        confirmSettled: async (owner) => {
          fenceTokens.push(owner.ownerToken);
          if (owner.ownerToken !== previous)
            throw new PersonVmError('LEASE_CONFLICT');
        },
      });
      const b = new PersonVmService({ ...h.options, store: storeB });
      let ownerA = '';
      try {
        await started;
        const nameA = workerNames.at(-1)!;
        const closedA = workerClosures.at(-1)!;
        ownerA = (await store.read(rc.actor.id))!.leaseOwner!;
        expect(ownerA).not.toBe(previous);
        await terminateWorker(nameA);
        await closedA;
        h.advance(90001); // Expiry alone must not certify still-running recovery A.
        const before = h.log.length;
        await expect(
          h.service.recoverExpired(rc, signal()),
        ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
        await expect(b.recoverExpired(rc, signal())).rejects.toMatchObject({
          code: 'LEASE_CONFLICT',
        });
        expect(fenceTokens).toEqual([ownerA]);
        await expect(b.start(rc, signal())).rejects.toMatchObject({
          code: 'LEASE_CONFLICT',
        });
        expect(
          h.log
            .slice(before)
            .filter((event) =>
              [
                'egress:revoke',
                'native:stop',
                'native:start',
                'native:create',
              ].includes(event),
            ),
        ).toEqual([]);
        expect((await store.read(rc.actor.id))!.leaseOwner).toBe(ownerA);
      } finally {
        block = false;
        release();
        await recoveringA;
      }
      expect((await recoveringA).ok).toBe(false);
      expect((await store.read(rc.actor.id))!.leaseOwner).toBe(ownerA);
      expect((await h.service.recoverExpired(rc, signal())).phase).toBe(
        'stopped',
      );
      expect((await store.read(rc.actor.id))!.leaseOwner).toBe(null);
      expect((await h.service.start(rc, signal())).ready).toBe(true);
      expect(h.log.filter((event) => event === 'native:create')).toHaveLength(
        1,
      );
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
      expect(h.mounts.size).toBe(0);
      expect(h.active.size).toBe(0);
      expect(h.log.indexOf('egress:revoke')).toBeLessThan(
        h.log.indexOf('native:stop'),
      );
      expect(h.log.indexOf('native:stop')).toBeLessThan(
        h.log.indexOf('disk:detach'),
      );
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
    it.each(['cold', 'warm'] as const)(
      '真实rename到%s后PG连接断开，恢复按完成凭据找回原盘字节',
      async (target) => {
        const fixture = await syntheticDisk();
        const h = harness(store),
          rc = context();
        for (const key of [
          'inspect',
          'create',
          'attach',
          'detach',
          'move',
          'delete',
        ] as const)
          Object.assign(h.disk, {
            [key]: fixture.disk[key].bind(fixture.disk),
          });
        try {
          const { binding } = await running(h, rc);
          const image = (tier: string) =>
            join(fixture.volume, tier, binding.vmId + '.sparseimage');
          const digest = (bytes: Buffer) =>
            createHash('sha256').update(bytes).digest('hex');
          const original = digest(await readFile(image('warm')));
          h.states.set(binding.vmId, 'stopped');
          await h.service.stop(rc, signal());
          h.advance(PERSON_VM_COLD_MS + 1);
          if (target === 'warm') await h.service.reconcileIdle(rc, signal());
          const move = h.disk.move;
          h.disk.move = async (...args) => {
            const actual = await move(...args);
            await terminateWorker();
            return actual;
          };
          await expect(
            target === 'cold'
              ? h.service.reconcileIdle(rc, signal())
              : h.service.start(rc, signal()),
          ).rejects.toBeDefined();
          expect(digest(await readFile(image(target)))).toBe(original);
          const stale = (await store.read(rc.actor.id))!;
          expect(stale.diskTier).toBe(target === 'cold' ? 'warm' : 'cold');
          expect(stale.leaseOwner).not.toBe(null);
          h.disk.move = move;
          h.advance(90001);
          await h.service.recoverExpired(rc, signal());
          expect((await store.read(rc.actor.id))!.diskTier).toBe(target);
          expect((await h.service.start(rc, signal())).ready).toBe(true);
          expect(digest(await readFile(image('warm')))).toBe(original);
          expect(h.log.filter((item) => item === 'native:create')).toHaveLength(
            1,
          );
        } finally {
          await rm(fixture.root, { recursive: true, force: true });
        }
      },
    );
    it('只create未start：rename后PG断线，无instance恢复实际cold位置并授权删除完整盘/key', async () => {
      const fixture = await syntheticDisk(),
        h = harness(store),
        rc = context();
      for (const key of [
        'inspect',
        'create',
        'attach',
        'detach',
        'move',
        'delete',
      ] as const)
        Object.assign(h.disk, { [key]: fixture.disk[key].bind(fixture.disk) });
      try {
        const created = await h.service.create(rc, signal());
        const warm = join(
          fixture.volume,
          'warm',
          created.vmId + '.sparseimage',
        );
        const cold = join(
          fixture.volume,
          'cold',
          created.vmId + '.sparseimage',
        );
        const original = await readFile(warm);
        const move = h.disk.move;
        h.disk.move = async (...args) => {
          const result = await move(...args);
          await terminateWorker();
          return result;
        };
        h.advance(PERSON_VM_COLD_MS + 1);
        await expect(
          h.service.reconcileIdle(rc, signal()),
        ).rejects.toBeDefined();
        const stale = (await store.read(rc.actor.id))!;
        expect(stale.instanceId).toBe(null);
        expect(stale.diskTier).toBe('warm');
        expect(await readFile(cold)).toEqual(original);
        h.disk.move = move;
        h.advance(90001);
        expect((await h.service.recoverExpired(rc, signal())).phase).toBe(
          'stopped',
        );
        expect((await store.read(rc.actor.id))!.diskTier).toBe('cold');
        expect(h.log).not.toContain('native:prepare');
        expect(h.log).not.toContain('native:stop');
        await expect(
          h.service.delete(rc, { deleteDisk: true }, signal()),
        ).rejects.toMatchObject({ code: 'DISK_DELETE_NOT_AUTHORIZED' });
        expect(await readFile(cold)).toEqual(original);
        h.authorizeDiskDelete(true);
        expect(
          (await h.service.delete(rc, { deleteDisk: true }, signal()))
            .diskRetained,
        ).toBe(false);
        for (const path of [
          warm,
          cold,
          join(fixture.volume, 'manifests', created.vmId + '.json'),
          join(fixture.root, 'keys', created.vmId + '.key'),
        ])
          await expect(readFile(path)).rejects.toMatchObject({
            code: 'ENOENT',
          });
        const [audit] =
          await db`select result from person_vm_audit where vm_id=${created.vmId} and action='delete-disk' order by id desc limit 1`;
        expect(audit!.result).toBe('succeeded');
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
    it.each(['absent', 'partial'] as const)(
      '首次建盘%s失败且保存failed时PG断线，无instance恢复不伪造stopped',
      async (kind) => {
        let fail = true;
        const fixture = await syntheticDisk(async (image) => {
          if (fail) {
            fail = false;
            if (kind === 'partial') await writeFile(image, 'partial-container');
            await terminateWorker();
            throw new Error('synthetic pre-completion create failure');
          }
        });
        const h = harness(store),
          rc = context();
        for (const key of [
          'inspect',
          'create',
          'attach',
          'detach',
          'move',
          'delete',
        ] as const)
          Object.assign(h.disk, {
            [key]: fixture.disk[key].bind(fixture.disk),
          });
        try {
          await expect(h.service.create(rc, signal())).rejects.toBeDefined();
          const row = (await store.read(rc.actor.id))!;
          expect(row.phase).toBe('starting');
          expect(row.instanceId).toBe(null);
          expect(row.nativeCreated).toBe(false);
          const keyPath = join(fixture.root, 'keys', row.vmId + '.key');
          const originalKey = createHash('sha256')
            .update(await readFile(keyPath))
            .digest('hex');
          h.advance(90001);
          if (kind === 'partial') {
            await expect(
              h.service.recoverExpired(rc, signal()),
            ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
            expect((await store.read(rc.actor.id))!.phase).toBe('starting');
            await expect(
              h.disk.delete({ vmId: row.vmId, tier: 'warm' }, signal()),
            ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
            expect(
              await readFile(
                join(fixture.volume, 'warm', row.vmId + '.sparseimage'),
                'utf8',
              ),
            ).toBe('partial-container');
          } else {
            const recovered = await h.service.recoverExpired(rc, signal());
            expect(recovered.phase).toBe('failed');
            expect(recovered.ready).toBe(false);
            expect((await store.read(rc.actor.id))!.leaseOwner).toBe(null);
            await expect(h.service.start(rc, signal())).rejects.toMatchObject({
              code: 'PROVIDER_FAILED',
            });
            expect((await store.read(rc.actor.id))!.instanceId).toBe(null);
            expect((await h.service.create(rc, signal())).vmId).toBe(row.vmId);
            expect(
              (await h.service.prewarm(rc, { trigger: 'page' }, signal()))
                .ready,
            ).toBe(true);
            expect(
              h.log.filter((event) => event === 'native:create'),
            ).toHaveLength(1);
          }
          expect(
            createHash('sha256')
              .update(await readFile(keyPath))
              .digest('hex'),
          ).toBe(originalKey);
        } finally {
          await rm(fixture.root, { recursive: true, force: true });
        }
      },
    );
    it('个人盘无employee级联关系；删盘拒绝及最终显式删除审计真正落库', async () => {
      const h = harness(store),
        { rc, binding } = await running(h);
      const constraints =
        await db`select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='person_virtual_machines'::regclass`;
      expect(constraints.map((row) => row.definition).join('\n')).not.toMatch(
        /employee|ON DELETE CASCADE/i,
      );
      h.states.set(binding.vmId, 'stopped');
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
