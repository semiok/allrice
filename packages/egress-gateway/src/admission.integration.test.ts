/** Real PG admission and HTTP egress. Native VM/disk/readiness and upstream are
 * explicit fixtures; no real VM/model or private VM store SQL. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PersonVmService,
  PostgresPersonVmStore,
  type PersonVmAdmissionBoundary,
  type PersonVmAdmissionPermit,
  type PersonVmAdmissionObservation,
  type PersonVmSqlFactory,
} from '@allrice/person-vm';
import { context, harness } from '../../person-vm/src/test-support.ts';
import { assertRuntimeFixtureDatabase } from '../../database/src/runtime-fixture-database.ts';
import { createEgressGateway } from './gateway.ts';
import type { GuestEgressAccess } from './contract.ts';

function latch<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
type Known = Extract<PersonVmAdmissionObservation, { state: 'known' }>;
suite('egress frozen admission through real PG owner and HTTP', () => {
  let admin: postgres.Sql, schema: string, caller: AbortController;
  const clients = new Set<postgres.Sql>();
  const cleanup: (() => Promise<unknown>)[] = [];
  const releases: (() => void)[] = [];
  beforeEach(async () => {
    caller = new AbortController();
    const url = process.env.ALLRICE_TEST_DATABASE_URL!;
    assertRuntimeFixtureDatabase(new URL(url));
    admin = postgres(url, { max: 1, onnotice: () => {} });
    schema = 'met269_' + randomUUID().replaceAll('-', '');
    await admin.unsafe(`create schema "${schema}"`);
    const db = open();
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
    caller.abort();
    for (const release of releases.splice(0)) release();
    const results = await Promise.allSettled(
      cleanup.splice(0).map((fn) => fn()),
    );
    await Promise.all([...clients].map((db) => db.end({ timeout: 0 })));
    clients.clear();
    await admin.unsafe(`drop schema "${schema}" cascade`);
    await admin.end({ timeout: 0 });
    expect(results.filter((v) => v.status === 'rejected')).toEqual([]);
  });
  function open() {
    const db = postgres(process.env.ALLRICE_TEST_DATABASE_URL!, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: schema },
    });
    clients.add(db);
    return db;
  }
  async function setup() {
    const openSql: PersonVmSqlFactory = open;
    const store = new PostgresPersonVmStore(openSql);
    const ports = harness(store);
    const rc = context();
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    let access!: GuestEgressAccess;
    const admitted = latch<PersonVmAdmissionPermit>();
    const waiting = latch<void>();
    const finished = latch<void>();
    const readyEntered = latch<void>(),
      readyAllowed = latch<void>();
    releases.push(() => readyAllowed.resolve());
    let blockReady = false;
    let waitSignal: AbortSignal | undefined;
    let beforeActivate: (() => Promise<void>) | undefined;
    let managedCalls = 0;
    const receivedSignals: AbortSignal[] = [];
    const vm = new PersonVmService({
      ...ports.options,
      egress: {
        prepare: (...args) => gateway.prepare(...args),
        assertActive: (...args) => gateway.assertActive(...args),
        revoke: (...args) => gateway.revoke(...args),
      },
      runtime: {
        ...ports.runtime,
        readiness: async (binding, signal) => {
          if (blockReady) {
            readyEntered.resolve();
            await readyAllowed.promise;
            signal.throwIfAborted();
          }
          return ports.runtime.readiness(binding, signal);
        },
      },
    });
    const host = vm.createAdmissionHost({ openSql });
    const peerVm = new PersonVmService({
      ...ports.options,
      store: new PostgresPersonVmStore(openSql),
    });
    const peer = peerVm.createAdmissionHost({ openSql });
    const permits: PersonVmAdmissionPermit[] = [];
    const boundary: PersonVmAdmissionBoundary = {
      async admit(...args) {
        const permit = await host.admit(...args);
        permits.push(permit);
        admitted.resolve(permit);
        return permit;
      },
      queued: (...args) => host.queued(...args),
      async activate(permit, operation, signal) {
        if (beforeActivate) await beforeActivate();
        return host.activate(permit, operation, signal);
      },
      async waitUntilReady(...args) {
        waitSignal = args[2];
        waiting.resolve();
        return host.waitUntilReady(...args);
      },
      async finish(permit) {
        await host.finish(permit);
        finished.resolve();
      },
    };
    const upstream = vi.fn(async () => ({
      status: 200,
      contentType: 'text/plain',
      body: Buffer.from('fixture'),
    }));
    const gateway = createEgressGateway({
      vm,
      admission: boundary,
      authority: {
        context: async (_binding, signal) => {
          receivedSignals.push(signal);
          return rc;
        },
        allow: async () => {},
      },
      transport: { read: upstream },
      revokeModel: async () => {},
      policy: {
        routes: [
          {
            id: 'read',
            path: '/read',
            origins: ['https://example.test'],
            target: () => new URL('https://example.test/file'),
            maxResponseBytes: 100,
            timeoutMs: 5000,
            validate: () => {},
          },
        ],
      },
      services: [
        {
          id: 'managed',
          path: '/managed',
          method: 'POST',
          admissionOwner: 'service',
          // This fixture models the service boundary, not real assertCall/native model proof.
          handle: async (_request, response) => {
            managedCalls++;
            response.end('managed');
          },
        },
      ],
      provisioner: {
        endpoint: async () => ({
          host: '127.0.0.1',
          port,
          guestOrigin: `http://127.0.0.1:${port}`,
        }),
        install: async (_binding, value) => {
          access = value;
        },
        remove: async () => {},
      },
    });
    await vm.prewarm(rc, { trigger: 'page' }, caller.signal);
    const binding = await vm.resolve(rc, caller.signal);
    const receipt = await gateway.prepare(binding, caller.signal);
    cleanup.push(() =>
      gateway.revoke(receipt, 'stop', new AbortController().signal),
    );
    const participant = peer.participant('gateway'),
      entry = peer.participant('entry');
    async function observe(predicate: (value: Known) => boolean) {
      const subscription = await participant.subscribe(binding, caller.signal);
      try {
        for (;;) {
          const value = await participant.observe(binding, caller.signal);
          if (value.state !== 'known') throw Error(value.reason);
          if (predicate(value)) return value;
          await subscription.wait(value.coverage.cursor, caller.signal);
        }
      } finally {
        await subscription.close();
      }
    }
    let physicalRelease: (() => void) | undefined;
    let physicalWork: Promise<unknown> | undefined;
    async function freeze() {
      const lease = await host.issue(rc, binding, caller.signal);
      await host.participant('gateway').freeze(lease, caller.signal);
      await entry.freeze(lease, caller.signal);
      const entered = latch<void>(),
        release = latch<void>();
      physicalRelease = () => release.resolve();
      releases.push(physicalRelease);
      physicalWork = host.withLease(
        lease,
        async () => {
          entered.resolve();
          await release.promise;
        },
        caller.signal,
      );
      void physicalWork.catch(() => {});
      cleanup.push(async () => {
        release.resolve();
        await physicalWork;
      });
      await entered.promise;
      return lease;
    }
    function request(path = '/read', signal = caller.signal) {
      const promise = fetch(access.origin + path, {
        method: path === '/managed' ? 'POST' : 'GET',
        headers: { authorization: 'Bearer ' + access.capability },
        signal,
      }).then(async (response) => ({
        status: response.status,
        body: await response.text(),
      }));
      void promise.catch(() => {});
      return promise;
    }
    return {
      host,
      vm,
      rc,
      binding,
      participant,
      entry,
      permits,
      admitted,
      waiting,
      finished,
      readyEntered,
      readyAllowed,
      upstream,
      receivedSignals,
      observe,
      freeze,
      request,
      get waitSignal() {
        return waitSignal;
      },
      get managedCalls() {
        return managedCalls;
      },
      async releasePhysical() {
        physicalRelease?.();
        await physicalWork;
      },
      blockReady() {
        blockReady = true;
      },
      holdQueued() {
        const hold = latch<void>(),
          entered = latch<void>();
        releases.push(() => hold.resolve());
        beforeActivate = async () => {
          entered.resolve();
          await hold.promise;
        };
        return { hold, entered };
      },
    };
  }
  async function expectDeferred(
    f: Awaited<ReturnType<typeof setup>>,
    response: ReturnType<typeof f.request>,
  ) {
    const event = await Promise.race([
      f.waiting.promise.then(() => 'deferred'),
      response.then(() => 'http-returned'),
    ]);
    expect(event, 'freeze must wait, not fail HTTP before deferred').toBe(
      'deferred',
    );
    expect(await f.observe((v) => v.deferred === 1)).toMatchObject({
      queued: 0,
      active: 0,
      deferred: 1,
    });
    expect(f.upstream).not.toHaveBeenCalled();
  }
  it('F1 preserves pre-freeze queued work and defers new requests without 403/502', async () => {
    const f = await setup();
    const hold = f.holdQueued();
    const old = f.request();
    await hold.entered.promise;
    await f.freeze();
    expect(await f.observe((v) => v.queued === 1)).toMatchObject({
      queued: 1,
      deferred: 0,
    });
    hold.hold.resolve();
    expect(await old).toMatchObject({ status: 200, body: 'fixture' });
    await f.finished.promise;
    expect(f.upstream).toHaveBeenCalledTimes(1);
    const pending = f.request();
    const event = await Promise.race([
      f.waiting.promise.then(() => 'deferred'),
      pending.then(() => 'returned'),
    ]);
    expect(event, 'new frozen request must enter deferred').toBe('deferred');
    expect(await f.observe((v) => v.deferred === 1)).toMatchObject({
      queued: 0,
      active: 0,
    });
    expect(f.upstream).toHaveBeenCalledTimes(1);
  });
  it('F2 waits for both exact releases and actual ready; never replays old execution', async () => {
    const f = await setup();
    const lease = await f.freeze();
    f.blockReady();
    let returned = false;
    const pending = f.request().then((value) => {
      returned = true;
      return value;
    });
    await expectDeferred(f, pending);
    expect(
      await f.participant.thaw({ ...lease, version: 'wrong' }, caller.signal),
    ).toBe('superseded');
    await f.participant.thaw(lease, caller.signal);
    expect(await f.observe((v) => v.deferred === 1)).toMatchObject({
      active: 0,
    });
    expect(returned).toBe(false);
    await f.releasePhysical();
    await f.entry.thaw(lease, caller.signal);
    await f.readyEntered.promise;
    expect(
      returned,
      'actual ready must complete before finishing deferred demand',
    ).toBe(false);
    expect(f.upstream).not.toHaveBeenCalled();
    f.readyAllowed.resolve();
    const old = await pending;
    expect(old).toMatchObject({ status: 409 });
    expect(JSON.parse(old.body)).toEqual({ code: 'EXECUTION_REBIND_REQUIRED' });
    await f.finished.promise;
    expect(f.upstream).not.toHaveBeenCalled();
    expect(await f.request()).toMatchObject({ status: 200, body: 'fixture' });
    expect(f.upstream).toHaveBeenCalledTimes(1);
    expect(f.permits.map((p) => p.disposition)).toEqual(['deferred', 'queued']);
  });
  it('F3 cancellation reaches deferred wait and joins it without thaw or dispatch', async () => {
    const f = await setup();
    const lease = await f.freeze();
    const cancel = new AbortController();
    const pending = f.request('/read', cancel.signal);
    await expectDeferred(f, pending);
    cancel.abort();
    await expect(pending).rejects.toThrow();
    await expect
      .poll(() => f.waitSignal?.aborted, { timeout: 1000 })
      .toBe(true);
    await f.finished.promise;
    const value = await f.observe((v) => v.deferred === 0);
    expect(value).toMatchObject({ active: 0, queued: 0, frozen: lease });
    expect(f.upstream).not.toHaveBeenCalled();
  });
  it('managed service receives qualified frozen ingress without an egress permit', async () => {
    const f = await setup();
    await f.freeze();
    expect(await f.request('/managed')).toMatchObject({ status: 200 });
    expect(f.managedCalls).toBe(1);
    expect(f.permits).toEqual([]);
    expect(await f.observe(() => true)).toMatchObject({
      queued: 0,
      active: 0,
      deferred: 0,
    });
  });
});
