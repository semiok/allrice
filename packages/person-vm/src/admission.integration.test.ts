import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertRuntimeFixtureDatabase } from '../../database/src/runtime-fixture-database.ts';
import { PersonVmService } from './person-vm.ts';
import { PostgresPersonVmStore, type PersonVmSqlFactory } from './store.ts';
import { PERSON_VM_IDLE_MS } from './contract.ts';
import type { PersonVmAdmissionPermit } from './admission-boundary.ts';
import type { PersonVmAdmissionHost } from './admission-host.ts';
import { context, harness, running, signal } from './test-support.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'shared PG admission through actual PersonVmService composition; synthetic native, no VM/model',
  () => {
    const schema = 'vm_admit_' + randomUUID().replaceAll('-', '');
    const prefix = 'vm-admission-' + randomUUID();
    const clients = new Set<postgres.Sql>();
    const handles: [PersonVmAdmissionHost, PersonVmAdmissionPermit][] = [];
    const releases = new Set<() => void>();
    let admin: postgres.Sql, db: postgres.Sql;
    function latch() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      releases.add(resolve);
      return { promise, resolve };
    }
    function factory(role: string) {
      const names: string[] = [];
      const open: PersonVmSqlFactory = () => {
        const name = prefix + '-' + role + '-' + names.length;
        names.push(name);
        const sql = postgres(process.env.ALLRICE_TEST_DATABASE_URL!, {
          max: 1,
          onnotice: () => {},
          connection: { search_path: schema, application_name: name },
        });
        clients.add(sql);
        return sql;
      };
      return { open, names };
    }
    beforeAll(async () => {
      const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
      assertRuntimeFixtureDatabase(url);
      admin = postgres(url.toString(), { max: 2, onnotice: () => {} });
      await admin.unsafe(`create schema "${schema}"`);
      db = postgres(url.toString(), {
        max: 2,
        onnotice: () => {},
        connection: { search_path: schema },
      });
      for (const name of [
        '0247_person_virtual_machines.sql',
        '0250_person_vm_admission.sql',
      ])
        await db.unsafe(
          await readFile(
            new URL('../../database/migrations/' + name, import.meta.url),
            'utf8',
          ),
        );
    });
    afterEach(async () => {
      for (const release of releases) release();
      releases.clear();
      await Promise.allSettled(
        handles.splice(0).map(([host, permit]) => host.finish(permit)),
      );
      await Promise.all([...clients].map((sql) => sql.end({ timeout: 0 })));
      clients.clear();
      await db.unsafe(
        'drop trigger if exists fixture_block_delete on person_vm_admission_permits',
      );
      await db.unsafe('drop function if exists fixture_block_delete()');
      await db.unsafe(
        'truncate person_vm_admission_permits,person_vm_audit,person_virtual_machines',
      );
    });
    afterAll(async () => {
      await db?.end({ timeout: 2 });
      if (admin) {
        await admin.unsafe(`drop schema if exists "${schema}" cascade`);
        await admin.end({ timeout: 2 });
      }
    });
    async function setup(sharedFactory?: PersonVmSqlFactory) {
      const physical = factory('physicalA'),
        remote = factory('physicalB');
      const open = sharedFactory ?? physical.open;
      const store = new PostgresPersonVmStore(open);
      const h = harness(store),
        { rc, binding } = await running(h);
      let mono = 0;
      const host = h.service.createAdmissionHost({
        openSql: open,
        monotonic: () => mono,
      });
      const peerStore = new PostgresPersonVmStore(remote.open);
      const peerService = new PersonVmService({
        ...h.options,
        store: peerStore,
      });
      const peer = peerService.createAdmissionHost({
        openSql: remote.open,
        monotonic: () => mono,
      });
      return {
        ...h,
        host,
        peer,
        peerStore,
        peerService,
        rc,
        binding,
        physical,
        advanceMono: (ms: number) => {
          mono += ms;
          h.advance(ms);
        },
      };
    }
    async function permit(
      h: Awaited<ReturnType<typeof setup>>,
      participant: 'gateway' | 'entry',
      operationId = randomUUID(),
    ) {
      const value = await h.host.admit(
        h.rc,
        h.binding,
        { participant, operationId },
        signal(),
      );
      handles.push([h.host, value]);
      return value;
    }
    async function frozen(h: Awaited<ReturnType<typeof setup>>) {
      const lease = await h.host.issue(h.rc, h.binding, signal());
      await h.host.participant('gateway').freeze(lease, signal());
      await h.peer.participant('entry').freeze(lease, signal());
      return lease;
    }
    async function counts(personId: string) {
      return db`select disposition,count(*)::int as count from person_vm_admission_permits where person_id=${personId} group by disposition order by disposition`;
    }

    it('pre-freeze memory/8-slot wait stays queued; finish waits for actual cancel/join', async () => {
      const h = await setup(),
        item = await permit(h, 'gateway');
      const entered = latch(),
        release = latch();
      const waiting = h.host.queued(
        item,
        async (owned) => {
          entered.resolve();
          await release.promise;
          expect(owned.aborted).toBe(true);
        },
        signal(),
      );
      await entered.promise;
      const lease = await frozen(h);
      expect(
        await h.peer.participant('gateway').observe(h.binding, signal()),
      ).toMatchObject({ queued: 1, active: 0, deferred: 0 });
      const closing = h.host.finish(item);
      expect(h.host.finish(item)).toBe(closing);
      expect(item.signal.aborted).toBe(true);
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'queued', count: 1 },
      ]);
      await expect(
        h.host.stopFrozen(h.rc, lease, signal()),
      ).rejects.toBeDefined();
      expect(h.log).not.toContain('native:stop');
      release.resolve();
      await waiting;
      await closing;
      expect(await counts(h.rc.actor.id)).toEqual([]);
      await h.host.participant('gateway').thaw(lease, signal());
      await h.peer.participant('entry').thaw(lease, signal());
    });

    it('an accepted old queue can activate behind freeze; active remains until real transport/transaction join', async () => {
      const h = await setup(),
        item = await permit(h, 'gateway');
      const lease = await frozen(h),
        entered = latch(),
        release = latch();
      const transport = h.host.activate(
        item,
        async () => {
          entered.resolve();
          await release.promise;
          return 'actual-transport-closed';
        },
        signal(),
      );
      await entered.promise;
      expect(
        await h.peer.participant('gateway').observe(h.binding, signal()),
      ).toMatchObject({ active: 1, queued: 0 });
      const finish = h.host.finish(item);
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'active', count: 1 },
      ]);
      release.resolve();
      expect(await transport).toBe('actual-transport-closed');
      await finish;
      expect(await counts(h.rc.actor.id)).toEqual([]);
      await expect(
        h.host.activate(item, async () => 'forbidden', signal()),
      ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
      await h.host.participant('gateway').thaw(lease, signal());
      await h.peer.participant('entry').thaw(lease, signal());
    });

    it('two independent clients linearize ordinary admission against freeze, never lose a queue to deferred', async () => {
      const h = await setup(),
        lease = await h.host.issue(h.rc, h.binding, signal());
      const [item] = await Promise.all([
        h.host.admit(
          h.rc,
          h.binding,
          { participant: 'gateway', operationId: randomUUID() },
          signal(),
        ),
        h.peer.participant('gateway').freeze(lease, signal()),
      ]);
      handles.push([h.host, item]);
      const observed = await h.peer
        .participant('gateway')
        .observe(h.binding, signal());
      expect(observed.state).toBe('known');
      if (observed.state !== 'known') throw new Error('unexpected unknown');
      expect(observed.queued + observed.deferred).toBe(1);
      expect(
        item.disposition === 'queued' ? observed.queued : observed.deferred,
      ).toBe(1);
      await h.host.finish(item);
      await h.peer.participant('gateway').thaw(lease, signal());
      await h.host.participant('entry').thaw(lease, signal());
    });

    it('same-epoch thaw resumes deferred demand without a freeze error or VM restart', async () => {
      const h = await setup(),
        lease = await frozen(h),
        item = await permit(h, 'gateway');
      expect(item.disposition).toBe('deferred');
      const forbidden = async () => {
        throw new Error('must never dispatch deferred');
      };
      await expect(
        h.host.activate(item, forbidden, signal()),
      ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
      const ready = h.host.waitUntilReady(h.rc, item, signal());
      await h.host.participant('gateway').thaw(lease, signal());
      const [before] =
        await db`select lease_epoch from person_virtual_machines where person_id=${h.rc.actor.id}`;
      expect(Number(before!.lease_epoch)).toBe(h.binding.leaseEpoch);
      await h.peer.participant('entry').thaw(lease, signal());
      expect(await ready).toEqual(h.binding);
      expect(h.log.filter((value) => value === 'native:start')).toEqual([]);
      await h.host.finish(item);
      const fresh = await permit(h, 'gateway');
      expect(
        await h.host.activate(
          fresh,
          async () => 'same-epoch-dispatch',
          signal(),
        ),
      ).toBe('same-epoch-dispatch');
      await h.host.finish(fresh);
    });

    it('A1 blocks ALL public epoch-changing entrances after only one release; two wake callers share one ready generation', async () => {
      const h = await setup(),
        lease = await frozen(h),
        demand = await permit(h, 'entry');
      h.states.set(h.binding.vmId, 'stopped'); // Synthetic provider fact, not real VM acceptance.
      expect((await h.host.stopFrozen(h.rc, lease, signal())).phase).toBe(
        'stopped',
      );
      expect((await h.store.read(h.rc.actor.id))!.leaseOwner).toBe(null); // no nested public stop lock
      await h.host.participant('gateway').thaw(lease, signal());
      for (const operation of [
        () => h.service.start(h.rc, signal()),
        () => h.service.create(h.rc, signal()),
        () => h.service.prewarm(h.rc, { trigger: 'input' }, signal()),
        () => h.service.delete(h.rc, {}, signal()),
        () => h.service.recoverExpired(h.rc, signal()),
      ])
        await expect(operation()).rejects.toBeDefined();
      const wakeA = h.host.wake(h.rc, h.binding, signal()),
        wakeB = h.peer.wake(h.rc, h.binding, signal());
      expect(h.log.filter((value) => value === 'native:start')).toHaveLength(0);
      await h.peer.participant('entry').thaw(lease, signal());
      const [a, b] = await Promise.all([wakeA, wakeB]);
      expect(a).toEqual(b);
      expect(a.leaseEpoch).toBe(h.binding.leaseEpoch + 1);
      expect(h.log.filter((value) => value === 'native:start')).toHaveLength(1);
      expect(a.instanceId).not.toBe(h.binding.instanceId);
      await expect(
        h.host.activate(demand, async () => 'old-envelope', signal()),
      ).rejects.toBeDefined();
      await h.host.finish(demand);
      const next = await h.host.admit(
        h.rc,
        a,
        { participant: 'entry', operationId: randomUUID() },
        signal(),
      );
      handles.push([h.host, next]);
      expect(
        await h.host.activate(
          next,
          async () => 'newly-resolved-envelope-only',
          signal(),
        ),
      ).toBe('newly-resolved-envelope-only');
      await h.host.finish(next);
    });

    it('joined deferred cleanup still releases its exact permit after an authorized VM tombstone', async () => {
      const h = await setup(),
        lease = await frozen(h),
        pending = await permit(h, 'entry');
      h.states.set(h.binding.vmId, 'stopped');
      await h.host.stopFrozen(h.rc, lease, signal());
      await h.host.participant('gateway').thaw(lease, signal());
      await h.peer.participant('entry').thaw(lease, signal());
      expect((await h.service.delete(h.rc, {}, signal())).phase).toBe(
        'deleted',
      );
      await h.host.finish(pending);
      expect(await counts(h.rc.actor.id)).toEqual([]);
      expect(h.disks.has(h.binding.vmId)).toBe(true);
      await expect(
        h.peer.admit(
          h.rc,
          h.binding,
          { participant: 'entry', operationId: randomUUID() },
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('partial ACK cannot stop; subscription close does not release; stale thaw cannot open the next freeze', async () => {
      const h = await setup(),
        lease = await h.host.issue(h.rc, h.binding, signal());
      await h.host.participant('gateway').freeze(lease, signal());
      const subscription = await h.peer
        .participant('gateway')
        .subscribe(h.binding, signal());
      const closing = subscription.close();
      expect(subscription.close()).toBe(closing);
      await closing;
      expect(
        (await h.peer.participant('gateway').observe(h.binding, signal()))
          .state,
      ).toBe('known');
      h.states.set(h.binding.vmId, 'stopped');
      await expect(
        h.host.stopFrozen(h.rc, lease, signal()),
      ).rejects.toMatchObject({ code: 'LEASE_LOST' });
      expect(h.log).not.toContain('native:stop');
      await h.host.participant('gateway').thaw(lease, signal());
      await h.peer.participant('entry').thaw(lease, signal());
      const next = await h.host.issue(h.rc, h.binding, signal());
      await h.host.participant('gateway').freeze(next, signal());
      expect(await h.peer.participant('gateway').thaw(lease, signal())).toBe(
        'superseded',
      );
      expect(
        await h.peer.participant('gateway').observe(h.binding, signal()),
      ).toMatchObject({ frozen: next });
      await h.host.participant('gateway').thaw(next, signal());
      await h.peer.participant('entry').thaw(next, signal());
    });

    it('latched subscribe/read/wait sees a whole short start/end even when both counts are zero', async () => {
      const h = await setup(),
        participant = h.peer.participant('gateway');
      const subscription = await participant.subscribe(h.binding, signal());
      try {
        const before = await participant.observe(h.binding, signal());
        h.advanceMono(18 * 60_000);
        const item = await permit(h, 'gateway');
        await h.host.finish(item);
        h.advanceMono(2 * 60_000);
        await subscription.wait(before.coverage.cursor, signal());
        const after = await participant.observe(h.binding, signal());
        expect(after).toMatchObject({ state: 'known', active: 0, queued: 0 });
        expect(after.coverage.cursor).not.toEqual(before.coverage.cursor);
        if (after.coverage.state !== 'continuous')
          throw new Error('unexpected gap');
        expect(after.coverage.from).toBe(h.now().toISOString());
        expect(after.coverage.idleSince).toBe(after.coverage.from); // First new idle proof, not 20min old.
      } finally {
        await subscription.close();
      }
    });

    it('unknown native producer never gains automatic stop permission from PG/fixture zero or wall-clock time', async () => {
      const h = await setup();
      await h.service.reconcileIdle(h.rc, signal());
      h.advanceMono(7 * 24 * 60 * 60_000);
      expect((await h.service.reconcileIdle(h.rc, signal())).phase).toBe(
        'running',
      );
      const lease = await frozen(h);
      await expect(
        h.host.stopFrozen(h.rc, lease, signal()),
      ).rejects.toMatchObject({ code: 'ACTIVITY_UNKNOWN' });
      expect(h.states.get(h.binding.vmId)).toBe('running');
      expect(h.log).not.toContain('native:stop');
      // No physical stop was committed. Explicit operator reconciliation releases the exact round.
      await h.host.participant('gateway').thaw(lease, signal());
      await h.peer.participant('entry').thaw(lease, signal());
      expect(PERSON_VM_IDLE_MS).toBe(20 * 60_000); // Time above is a fixture, not a real wait.
    });

    it('foreign copied handles and wrong tenant authority cannot activate or finish someone else’s permit', async () => {
      const h = await setup(),
        item = await permit(h, 'gateway');
      await expect(
        h.peer.activate(item, async () => 'forbidden', signal()),
      ).rejects.toMatchObject({ code: 'LEASE_LOST' });
      expect(() => h.peer.finish(item)).toThrowError('LEASE_LOST');
      const other = context(randomUUID(), h.rc.actor.id);
      await expect(
        h.host.admit(
          other,
          h.binding,
          { participant: 'entry', operationId: randomUUID() },
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
      await h.host.finish(item);
      expect(await counts(h.rc.actor.id)).toEqual([]);
    });

    it('owner PG loss aborts but cannot release the physical fence before blocked provider settlement; explicit recovery uses a new owner', async () => {
      const h = await setup(),
        lease = await frozen(h),
        entered = latch(),
        release = latch();
      h.states.set(h.binding.vmId, 'stopped');
      const originalStop = h.native.stop,
        originalStatus = h.native.status;
      let ownerSignal: AbortSignal | undefined;
      h.native.status = async (binding, owned) => {
        ownerSignal ??= owned;
        return originalStatus(binding, owned);
      };
      h.native.stop = async (binding, owned) => {
        entered.resolve();
        await release.promise;
        await originalStop(binding, owned);
      };
      const stop = h.host.stopFrozen(h.rc, lease, signal());
      const outcome = stop.catch((error: unknown) => error);
      try {
        await entered.promise;
        const [claimed] =
          await db`select lease_owner from person_virtual_machines where person_id=${h.rc.actor.id}`;
        const oldOwner = claimed!.lease_owner;
        const owners =
          await admin`select a.pid from pg_stat_activity a join pg_locks l on a.pid=l.pid
        where a.application_name like ${prefix + '-physicalA-%'} and l.locktype='advisory' and l.granted`;
        expect(owners).toHaveLength(1);
        await admin`select pg_terminate_backend(${owners[0]!.pid})`;
        await expect.poll(() => ownerSignal?.aborted).toBe(true);
        h.advanceMono(90001); // Expiry fixture never fences the pending callback.
        await expect(
          h.peerStore.withLease(
            h.rc.actor.id,
            { now: h.now, ttlMs: 90000 },
            async () => {
              throw new Error('foreign physical callback must never run');
            },
          ),
        ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
        await expect(
          h.peer.recoverStop(h.rc, lease, signal()),
        ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
        await expect(
          h.host.participant('gateway').thaw(lease, signal()),
        ).rejects.toBeDefined();
        const [stillOwned] =
          await db`select lease_owner,admission_state from person_virtual_machines where person_id=${h.rc.actor.id}`;
        expect(stillOwned!.lease_owner).toBe(oldOwner);
        expect(stillOwned!.admission_state.round.stop).toBe('pending');
        release.resolve();
        await outcome;
        h.native.stop = originalStop;
        expect((await h.host.recoverStop(h.rc, lease, signal())).phase).toBe(
          'stopped',
        );
        const [recovered] =
          await db`select lease_owner,admission_state from person_virtual_machines where person_id=${h.rc.actor.id}`;
        expect(recovered!.lease_owner).toBe(null);
        expect(recovered!.admission_state.round.stop).toBe('confirmed');
        await h.host.participant('gateway').thaw(lease, signal());
        await h.peer.participant('entry').thaw(lease, signal());
        expect((await h.host.wake(h.rc, h.binding, signal())).leaseEpoch).toBe(
          h.binding.leaseEpoch + 1,
        );
      } finally {
        release.resolve();
        await outcome;
        h.native.stop = originalStop;
        h.native.status = originalStatus;
      }
    });

    it('revoke failure still attempts stop; unknown physical cleanup cannot thaw or wake', async () => {
      const h = await setup(),
        lease = await frozen(h);
      h.states.set(h.binding.vmId, 'stopped');
      h.egress.revoke = async () => {
        h.log.push('synthetic-revoke-failure');
        throw new Error('synthetic revoke failure');
      };
      await expect(
        h.host.stopFrozen(h.rc, lease, signal()),
      ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
      expect(h.log).toContain('native:stop');
      expect(h.states.get(h.binding.vmId)).toBe('stopped');
      await expect(
        h.peer.participant('entry').thaw(lease, signal()),
      ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
      const caller = new AbortController();
      const wake = h.host.wake(h.rc, h.binding, caller.signal);
      const joined = wake.catch((error: unknown) => error);
      caller.abort(
        new Error('client cancelled while unknown cleanup remains closed'),
      );
      await joined;
      expect(h.log.filter((value) => value === 'native:start')).toHaveLength(0);
      const [row] =
        await db`select admission_state from person_virtual_machines where person_id=${h.rc.actor.id}`;
      expect(row!.admission_state.round.stop).toBe('unknown');
    });

    it('failed finish write retains an actually joined permit, with explicit same-owner recovery rather than zeroing or TTL steal', async () => {
      const h = await setup(),
        item = await permit(h, 'gateway');
      expect(await h.host.activate(item, async () => 42, signal())).toBe(42);
      const blocking = factory('blocker').open(),
        held = latch(),
        release = latch();
      const key = 817523;
      const owner = blocking.begin(async (sql) => {
        await sql`select pg_advisory_xact_lock(${key})`;
        held.resolve();
        await release.promise;
      });
      await held.promise;
      await db.unsafe(
        `create function fixture_block_delete() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(${key}); return old; end; $$`,
      );
      await db.unsafe(
        'create trigger fixture_block_delete before delete on person_vm_admission_permits for each row execute function fixture_block_delete()',
      );
      const finish = h.host.finish(item),
        outcome = finish.catch((error: unknown) => error);
      try {
        const pending = () =>
          admin`select pid from pg_stat_activity where application_name like ${prefix + '-physicalA-%'} and wait_event='advisory'`;
        await expect.poll(async () => (await pending()).length).toBe(1);
        const [backend] = await pending();
        await admin`select pg_terminate_backend(${backend!.pid})`;
        expect(await outcome).toBeInstanceOf(Error);
        expect(h.host.finish(item)).toBe(finish);
        expect(await counts(h.rc.actor.id)).toEqual([
          { disposition: 'active', count: 1 },
        ]);
        await expect(
          h.peer.recoverPermit(item, signal()),
        ).rejects.toMatchObject({ code: 'LEASE_LOST' });
        await db.unsafe(
          'drop trigger fixture_block_delete on person_vm_admission_permits',
        );
        release.resolve();
        await owner;
        await h.host.recoverPermit(item, signal());
        expect(await counts(h.rc.actor.id)).toEqual([]);
      } finally {
        release.resolve();
        await owner;
        await outcome;
        await blocking.end({ timeout: 0 });
      }
    });

    it('lost admit ACK after a REAL PG commit has no callback; only its settled local issuer can retry that exact operation', async () => {
      const source = factory('lost-ack');
      let armed = false;
      const open: PersonVmSqlFactory = () => {
        const sql = source.open(),
          begin = sql.begin.bind(sql);
        sql.begin = ((...args: Parameters<typeof sql.begin>) =>
          begin(...args).then((value) => {
            if (armed) {
              armed = false;
              throw Object.assign(
                new Error('synthetic response lost AFTER actual COMMIT'),
                { code: 'ECONNRESET' },
              );
            }
            return value;
          })) as typeof sql.begin;
        return sql;
      };
      const h = await setup(open),
        operationId = randomUUID();
      // Initialize the durable projection before injecting the response failure.
      await h.host.participant('gateway').observe(h.binding, signal());
      armed = true;
      await expect(
        h.host.admit(
          h.rc,
          h.binding,
          { participant: 'gateway', operationId },
          signal(),
        ),
      ).rejects.toBeDefined();
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'queued', count: 1 },
      ]);
      await expect(
        h.peer.admit(
          h.rc,
          h.binding,
          { participant: 'gateway', operationId },
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
      const retry = await h.host.admit(
        h.rc,
        h.binding,
        { participant: 'gateway', operationId },
        signal(),
      );
      handles.push([h.host, retry]);
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'queued', count: 1 },
      ]);
      expect(
        await h.host.activate(
          retry,
          async () => 'only-returned-handle-runs',
          signal(),
        ),
      ).toBe('only-returned-handle-runs');
      await h.host.finish(retry);
      expect(await counts(h.rc.actor.id)).toEqual([]);
    });

    it('epoch/revocation invalidation cancels a tracked transport but finish still joins it before releasing durable activity', async () => {
      const h = await setup(),
        item = await permit(h, 'gateway'),
        entered = latch(),
        release = latch();
      let ownedSignal: AbortSignal | undefined;
      const active = h.host.activate(
        item,
        async (owned) => {
          ownedSignal = owned;
          entered.resolve();
          await release.promise;
        },
        signal(),
      );
      await entered.promise;
      // Simulate a trusted future revocation producer; no organization API is implemented here.
      await db`update person_virtual_machines set admission_version=${randomUUID()},
      admission_state=jsonb_set(admission_state,'{revoked}',${db.json('fixture-canonical-source')}::jsonb)
      where person_id=${h.rc.actor.id}`;
      await expect.poll(() => ownedSignal?.aborted).toBe(true);
      const finish = h.host.finish(item);
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'active', count: 1 },
      ]);
      release.resolve();
      await active;
      await finish;
      await expect(h.service.start(h.rc, signal())).rejects.toMatchObject({
        code: 'LEASE_CONFLICT',
      });
      await expect(
        h.peer.admit(
          h.rc,
          h.binding,
          { participant: 'entry', operationId: randomUUID() },
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    });

    it('the actual public start owner aborts on shared revocation; a late provider start cannot revive the VM', async () => {
      const h = await setup();
      h.states.set(h.binding.vmId, 'stopped');
      await h.service.stop(h.rc, signal());
      const entered = latch(),
        release = latch(),
        original = h.native.start;
      let ownerSignal: AbortSignal | undefined;
      const runtimeStarts = h.log.filter(
        (item) => item === 'runtime:start',
      ).length;
      h.native.start = async (binding, owned) => {
        ownerSignal = owned;
        entered.resolve();
        await release.promise;
        await original(binding, signal()); // Intentionally ignore abort to model late external completion.
      };
      const start = h.service.start(h.rc, signal()),
        outcome = start.catch((error: unknown) => error);
      try {
        await entered.promise;
        await db`update person_virtual_machines set admission_version=${randomUUID()},
        admission_state=jsonb_set(admission_state,'{revoked}',${db.json('fixture-canonical-disable')}::jsonb)
        where person_id=${h.rc.actor.id}`;
        await expect.poll(() => ownerSignal?.aborted).toBe(true);
        release.resolve();
        expect(await outcome).toBeInstanceOf(Error);
        expect(h.states.get(h.binding.vmId)).toBe('stopped');
        expect(h.log.filter((item) => item === 'runtime:start')).toHaveLength(
          runtimeStarts,
        );
        expect(h.disks.has(h.binding.vmId)).toBe(true);
        expect(h.log).not.toContain('disk:delete');
        await expect(
          h.peerService.prewarm(h.rc, { trigger: 'page' }, signal()),
        ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
      } finally {
        release.resolve();
        await outcome;
        h.native.start = original;
      }
    });

    it('phase-independent assertLease/read assertions can reenter an owned final callback; a nested same-person mutation cannot', async () => {
      const h = await setup(),
        lease = await frozen(h);
      await db`update person_virtual_machines set phase='starting' where person_id=${h.rc.actor.id}`;
      await h.host.withLease(
        lease,
        async (owned) => {
          await h.host.assertLease(lease, owned);
          await h.peer.participant('gateway').assertFrozen(lease, owned);
          await h.peer.participant('entry').assertFrozen(lease, owned);
          await expect(
            h.host.withLease(
              lease,
              async () => {
                throw new Error('must not enter');
              },
              owned,
            ),
          ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
        },
        signal(),
      );
      await db`update person_virtual_machines set phase='running' where person_id=${h.rc.actor.id}`;
      await h.host.participant('gateway').thaw(lease, signal());
      await h.peer.participant('entry').thaw(lease, signal());
    });

    it('wake never returns an unauthenticated/401-like readiness fixture as ready', async () => {
      const h = await setup(),
        lease = await frozen(h);
      h.states.set(h.binding.vmId, 'stopped');
      await h.host.stopFrozen(h.rc, lease, signal());
      await h.host.participant('gateway').thaw(lease, signal());
      await h.peer.participant('entry').thaw(lease, signal());
      h.setReadiness({
        authenticated: false,
        editorReady: false,
        canSend: false,
      });
      await expect(
        h.host.wake(h.rc, h.binding, signal()),
      ).rejects.toMatchObject({ code: 'RUNTIME_NOT_READY' });
      expect(h.states.get(h.binding.vmId)).toBe('stopped');
    });

    it('a pending deferred request retains its exact old release receipt across another same-binding freeze and a later generation', async () => {
      const h = await setup(),
        first = await frozen(h),
        pending = await permit(h, 'gateway');
      await h.host.participant('gateway').thaw(first, signal());
      await h.peer.participant('entry').thaw(first, signal());
      const second = await frozen(h);
      h.states.set(h.binding.vmId, 'stopped');
      await h.host.stopFrozen(h.rc, second, signal());
      await h.host.participant('gateway').thaw(second, signal());
      await h.peer.participant('entry').thaw(second, signal());
      const ready = await h.host.wake(h.rc, h.binding, signal());
      expect(await h.host.waitUntilReady(h.rc, pending, signal())).toEqual(
        ready,
      );
      await h.host.finish(pending);
      expect(
        (await h.host.participant('gateway').observe(ready, signal())).state,
      ).toBe('known');
    });
  },
);
