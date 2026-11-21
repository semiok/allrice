import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { assertRuntimeFixtureDatabase } from '../../database/src/runtime-fixture-database.ts';
import { PersonVmService } from './person-vm.ts';
import { PostgresPersonVmStore, type PersonVmSqlFactory } from './store.ts';
import { PERSON_VM_IDLE_MS } from './contract.ts';
import type { PersonVmAdmissionPermit } from './admission-boundary.ts';
import {
  advanceIdleCandidate,
  type PersonVmAdmissionHost,
} from './admission-host.ts';
import type { AdmissionState } from './admission-store.ts';
import type { PersonVmIdleCoverage } from './admission-contract.ts';
import { context, harness, running } from './test-support.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'shared PG admission through actual PersonVmService composition; synthetic native, no VM/model',
  () => {
    const schema = 'vm_admit_' + randomUUID().replaceAll('-', '');
    const prefix = 'vma-' + randomUUID(); // Keep exact PG application_name under 63 bytes, including role/counter.
    const clients = new Set<postgres.Sql>();
    const handles: [PersonVmAdmissionHost, PersonVmAdmissionPermit][] = [];
    const releases = new Set<() => void>();
    const work = new Set<Promise<unknown>>();
    let caller = new AbortController();
    const signal = () => caller.signal;
    function own<T>(promise: Promise<T>) {
      work.add(promise);
      void promise.finally(() => work.delete(promise)).catch(() => {});
      return promise;
    }
    let admin: postgres.Sql, db: postgres.Sql;
    function latch() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      releases.add(resolve);
      return { promise, resolve };
    }
    function factory(
      role: string,
      afterCommit?: (name: string) => Promise<void>,
      afterClose?: (name: string) => void,
      unlistenFailure?: Error,
    ) {
      const names: string[] = [];
      const events: string[] = [];
      const open: PersonVmSqlFactory = () => {
        const name = prefix + '-' + role + '-' + names.length;
        names.push(name);
        const sql = postgres(process.env.ALLRICE_TEST_DATABASE_URL!, {
          max: 1,
          onnotice: () => {},
          onclose: () => {
            events.push(name + ':close');
            afterClose?.(name);
          },
          debug: (_id, query) => {
            events.push(
              name + ':' + query.trim().split(/\s/)[0]!.toLowerCase(),
            );
          },
          connection: { search_path: schema, application_name: name },
        });
        const end = sql.end.bind(sql);
        sql.end = (options) => {
          events.push(name + ':end');
          return end(options);
        };
        if (afterCommit) {
          const unsafe = sql.unsafe.bind(sql);
          sql.unsafe = ((text, ...args) => {
            const query = unsafe(text, ...args);
            return text === 'commit'
              ? query.then(async (rows) => {
                  await afterCommit(name);
                  return rows;
                })
              : query;
          }) as typeof sql.unsafe;
        }
        if (unlistenFailure) {
          const listen = sql.listen.bind(sql);
          sql.listen = ((...args: Parameters<typeof sql.listen>) =>
            listen(...args).then((metadata) => ({
              ...metadata,
              unlisten: async () => {
                await metadata.unlisten();
                throw unlistenFailure;
              },
            }))) as typeof sql.listen;
        }
        clients.add(sql);
        return sql;
      };
      return { open, names, events };
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
    beforeEach(() => {
      caller = new AbortController();
    });
    afterEach(async () => {
      caller.abort(new Error('test owner finally cancel/join'));
      for (const release of releases) release();
      releases.clear();
      await Promise.allSettled(
        handles.splice(0).map(([host, permit]) => host.finish(permit)),
      );
      await Promise.allSettled([...work]);
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
        advanceMono: (ms: number, advanceUtc = true) => {
          mono += ms;
          if (advanceUtc) h.advance(ms);
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
    async function idleInputs(
      h: Awaited<ReturnType<typeof setup>>,
      mono: number,
    ) {
      const g = await h.host
        .participant('gateway')
        .observe(h.binding, signal());
      const e = await h.host.participant('entry').observe(h.binding, signal());
      const [record] =
        await db`select admission_state from person_virtual_machines where person_id=${h.rc.actor.id}`;
      const state = record!.admission_state as AdmissionState;
      const origin = '2026-11-21T10:00:00.000Z';
      // Only native coverage is synthetic. Accepted stamps/counts above are actual PG facts.
      const coverage: PersonVmIdleCoverage[] = [
        g.coverage,
        e.coverage,
        {
          state: 'continuous',
          cursor: { sourceId: 'synthetic-native', revision: '0' },
          from: origin,
          through: new Date(Date.parse(origin) + mono).toISOString(),
          idleSince: origin,
        },
      ];
      return [
        h.binding,
        coverage,
        [state.gateway.idleRevision, state.entry.idleRevision, '0'],
        await h.store.read(h.rc.actor.id),
        mono,
      ] as const;
    }
    async function settledOrphan(h: Awaited<ReturnType<typeof setup>>) {
      const entered = latch(),
        release = latch(),
        lost = latch();
      const owned = own(
        h.store.withLease(
          h.rc.actor.id,
          { now: h.now, ttlMs: 90000 },
          async (lease) => {
            lease.signal.addEventListener('abort', lost.resolve, {
              once: true,
            });
            entered.resolve();
            await release.promise;
            await lease.guard();
          },
        ),
      );
      const outcome = owned.catch((error: unknown) => error);
      try {
        await entered.promise;
        const owners =
          await admin`select a.pid from pg_stat_activity a join pg_locks l on a.pid=l.pid
          where a.application_name like ${prefix + '-physicalA-%'} and l.locktype='advisory' and l.granted`;
        expect(owners).toHaveLength(1);
        await admin`select pg_terminate_backend(${owners[0]!.pid})`;
        await lost.promise;
        release.resolve();
        expect(await outcome).toBeInstanceOf(Error);
        h.advanceMono(90001); // Expiry fixture; actual callback has also joined.
      } finally {
        release.resolve();
        await outcome;
      }
    }

    it('pre-freeze memory/8-slot wait stays queued; finish waits for actual cancel/join', async () => {
      const h = await setup(),
        item = await permit(h, 'gateway');
      const entered = latch(),
        release = latch();
      const waiting = own(
        h.host.queued(
          item,
          async (owned) => {
            entered.resolve();
            await release.promise;
            expect(owned.aborted).toBe(true);
          },
          signal(),
        ),
      );
      await entered.promise;
      const lease = await frozen(h);
      expect(
        await h.peer.participant('gateway').observe(h.binding, signal()),
      ).toMatchObject({ queued: 1, active: 0, deferred: 0 });
      const closing = own(h.host.finish(item));
      expect(h.host.finish(item)).toBe(closing);
      expect(item.signal.aborted).toBe(true);
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'queued', count: 1 },
      ]);
      h.states.set(h.binding.vmId, 'stopped');
      await expect(
        h.host.stopFrozen(h.rc, lease, signal()),
      ).rejects.toMatchObject({ code: 'VM_ACTIVE' });
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
      const transport = own(
        h.host.activate(
          item,
          async () => {
            entered.resolve();
            await release.promise;
            return 'actual-transport-closed';
          },
          signal(),
        ),
      );
      await entered.promise;
      expect(
        await h.peer.participant('gateway').observe(h.binding, signal()),
      ).toMatchObject({ active: 1, queued: 0 });
      const finish = own(h.host.finish(item));
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
      await h.host.participant('gateway').thaw(lease, signal());
      const ready = own(h.host.waitUntilReady(h.rc, item, signal()));
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

    it.each(['gateway', 'entry'] as const)(
      'a %s subscriber latches the peer release even before wait registration',
      async (first) => {
        const h = await setup(),
          lease = await frozen(h),
          participant = h.host.participant(first);
        await participant.thaw(lease, signal());
        const subscription = await participant.subscribe(h.binding, signal());
        try {
          const before = await participant.observe(h.binding, signal());
          await h.peer
            .participant(first === 'gateway' ? 'entry' : 'gateway')
            .thaw(lease, signal());
          await subscription.wait(before.coverage.cursor, signal());
          expect(
            (await participant.observe(h.binding, signal())).coverage.cursor,
          ).not.toEqual(before.coverage.cursor);
        } finally {
          await subscription.close();
        }
      },
    );

    it('release after the exact predicate snapshot but before wait registration is not consumed as its baseline', async () => {
      const snapshot = latch(),
        release = latch();
      let armed = false,
        commits = 0;
      const source = factory('predicate-snapshot', async () => {
        // subscribe's initial read, then the exact predicate+cursor transaction.
        if (armed && ++commits === 2) {
          snapshot.resolve();
          await release.promise;
        }
      });
      const h = await setup(source.open),
        lease = await frozen(h),
        item = await permit(h, 'gateway');
      await h.host.participant('gateway').thaw(lease, signal());
      armed = true;
      const ready = own(h.host.waitUntilReady(h.rc, item, signal()));
      try {
        expect(
          await Promise.race([snapshot.promise, ready.then(() => 'premature')]),
        ).toBeUndefined();
        await h.peer.participant('entry').thaw(lease, signal());
        release.resolve();
        expect(await ready).toEqual(h.binding);
      } finally {
        release.resolve();
      }
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
      const wakeA = own(h.host.wake(h.rc, h.binding, signal())),
        wakeB = own(h.peer.wake(h.rc, h.binding, signal()));
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
      const closing = own(subscription.close());
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

    it('issue, peer freeze ACK and demand wake subscribers without resetting the accepted idle candidate', async () => {
      const h = await setup(),
        participant = h.peer.participant('gateway');
      const subscription = await participant.subscribe(h.binding, signal());
      const candidate = advanceIdleCandidate(
        undefined,
        ...(await idleInputs(h, 0)),
      );
      const cancel = new AbortController(),
        reason = new Error('join synthetic demand');
      let mono = 0,
        demand: Promise<unknown> | undefined;
      async function unchanged<T>(operation: () => Promise<T>) {
        const before = await participant.observe(h.binding, signal());
        const result = await operation();
        await subscription.wait(before.coverage.cursor, signal());
        expect(
          (await participant.observe(h.binding, signal())).coverage.cursor,
        ).not.toEqual(before.coverage.cursor);
        mono += 5 * 60_000;
        h.advanceMono(5 * 60_000, false);
        expect(
          advanceIdleCandidate(candidate, ...(await idleInputs(h, mono))),
        ).toEqual(candidate);
        return result;
      }
      try {
        const lease = await unchanged(() =>
          h.host.issue(h.rc, h.binding, signal()),
        );
        await unchanged(() =>
          h.peer.participant('entry').freeze(lease, signal()),
        );
        await unchanged(async () => {
          demand = own(
            h.host.wake(
              h.rc,
              h.binding,
              AbortSignal.any([signal(), cancel.signal]),
            ),
          ).catch((error: unknown) => error);
        });
        h.advanceMono(5 * 60_000, false);
        expect(
          advanceIdleCandidate(
            candidate,
            ...(await idleInputs(h, PERSON_VM_IDLE_MS)),
          )?.mono,
        ).toBe(0);
        expect(h.log).not.toContain('native:stop');
        cancel.abort(reason);
        expect(await demand).toBe(reason);
        await h.host.participant('gateway').thaw(lease, signal());
        await h.peer.participant('entry').thaw(lease, signal());
      } finally {
        cancel.abort(reason);
        await demand;
        await subscription.close();
      }
    });

    it.each(['gateway', 'entry'] as const)(
      'a short accepted %s start/end resets idle even at the same UTC millisecond',
      async (participant) => {
        const h = await setup(),
          before = await idleInputs(h, 0);
        const candidate = advanceIdleCandidate(undefined, ...before);
        h.advanceMono(18 * 60_000, false);
        const item = await permit(h, participant);
        await h.host.activate(
          item,
          async () => 'actual callback joined',
          signal(),
        );
        await h.host.finish(item);
        const after = await idleInputs(h, 18 * 60_000);
        expect(
          after[1].map(
            (coverage) => coverage.state === 'continuous' && coverage.idleSince,
          ),
        ).toEqual(
          before[1].map(
            (coverage) => coverage.state === 'continuous' && coverage.idleSince,
          ),
        );
        expect(after[2]).not.toEqual(before[2]);
        const reset = advanceIdleCandidate(candidate, ...after);
        expect(reset?.mono).toBe(18 * 60_000);
        h.advanceMono(2 * 60_000, false);
        expect(
          advanceIdleCandidate(
            reset,
            ...(await idleInputs(h, PERSON_VM_IDLE_MS)),
          )?.mono,
        ).toBe(18 * 60_000);
        expect(await counts(h.rc.actor.id)).toEqual([]);
      },
    );

    it('candidate continuity still resets on source/gap, monotonic rollback and real hold activity', async () => {
      const h = await setup();
      const candidate = advanceIdleCandidate(
        undefined,
        ...(await idleInputs(h, 0)),
      );
      h.advanceMono(18 * 60_000, false);
      const replaced = await idleInputs(h, 18 * 60_000);
      replaced[1][0] = (
        await h.peer.participant('gateway').observe(h.binding, signal())
      ).coverage;
      expect(advanceIdleCandidate(candidate, ...replaced)?.mono).toBe(
        18 * 60_000,
      );
      const gap = await idleInputs(h, 18 * 60_000);
      gap[1][2] = {
        state: 'unknown',
        cursor: null,
        reason: 'native source gap',
      };
      expect(advanceIdleCandidate(candidate, ...gap)).toBeUndefined();
      h.advanceMono(2 * 60_000, false);
      const fresh = advanceIdleCandidate(
        undefined,
        ...(await idleInputs(h, PERSON_VM_IDLE_MS)),
      );
      expect(fresh?.mono).toBe(PERSON_VM_IDLE_MS);
      h.advanceMono(-60_000, false);
      const rollback = advanceIdleCandidate(
        fresh,
        ...(await idleInputs(h, 19 * 60_000)),
      );
      expect(rollback?.mono).toBe(19 * 60_000);
      const hold = await h.service.acquireHold(
        h.rc,
        h.binding,
        { kind: 'host-operation', operationId: randomUUID() },
        signal(),
      );
      expect(
        advanceIdleCandidate(rollback, ...(await idleInputs(h, 19 * 60_000))),
      ).toBeUndefined();
      h.advanceMono(60_000, false);
      h.advance(1);
      await h.service.releaseHold(h.rc, h.binding, hold, signal());
      expect(
        advanceIdleCandidate(
          rollback,
          ...(await idleInputs(h, PERSON_VM_IDLE_MS)),
        )?.mono,
      ).toBe(PERSON_VM_IDLE_MS);
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
      const stop = own(h.host.stopFrozen(h.rc, lease, signal()));
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

    it('a settled read/freeze owner cannot be upgraded into stop recovery with partial ACKs and accepted work', async () => {
      const h = await setup(),
        item = await permit(h, 'entry');
      const lease = await h.host.issue(h.rc, h.binding, signal());
      await h.host.participant('gateway').freeze(lease, signal());
      h.states.set(h.binding.vmId, 'stopped');
      await settledOrphan(h);
      const before = [...h.log];
      await expect(
        h.host.recoverStop(h.rc, lease, signal()),
      ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
      expect(h.log).toEqual(before);
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'queued', count: 1 },
      ]);
      // Existing trusted host store API can explicitly fence/release a
      // non-stop owner without touching VM, independent work, or the gate.
      h.advanceMono(90001);
      await h.store.recover(
        h.rc.actor.id,
        { now: h.now, ttlMs: 90000, signal: signal() },
        async (owned) => {
          await owned.guard();
        },
      );
      expect((await h.store.read(h.rc.actor.id))!.leaseOwner).toBe(null);
      expect(h.log).toEqual(before);
      await h.host.participant('gateway').thaw(lease, signal());
      await h.peer.participant('entry').thaw(lease, signal());
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'queued', count: 1 },
      ]);
      await h.host.finish(item);
    });

    it('public recoverExpired cannot clean a native-off VM while an independent accepted host permit remains', async () => {
      const h = await setup(),
        item = await permit(h, 'gateway');
      h.states.set(h.binding.vmId, 'stopped');
      await settledOrphan(h);
      const before = [...h.log];
      await expect(
        h.service.recoverExpired(h.rc, signal()),
      ).rejects.toMatchObject({ code: 'VM_ACTIVE' });
      expect(h.log).toEqual(before);
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'queued', count: 1 },
      ]);
      await h.host.finish(item);
      h.advanceMono(90001);
      expect((await h.service.recoverExpired(h.rc, signal())).phase).toBe(
        'stopped',
      );
    });

    it('even a persisted unknown-stop recovery must recheck accepted work under its new physical owner', async () => {
      const h = await setup(),
        item = await permit(h, 'entry'),
        lease = await frozen(h);
      // Negative storage-recovery matrix: a stop marker is not proof that a
      // separately durable accepted permit joined. No successful idle stop is claimed.
      await db`update person_virtual_machines set admission_state=jsonb_set(admission_state,'{round,stop}','"unknown"'::jsonb),admission_revision=admission_revision+1 where person_id=${h.rc.actor.id}`;
      h.states.set(h.binding.vmId, 'stopped');
      await settledOrphan(h);
      const before = [...h.log];
      await expect(
        h.host.recoverStop(h.rc, lease, signal()),
      ).rejects.toMatchObject({ code: 'VM_ACTIVE' });
      expect(h.log).toEqual(before);
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'queued', count: 1 },
      ]);
      await h.host.finish(item);
      h.advanceMono(90001);
      expect((await h.host.recoverStop(h.rc, lease, signal())).phase).toBe(
        'stopped',
      );
      await h.host.participant('gateway').thaw(lease, signal());
      await h.peer.participant('entry').thaw(lease, signal());
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
      const wake = own(h.host.wake(h.rc, h.binding, caller.signal));
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
      const owner = own(
        blocking.begin(async (sql) => {
          await sql`select pg_advisory_xact_lock(${key})`;
          held.resolve();
          await release.promise;
        }),
      );
      const ownerOutcome = owner.catch((error: unknown) => error);
      let outcome: Promise<unknown> = Promise.resolve();
      try {
        await Promise.race([held.promise, owner]);
        await db.unsafe(
          `create function fixture_block_delete() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(${key}); return old; end; $$`,
        );
        await db.unsafe(
          'create trigger fixture_block_delete before delete on person_vm_admission_permits for each row execute function fixture_block_delete()',
        );
        const finish = own(h.host.finish(item));
        outcome = finish.catch((error: unknown) => error);
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
        await ownerOutcome;
        await outcome;
        await blocking.end({ timeout: 0 });
      }
    });

    it('lost admit ACK after a REAL PG commit has no callback; only its settled local issuer can retry that exact operation', async () => {
      let armed = false;
      const source = factory('lost-ack', async () => {
        if (armed) {
          armed = false;
          throw Object.assign(
            new Error('synthetic response lost AFTER actual COMMIT'),
            { code: 'ECONNRESET' },
          );
        }
      });
      const h = await setup(source.open),
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

    it('a real COMMIT followed by PG loss joins its actual delivery before end and never issues a post-close rollback', async () => {
      const committed = latch(),
        closed = latch(),
        release = latch();
      let armed = false,
        name = '',
        delivered = false,
        settled = false;
      const source = factory(
        'commit-join',
        async (currentName) => {
          if (!armed) return;
          armed = false;
          name = currentName;
          committed.resolve();
          await release.promise;
          delivered = true;
        },
        (currentName) => {
          if (currentName === name) closed.resolve();
        },
      );
      const h = await setup(source.open),
        operationId = randomUUID();
      armed = true;
      const admission = own(
        h.host.admit(
          h.rc,
          h.binding,
          { participant: 'gateway', operationId },
          signal(),
        ),
      );
      const outcome = own(
        admission.then(
          (value) => {
            settled = true;
            return value;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        ),
      );
      try {
        await committed.promise;
        const [backend] =
          await admin`select pid from pg_stat_activity where application_name=${name}`;
        expect(backend).toBeDefined();
        await admin`select pg_terminate_backend(${backend!.pid})`;
        await closed.promise;
        await expect(
          h.peer.admit(
            h.rc,
            h.binding,
            { participant: 'gateway', operationId },
            signal(),
          ),
        ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
        expect(settled).toBe(false);
        expect(source.events).not.toContain(name + ':end');
        release.resolve();
        expect(await outcome).toBeInstanceOf(Error);
        expect(delivered).toBe(true);
        const tail = source.events
          .slice(source.events.indexOf(name + ':close') + 1)
          .filter((event) => event.startsWith(name + ':'));
        expect(tail).toEqual([name + ':end']);
        expect(await counts(h.rc.actor.id)).toEqual([
          { disposition: 'queued', count: 1 },
        ]);
        const retry = await h.host.admit(
          h.rc,
          h.binding,
          { participant: 'gateway', operationId },
          signal(),
        );
        handles.push([h.host, retry]);
        await h.host.finish(retry);
      } finally {
        release.resolve();
        await outcome;
      }
    });

    it('LISTEN close joins real UNLISTEN before end, preserves its first failure and closes the owner', async () => {
      const failure = new Error(
          'synthetic failure AFTER real UNLISTEN acknowledgement',
        ),
        closed = latch();
      let listenName = '';
      const source = factory(
        'listen-close',
        undefined,
        (name) => {
          if (name === listenName) closed.resolve();
        },
        failure,
      );
      const h = await setup(source.open);
      const subscription = await h.host
        .participant('gateway')
        .subscribe(h.binding, signal());
      listenName = source.events
        .find((event) => event.endsWith(':listen'))!
        .slice(0, -':listen'.length);
      const closing = own(subscription.close());
      expect(subscription.close()).toBe(closing);
      await expect(closing).rejects.toBe(failure);
      await closed.promise;
      expect(source.events.indexOf(listenName + ':unlisten')).toBeLessThan(
        source.events.indexOf(listenName + ':end'),
      );
      expect(
        source.events.filter((event) => event === listenName + ':end'),
      ).toHaveLength(1);
    });

    it('epoch/revocation invalidation cancels a tracked transport but finish still joins it before releasing durable activity', async () => {
      const h = await setup(),
        item = await permit(h, 'gateway'),
        entered = latch(),
        release = latch();
      let ownedSignal: AbortSignal | undefined;
      const active = own(
        h.host.activate(
          item,
          async (owned) => {
            ownedSignal = owned;
            entered.resolve();
            await release.promise;
          },
          signal(),
        ),
      );
      await entered.promise;
      // Simulate a trusted future revocation producer; no organization API is implemented here.
      await db`update person_virtual_machines set admission_version=${randomUUID()},
      admission_state=jsonb_set(admission_state,'{revoked}',${db.json('fixture-canonical-source')}::jsonb)
      where person_id=${h.rc.actor.id}`;
      await expect.poll(() => ownedSignal?.aborted).toBe(true);
      const finish = own(h.host.finish(item));
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
      const start = own(h.service.start(h.rc, signal())),
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
      const snapshot = latch(),
        release = latch();
      let armed = false,
        commits = 0;
      const source = factory('late-receipt', async () => {
        // Old binding subscribe rolls back; then old receipt and current gate commit.
        if (armed && ++commits === 2) {
          snapshot.resolve();
          await release.promise;
        }
      });
      const h = await setup(source.open),
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
      const current = await h.host.issue(h.rc, ready, signal());
      await h.host.participant('gateway').freeze(current, signal());
      await h.peer.participant('entry').freeze(current, signal());
      await h.host.participant('gateway').thaw(current, signal());
      armed = true;
      const resumed = own(h.host.waitUntilReady(h.rc, pending, signal()));
      try {
        expect(
          await Promise.race([
            snapshot.promise,
            resumed.then(() => 'premature'),
          ]),
        ).toBeUndefined();
        await h.peer.participant('entry').thaw(current, signal());
        release.resolve();
        expect(await resumed).toEqual(ready);
        expect(h.log.filter((value) => value === 'native:start')).toHaveLength(
          1,
        );
      } finally {
        release.resolve();
      }
      await h.host.finish(pending);
      expect(
        (await h.host.participant('gateway').observe(ready, signal())).state,
      ).toBe('known');
    });
  },
);
