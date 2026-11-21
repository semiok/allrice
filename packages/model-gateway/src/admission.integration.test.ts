/** Formal PG admission + real loopback/native libraries; VM ports are fixtures.
 * No real VM/model, production identity resolver, private producer import or SQL.
 * Dropping a test schema with an unsafe permit is NOT protocol recovery. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setImmediate } from 'node:timers/promises';
import postgres from 'postgres';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  PersonVmService,
  PostgresPersonVmStore,
  type PersonVmAdmissionBoundary,
  type PersonVmAdmissionObservation,
  type PersonVmAdmissionPermit,
  type PersonVmSqlFactory,
} from '@allrice/person-vm';
import {
  createModelGateway,
  createPostgresModelGatewayStore,
  GatewayLlmAdapter,
  ModelGatewayError,
  type GatewayProvider,
  type ModelAttemptReceipt,
  type ModelCallBinding,
  type ModelGatewayPort,
  type ModelGatewayStore,
} from '@allrice/model-gateway';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import { assertRuntimeFixtureDatabase } from '../../database/src/runtime-fixture-database.ts';
// Existing test-only native/disk/readiness ports, never a substitute PG host.
import { context, harness } from '../../person-vm/src/test-support.ts';
import { runGatewayAdmission } from './admission.ts';
import {
  closeServer,
  deferred,
  freshCall,
  listen,
  modelBinding,
  nativeProviderFixture,
  upstreamFixture,
} from './gateway.fixture.ts';
import { nativeRefreshFixture, responsesFixture } from './revision.fixture.ts';
import {
  observeAdmissionCalls,
  observeNativeLifecycle,
  type NativeLifecycleProof,
} from './admission-proof.fixture.ts';
import {
  nativeCloseSensitivityFixture,
  type NativeReleaseProbe,
} from './native-close-sensitivity.fixture.ts';

type Host = ReturnType<PersonVmService['createAdmissionHost']>;
type Phase = 'queued' | 'active';
type Known = Extract<PersonVmAdmissionObservation, { state: 'known' }>;
type BoundaryTrace = {
  boundary: PersonVmAdmissionBoundary;
  permits: PersonVmAdmissionPermit[];
  finished: Set<PersonVmAdmissionPermit>;
  finishCalls: PersonVmAdmissionPermit[];
  finishErrors: unknown[];
  ready: ModelCallBinding['vm'][];
  waiting: ReturnType<typeof deferred<void>>;
  canceled: ReturnType<typeof deferred<void>>;
};
const phase = new AsyncLocalStorage<Phase>();
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const messages = [
  {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'Synthetic admission check.' }],
  },
];
function terminal(chunks: readonly StreamChunk[]) {
  const value = chunks.findLast((chunk) => chunk.type === 'finish');
  expect(value).toBeDefined();
  return value!;
}

suite('MET268 formal PG host with gateway HTTP/native composition', () => {
  let admin: postgres.Sql;
  let url: string;
  let schema: string;
  let prefix: string;
  let caller: AbortController;
  let originalFetch: typeof fetch;
  const clients = new Set<postgres.Sql>();
  const work = new Set<Promise<unknown>>();
  const releases = new Set<() => void>();
  const gateways = new Set<ModelGatewayPort>();
  const closers: (() => Promise<void>)[] = [];
  const boundaries: BoundaryTrace[] = [];
  const faults = {
    selected: new Set<Phase>(),
    fulfilled: new Set<Phase>(),
    fired: new Set<Phase>(),
    errors: {
      queued: new Error('real queued listener cleanup injection'),
      active: new Error('real active listener cleanup injection'),
    },
  };
  function own<T>(promise: Promise<T>) {
    work.add(promise);
    void promise.catch(() => {});
    return promise;
  }
  function latch() {
    const value = deferred();
    releases.add(value.resolve);
    return value;
  }
  function sql(role: string, max = 1) {
    const applicationName = `${prefix}-owned-${role}-${clients.size}`;
    if (Buffer.byteLength(applicationName) > 63)
      throw new Error('fixture application_name too long');
    const value = postgres(url, {
      max,
      onnotice: () => {},
      connection: { search_path: schema, application_name: applicationName },
    });
    clients.add(value);
    return value;
  }
  function vmFactory(role: string): PersonVmSqlFactory {
    return () => {
      const value = sql(role);
      const nativeListen = value.listen.bind(value);
      value.listen = ((...args: Parameters<typeof value.listen>) => {
        // A public-method test context identifies this exact run's listener.
        const owner = phase.getStore();
        return nativeListen(...args).then((metadata) => ({
          ...metadata,
          async unlisten() {
            await metadata.unlisten(); // Real UNLISTEN joins before injection.
            if (
              owner &&
              faults.selected.has(owner) &&
              faults.fulfilled.has(owner) &&
              !faults.fired.has(owner)
            ) {
              faults.fired.add(owner);
              throw faults.errors[owner];
            }
          },
        }));
      }) as typeof value.listen;
      return value;
    };
  }
  function traceBoundary(
    host: Host,
    native?: NativeLifecycleProof,
    releaseProof?: NativeReleaseProbe,
  ): BoundaryTrace {
    const permits: PersonVmAdmissionPermit[] = [];
    const finished = new Set<PersonVmAdmissionPermit>();
    const finishCalls: PersonVmAdmissionPermit[] = [];
    const finishErrors: unknown[] = [];
    const ready: ModelCallBinding['vm'][] = [];
    const observed = observeAdmissionCalls(host);
    closers.push(async () => observed.dispose());
    const boundary: PersonVmAdmissionBoundary = {
      async admit(...args) {
        const permit = await host.admit(...args);
        permits.push(permit);
        native?.bind(permit);
        return permit;
      },
      queued(permit, operation, signal) {
        return phase.run('queued', () =>
          host.queued(
            permit,
            async (current) => {
              observed.watch(current);
              const outcome = await operation(current);
              faults.fulfilled.add('queued');
              native?.mark(permit, 'queued-fulfilled');
              return outcome;
            },
            signal,
          ),
        );
      },
      activate(permit, operation, signal) {
        return phase.run('active', () =>
          host.activate(
            permit,
            async (current) => {
              observed.watch(current);
              const outcome = await operation(current);
              faults.fulfilled.add('active');
              native?.mark(permit, 'active-fulfilled');
              return outcome;
            },
            signal,
          ),
        );
      },
      async waitUntilReady(...args) {
        const binding = await observed.wait(...args);
        ready.push(binding);
        return binding;
      },
      async finish(permit) {
        finished.add(permit);
        finishCalls.push(permit);
        native?.mark(permit, 'finish-enter');
        try {
          await host.finish(permit);
          releaseProof?.permitFinished();
          native?.mark(permit, 'finish-return');
        } catch (error) {
          finishErrors.push(error);
          throw error;
        }
      },
    };
    const trace = {
      boundary,
      permits,
      finished,
      finishCalls,
      finishErrors,
      ready,
      waiting: observed.waiting,
      canceled: observed.canceled,
    };
    boundaries.push(trace);
    return trace;
  }
  async function setup(releaseProof?: NativeReleaseProbe) {
    const openA = vmFactory('A');
    const openB = vmFactory('B');
    const storeA = new PostgresPersonVmStore(openA);
    const storeB = new PostgresPersonVmStore(openB);
    const ports = harness(storeA); // Never the helper's default MemoryStore.
    const vmA = new PersonVmService({ ...ports.options, store: storeA });
    const vmB = new PersonVmService({ ...ports.options, store: storeB });
    const rc = context();
    await vmA.prewarm(rc, { trigger: 'page' }, caller.signal);
    const binding = await vmA.resolve(rc, caller.signal);
    const hostA = vmA.createAdmissionHost({ openSql: openA });
    const hostB = vmB.createAdmissionHost({ openSql: openB });
    const peer = hostB.participant('gateway');
    const entry = hostB.participant('entry');
    const dbA = sql('modelA', 12);
    const dbB = sql('modelB', 12);
    const claims: string[] = [];
    const receipts: ModelAttemptReceipt[] = [];
    const finishFailures: unknown[] = [];
    const queued = latch();
    let ledgerFailure: Error | undefined;
    function modelStore(db: postgres.Sql): ModelGatewayStore {
      const actual = createPostgresModelGatewayStore(db);
      return {
        ...actual,
        async claimCall(...args) {
          const id = await actual.claimCall(...args);
          claims.push(id);
          return id;
        },
        async tryStartAttempt(attempt) {
          const result = await actual.tryStartAttempt(attempt);
          if (!result) queued.resolve();
          return result;
        },
        async finishAttempt(receipt) {
          releaseProof?.slotEnter();
          receipts.push(receipt);
          if (ledgerFailure) {
            const error = ledgerFailure;
            ledgerFailure = undefined;
            finishFailures.push(error);
            throw error; // Only G08: before the real ledger write, not close.
          }
          await actual.finishAttempt(receipt);
          releaseProof?.slotCommitted();
        },
      };
    }
    const modelA = modelStore(dbA);
    const modelB = modelStore(dbB);
    async function observe(predicate: (value: Known) => boolean) {
      const subscription = await peer.subscribe(binding, caller.signal);
      try {
        for (;;) {
          const value = await peer.observe(binding, caller.signal);
          if (value.state !== 'known') throw new Error(value.reason);
          if (predicate(value)) return value;
          await subscription.wait(value.coverage.cursor, caller.signal);
        }
      } finally {
        await subscription.close();
      }
    }
    async function slots() {
      const [row] = await dbA<{ count: number }[]>`
        select count(*)::int as count from allrice_model_gateway_slots
        where person_id=${binding.personId}`;
      return row!.count;
    }
    const base: ModelCallBinding = {
      ...modelBinding(binding.personId, binding.organizationId),
      context: rc,
      vm: binding,
    };
    async function mount(
      provider: GatewayProvider,
      options: {
        second?: boolean;
        route?: Pick<ModelCallBinding, 'provider' | 'model'>;
        nativeProof?: NativeLifecycleProof;
      } = {},
    ) {
      const issued = new Map<string, ModelCallBinding>();
      const calls: ModelCallBinding[] = [];
      const handled: Promise<void>[] = [];
      const errors: unknown[] = [];
      let starts = 0;
      let joined = 0;
      const trace = traceBoundary(
        options.second ? hostB : hostA,
        options.nativeProof,
        releaseProof,
      );
      const observedProvider =
        options.nativeProof?.provider(provider) ?? provider;
      const participant = (options.second ? hostB : hostA).participant(
        'gateway',
      );
      const gateway = createModelGateway({
        ownerId: randomUUID(),
        store: options.second ? modelB : modelA,
        provider: {
          ...observedProvider,
          stream(...args) {
            starts++;
            return observedProvider.stream(...args);
          },
        },
        admission: { boundary: trace.boundary, participant },
        authority: {
          async assertCall(value, signal) {
            signal.throwIfAborted();
            const expected = issued.get(value.native.callId);
            if (!expected || JSON.stringify(value) !== JSON.stringify(expected))
              throw new ModelGatewayError('BINDING_INVALID');
            // Public PG current-binding check remains valid while issue/freeze
            // temporarily owns a physical lease. No private VM row is read here.
            const current = await peer.observe(value.vm, signal);
            if (current.state !== 'known')
              throw new ModelGatewayError('BINDING_INVALID');
          },
          async authorizeUsage(current) {
            return {
              personId: current.actor.id,
              organizationId: current.organizationId,
            };
          },
          async confirmOwnerStopped() {
            throw new ModelGatewayError('AUTHORIZATION_DENIED');
          },
        },
      });
      gateways.add(gateway);
      expect(gateway.admission).toBe(participant);
      const server = createServer((request, response) => {
        const call = freshCall({
          ...base,
          ...(options.route
            ? { provider: options.route.provider, model: options.route.model }
            : {}),
        });
        issued.set(call.native.callId, structuredClone(call));
        calls.push(call);
        const handle = () =>
          gateway.handle(request, response, call, caller.signal);
        const pending = options.nativeProof
          ? options.nativeProof.runCall(call.native.callId, handle)
          : handle();
        handled.push(
          own(
            pending
              .catch((error) => {
                errors.push(error);
                response.destroy();
              })
              .finally(() => {
                joined++;
              }),
          ),
        );
      });
      const address = await listen(server);
      closers.push(() => closeServer(server));
      const adapter = new GatewayLlmAdapter(address + '/v1/stream');
      return {
        gateway,
        trace,
        calls,
        errors,
        get starts() {
          return starts;
        },
        get joined() {
          return handled.length > 0 && joined === handled.length;
        },
        join: () => Promise.all(handled),
        collect(signal = caller.signal) {
          return own(
            (async () => {
              const chunks: StreamChunk[] = [];
              for await (const chunk of adapter.stream({
                provider: 'host-gateway',
                model: 'fixture-model',
                messages,
                signal,
              }))
                chunks.push(chunk);
              return chunks;
            })(),
          );
        },
        post(signal = caller.signal, body: unknown = { messages }) {
          return own(
            fetch(address + '/v1/stream', {
              method: 'POST',
              signal,
              headers: { 'x-allrice-model-contract': '1' },
              body: JSON.stringify(body),
            }).then(async (response) => ({
              status: response.status,
              chunks: (await response.text())
                .trim()
                .split('\n')
                .filter(Boolean)
                .map((line) => JSON.parse(line) as StreamChunk),
            })),
          );
        },
      };
    }
    async function freeze() {
      const lease = await hostA.issue(rc, binding, caller.signal);
      await hostA.participant('gateway').freeze(lease, caller.signal);
      await entry.freeze(lease, caller.signal);
      return lease;
    }
    return {
      hostA,
      hostB,
      vmA,
      binding,
      base,
      peer,
      entry,
      ports,
      claims,
      receipts,
      modelA,
      modelB,
      finishFailures,
      queued,
      observe,
      slots,
      mount,
      freeze,
      failNextReceipt(error: Error) {
        ledgerFailure = error;
      },
    };
  }
  beforeAll(() => {
    const value = process.env.ALLRICE_TEST_DATABASE_URL;
    if (!value) throw new Error('Dedicated fixture database required');
    assertRuntimeFixtureDatabase(new URL(value));
    url = value;
    admin = postgres(url, { max: 1, onnotice: () => {} });
  });
  beforeEach(async () => {
    caller = new AbortController();
    originalFetch = globalThis.fetch;
    schema = 'met268_admit_' + randomUUID().replaceAll('-', '');
    prefix = 'm268-' + randomUUID().replaceAll('-', '');
    faults.selected.clear();
    faults.fulfilled.clear();
    faults.fired.clear();
    await admin.unsafe(`create schema "${schema}"`);
    const db = sql('migration');
    for (const name of [
      '0247_person_virtual_machines.sql',
      '0248_model_gateway_attempts.sql',
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
    const failures: unknown[] = [];
    caller?.abort(new Error('fixture cancel and join'));
    for (const release of releases) release();
    releases.clear();
    const settle = async (items: Promise<unknown>[]) => {
      for (const result of await Promise.allSettled(items))
        if (result.status === 'rejected') failures.push(result.reason);
    };
    await settle([...gateways].map((gateway) => gateway.close()));
    await Promise.allSettled([...work]); // Caller aborts are expected outcomes.
    for (const trace of boundaries)
      for (const permit of trace.permits)
        if (!trace.finished.has(permit))
          await trace.boundary
            .finish(permit)
            .catch((error) => failures.push(error));
    for (const close of closers.reverse())
      await close().catch((error) => failures.push(error));
    await settle([...clients].map((client) => client.end({ timeout: 0 })));
    if (admin && schema) {
      // Driver end may return before local socket close or PostgreSQL's
      // backend teardown. Still require zero owned backends before disposal;
      // do not terminate them or turn a persistent leak into a passing check.
      await expect
        .poll(async () => {
          const [row] = await admin<{ count: number }[]>`
            select count(*)::int as count from pg_stat_activity
            where application_name like ${prefix + '-owned-%'}`;
          return row?.count;
        })
        .toBe(0)
        .catch((error) => failures.push(error));
      // Unsafe permits may still exist. Test storage disposal is NOT recovery.
      await admin.unsafe(`drop schema if exists "${schema}" cascade`);
    }
    if (globalThis.fetch !== originalFetch)
      failures.push(new Error('scoped native fetch was not restored'));
    clients.clear();
    work.clear();
    gateways.clear();
    closers.length = 0;
    boundaries.length = 0;
    if (failures.length)
      throw new AggregateError(failures, 'fixture cleanup failed');
  });
  afterAll(async () => {
    await admin?.end({ timeout: 0 });
  });

  it.each([false, true])(
    'G01 native HTTP with missingUsage=%s releases formal admission and preserves usage',
    async (missingUsage) => {
      const f = await setup();
      const up = await upstreamFixture({ hold: true, missingUsage });
      closers.push(() => up.close());
      const native = await nativeProviderFixture(up.url);
      closers.push(() => native.close());
      const mounted = await f.mount(native.provider, { route: native.route });
      const result = mounted.collect();
      await up.whenCount(1);
      await f.observe((value) => value.active === 1 && value.queued === 0);
      up.complete(0);
      expect(terminal(await result).reason.kind).toBe('stop');
      await mounted.join();
      expect(
        await f.observe(
          (value) => value.active + value.queued + value.deferred === 0,
        ),
      ).toMatchObject({ active: 0 });
      expect(await f.slots()).toBe(0);
      expect(f.claims).toHaveLength(1);
      const rows = await f.modelA.attempts(f.claims[0]!);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        dispatchObserved: true,
        httpStatus: 200,
        outcome: 'closed',
        usage: {
          inputTokens: missingUsage ? null : 12,
          outputTokens: missingUsage ? null : 3,
          totalTokens: missingUsage ? null : 15,
        },
      });
      expect(mounted.trace.finishCalls).toHaveLength(1);
      expect(mounted.trace.finishErrors).toEqual([]);
    },
  );

  it('G02 nine real requests across two owners keep pre-freeze queued and the original eight-slot limit', async () => {
    const f = await setup();
    const up = await upstreamFixture({ hold: true });
    closers.push(() => up.close());
    const native = await nativeProviderFixture(up.url);
    closers.push(() => native.close());
    const yieldAllowed = latch(),
      eightEntered = latch();
    let entered = 0;
    const provider: GatewayProvider = {
      ...native.provider,
      async *stream(...args) {
        let first = true;
        for await (const chunk of native.provider.stream(...args)) {
          if (first) {
            first = false;
            if (++entered === 8) eightEntered.resolve();
            await yieldAllowed.promise;
          }
          yield chunk;
        }
      },
    };
    const a = await f.mount(provider, { route: native.route });
    const b = await f.mount(provider, { route: native.route, second: true });
    const running = Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? a : b).collect(),
    );
    await eightEntered.promise;
    const ninth = b.collect();
    await f.queued.promise;
    await f.observe((value) => value.active === 8 && value.queued === 1);
    const lease = await f.freeze();
    expect(await f.peer.observe(f.binding, caller.signal)).toMatchObject({
      active: 8,
      queued: 1,
      deferred: 0,
    });
    expect(up.requests).toHaveLength(8);
    yieldAllowed.resolve();
    up.complete(0);
    await up.whenCount(9);
    expect(up.maxActive).toBe(8);
    for (let index = 1; index < 9; index++) up.complete(index);
    for (const chunks of await Promise.all([...running, ninth]))
      expect(terminal(chunks).reason.kind).toBe('stop');
    await Promise.all([a.join(), b.join()]);
    await f.observe((value) => value.active + value.queued === 0);
    await a.gateway.admission.thaw(lease, caller.signal);
    await f.entry.thaw(lease, caller.signal);
    expect(f.claims).toHaveLength(9);
    expect(await f.slots()).toBe(0);
  });

  it('G03 real deferred HTTP waits for exact dual release and aborts the unchanged old execution', async () => {
    const f = await setup();
    const up = await upstreamFixture();
    closers.push(() => up.close());
    const native = await nativeProviderFixture(up.url);
    closers.push(() => native.close());
    const mounted = await f.mount(native.provider, { route: native.route });
    const lease = await f.freeze();
    const startup = [...f.ports.log];
    const result = mounted.post();
    await f.observe((value) => value.deferred === 1);
    await mounted.trace.waiting.promise;
    const original = structuredClone(mounted.calls[0]!);
    expect(
      await mounted.gateway.admission.thaw(
        { ...lease, version: randomUUID() },
        caller.signal,
      ),
    ).toBe('superseded');
    const lostAck = new Error('host ACK lost after real release');
    await expect(
      (async () => {
        await mounted.gateway.admission.thaw(lease, caller.signal);
        throw lostAck;
      })(),
    ).rejects.toBe(lostAck);
    expect(await mounted.gateway.admission.thaw(lease, caller.signal)).toBe(
      'already-released',
    );
    expect(await f.peer.observe(f.binding, caller.signal)).toMatchObject({
      active: 0,
      queued: 0,
      deferred: 1,
    });
    expect(mounted.trace.ready).toHaveLength(0);
    expect(mounted.starts).toBe(0);
    expect(f.claims).toHaveLength(0);
    expect(await f.slots()).toBe(0);
    expect(up.requests).toHaveLength(0);
    expect(await f.vmA.resolve(f.base.context, caller.signal)).toEqual(
      f.binding,
    );
    expect(f.ports.log).toEqual(startup);
    expect(await f.entry.thaw(lease, caller.signal)).toBe('released');
    const response = await result;
    await mounted.join();
    expect(response.status).toBe(200);
    expect(terminal(response.chunks)).toMatchObject({
      reason: {
        kind: 'aborted',
        failure: { code: 'EXECUTION_REBIND_REQUIRED' },
      },
    });
    expect(mounted.calls[0]).toEqual(original);
    expect(mounted.trace.ready).toEqual([f.binding]);
    expect(mounted.starts).toBe(0);
    expect(up.requests).toHaveLength(0);
    expect(f.claims).toHaveLength(0);
    await f.observe(
      (value) => value.deferred === 0 && value.active + value.queued === 0,
    );
  });

  it('G04 cancel after entering a real deferred wait and one thaw releases demand without late replay', async () => {
    const f = await setup();
    const up = await upstreamFixture();
    closers.push(() => up.close());
    const native = await nativeProviderFixture(up.url);
    closers.push(() => native.close());
    const mounted = await f.mount(native.provider, { route: native.route });
    const lease = await f.freeze();
    const client = new AbortController();
    const result = mounted.post(client.signal).catch((error: unknown) => error);
    await f.observe((value) => value.deferred === 1);
    await mounted.trace.waiting.promise;
    await mounted.gateway.admission.thaw(lease, caller.signal);
    client.abort(new Error('client canceled entered deferred wait'));
    await result;
    await mounted.trace.canceled.promise;
    await mounted.join();
    expect(await f.peer.observe(f.binding, caller.signal)).toMatchObject({
      active: 0,
      queued: 0,
      deferred: 0,
    });
    await f.entry.thaw(lease, caller.signal);
    expect(mounted.trace.ready).toHaveLength(0);
    expect(mounted.starts).toBe(0);
    expect(up.requests).toHaveLength(0);
    expect(f.claims).toHaveLength(0);
    expect(mounted.trace.finishCalls).toHaveLength(1);
    expect(mounted.trace.finishErrors).toEqual([]);
  });

  it.each(['client', 'revoke', 'close'] as const)(
    'G05 %s cancellation joins actual native refresh and locked credential persistence',
    async (action) => {
      const f = await setup();
      const auth = await nativeRefreshFixture();
      closers.push(() => auth.close());
      releases.add(() => auth.releaseResponse());
      releases.add(() => auth.allowSave());
      const mounted = await f.mount(auth.provider);
      const client = new AbortController();
      const collecting = mounted
        .collect(client.signal)
        .catch((error: unknown) => error);
      await auth.arrived;
      expect(auth.rotated).toBe(true);
      await f.observe((value) => value.active === 1);
      let revoked: Promise<void> | undefined;
      let revokedSettled = false;
      let closed = false;
      let closing: Promise<void> | undefined;
      if (action === 'client') {
        client.abort(new Error('client canceled refresh'));
        await collecting;
      } else if (action === 'revoke')
        revoked = own(
          mounted.gateway.revoke(f.binding).then(() => {
            revokedSettled = true;
          }),
        );
      else
        closing = own(
          mounted.gateway.close().then(() => {
            closed = true;
          }),
        );
      await mounted.trace.canceled.promise;
      auth.releaseResponse();
      await auth.readyToSave;
      expect(closed).toBe(false);
      expect(revokedSettled).toBe(false);
      expect(mounted.joined).toBe(false);
      expect(auth.refreshSignal?.aborted).toBe(false);
      expect(await f.peer.observe(f.binding, caller.signal)).toMatchObject({
        active: 1,
        queued: 0,
      });
      expect(mounted.trace.finishCalls).toHaveLength(0);
      expect(await auth.persisted()).toMatchObject({
        payload: { refresh: 'synthetic-expired-refresh' },
      });
      auth.allowSave();
      await Promise.all([closing, collecting, revoked]);
      await mounted.join();
      await f.observe((value) => value.active + value.queued === 0);
      expect(await auth.persisted()).toMatchObject({
        payload: {
          access: 'synthetic-rotated-access',
          refresh: 'synthetic-rotated-refresh',
        },
      });
      expect(auth.requestCount).toBe(1);
      expect(auth.upstream.requests).toHaveLength(0);
      const rows = await f.modelA.attempts(f.claims[0]!);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'auth-refresh',
        dispatchObserved: true,
        httpStatus: 200,
        outcome: 'closed',
        usage: { totalTokens: null },
      });
      expect(mounted.trace.finishCalls).toHaveLength(1);
      expect(await f.slots()).toBe(0);
    },
  );

  it('G06 dispatched fetch rejection with independent real socket close releases admission only after join', async () => {
    const f = await setup();
    const up = await upstreamFixture({ disconnectBeforeHeaders: true });
    closers.push(() => up.close());
    const closed = latch();
    up.server.on('connection', (socket) =>
      socket.once('close', closed.resolve),
    );
    const native = await nativeProviderFixture(up.url);
    closers.push(() => native.close());
    const proof = observeNativeLifecycle();
    closers.push(async () => proof.dispose());
    const mounted = await f.mount(native.provider, {
      route: native.route,
      nativeProof: proof,
    });
    expect(terminal(await mounted.collect()).reason.kind).toBe('error');
    await closed.promise;
    await mounted.join();
    proof.assertReleased(mounted.calls[0]!.native.callId, 'close');
    await f.observe((value) => value.active + value.queued === 0);
    expect(await f.modelA.attempts(f.claims[0]!)).toMatchObject([
      {
        dispatchObserved: true,
        httpStatus: null,
        outcome: 'failed',
        usage: { totalTokens: null },
      },
    ]);
    expect(mounted.trace.finishErrors).toEqual([]);
    expect(await f.slots()).toBe(0);
  });

  it('G07 real failed Responses body closes before admission release and keeps original failed usage', async () => {
    const f = await setup();
    const native = await responsesFixture({
      holdFailedBody: true,
      failuresBeforeSuccess: 1,
    });
    closers.push(() => native.close());
    const proof = observeNativeLifecycle();
    closers.push(async () => proof.dispose());
    const mounted = await f.mount(native.provider, {
      route: native.binding,
      nativeProof: proof,
    });
    expect(terminal(await mounted.collect()).reason.kind).toBe('error');
    await native.whenClosed(1);
    await mounted.join();
    proof.assertReleased(mounted.calls[0]!.native.callId, 'close');
    await f.observe((value) => value.active + value.queued === 0);
    expect(await f.modelA.attempts(f.claims[0]!)).toMatchObject([
      {
        dispatchObserved: true,
        httpStatus: 200,
        terminal: 'failed',
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          totalTokens: 15,
          cachedInputTokens: 4,
        },
      },
    ]);
    expect(await f.slots()).toBe(0);
    expect(terminal(await mounted.collect()).reason.kind).toBe('stop');
    await native.whenClosed(2);
    await mounted.join();
    proof.assertReleased(mounted.calls[1]!.native.callId, 'eof-or-close');
    expect(native.requests).toHaveLength(2);
    expect(native.active).toBe(0);
  });

  it('G08 confirmed native close and only ledger-write failure releases admission but keeps the real PG slot', async () => {
    const f = await setup();
    const up = await upstreamFixture();
    closers.push(() => up.close());
    const native = await nativeProviderFixture(up.url);
    closers.push(() => native.close());
    const mounted = await f.mount(native.provider, { route: native.route });
    const error = new Error(
      'injected receipt write failure after actual body EOF',
    );
    f.failNextReceipt(error);
    expect(terminal(await mounted.collect())).toMatchObject({
      reason: { kind: 'error', failure: { code: 'LEDGER_UNAVAILABLE' } },
    });
    await up.closed;
    await mounted.join();
    await f.observe((value) => value.active + value.queued === 0);
    expect(up.active).toBe(0);
    expect(f.finishFailures).toEqual([error]);
    expect(mounted.trace.finishErrors).toEqual([]);
    expect(await f.slots()).toBe(1);
    expect(await f.modelA.attempts(f.claims[0]!)).toMatchObject([
      { outcome: 'unknown', usage: { totalTokens: null } },
    ]);
  });

  it('G09 rejected iterator cleanup retains a formal unsafe permit even when the actual HTTP socket has closed', async () => {
    const f = await setup();
    const up = await upstreamFixture({ hold: true });
    closers.push(() => up.close());
    const native = await nativeProviderFixture(up.url);
    closers.push(() => native.close());
    const failure = new Error('provider failed after first native chunk');
    const cleanup = new Error('injected iterator cleanup rejection');
    const provider: GatewayProvider = {
      ...native.provider,
      stream(...args) {
        const actual = native.provider.stream(...args)[Symbol.asyncIterator]();
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                await actual.next();
                throw failure;
              },
              async return() {
                await actual.return?.();
                throw cleanup;
              },
            };
          },
        };
      },
    };
    const mounted = await f.mount(provider, { route: native.route });
    expect(terminal(await mounted.collect())).toMatchObject({
      reason: { kind: 'error', failure: { code: 'LEDGER_UNAVAILABLE' } },
    });
    await up.closed;
    await mounted.join();
    expect(up.active).toBe(0);
    const observation = await f.peer.observe(f.binding, caller.signal);
    expect(observation).toMatchObject({ active: 1, queued: 0 });
    expect(mounted.trace.finishCalls).toHaveLength(1);
    expect(mounted.trace.finishErrors).toMatchObject([
      { code: 'CLEANUP_INCOMPLETE' },
    ]);
    // No foreign finish/recover, fake TTL, or private permit deletion follows.
  });

  it.each(['queued-only', 'queued-and-active'] as const)(
    'G10 real PG %s listener cleanup keeps joined business evidence (protocol, not HTTP)',
    async (mode) => {
      const f = await setup();
      const trace = traceBoundary(f.hostA);
      faults.selected.add('queued');
      if (mode === 'queued-and-active') faults.selected.add('active');
      const original = new Error('first confirmed-join business failure');
      const failure = (await own(
        runGatewayAdmission(
          {
            boundary: trace.boundary,
            participant: f.hostA.participant('gateway'),
          },
          f.base,
          'pg-cleanup-' + randomUUID(),
          caller.signal,
          async (_signal, activate) => {
            await activate();
            return { ok: false, error: original };
          },
        ),
      ).catch((error: unknown) => error)) as ModelGatewayError;
      expect(failure.code).toBe('LEDGER_UNAVAILABLE');
      expect((failure.cause as AggregateError).errors).toEqual([
        original,
        ...(mode === 'queued-and-active' ? [faults.errors.active] : []),
        faults.errors.queued,
        expect.objectContaining({ code: 'CLEANUP_INCOMPLETE' }),
      ]);
      expect(faults.fired).toEqual(faults.selected);
      expect(trace.finishCalls).toHaveLength(1);
      expect(trace.finishErrors).toMatchObject([
        { code: 'CLEANUP_INCOMPLETE' },
      ]);
      expect(await f.peer.observe(f.binding, caller.signal)).toMatchObject({
        active: 1,
        queued: 0,
      });
    },
  );

  it('G11 invalid input before provider/claim dispatch is a joined business failure, not an unsafe permit', async () => {
    const f = await setup();
    const up = await upstreamFixture();
    closers.push(() => up.close());
    const native = await nativeProviderFixture(up.url);
    closers.push(() => native.close());
    const mounted = await f.mount(native.provider, { route: native.route });
    const response = await mounted.post(caller.signal, {});
    await mounted.join();
    expect(response.status).toBe(400);
    expect(terminal(response.chunks)).toMatchObject({
      reason: { kind: 'error', failure: { code: 'INVALID_INPUT' } },
    });
    expect(mounted.starts).toBe(0);
    expect(up.requests).toHaveLength(0);
    expect(f.claims).toHaveLength(0);
    expect(await f.slots()).toBe(0);
    expect(await f.peer.observe(f.binding, caller.signal)).toMatchObject({
      active: 0,
      queued: 0,
      deferred: 0,
    });
    expect(mounted.trace.finishCalls).toHaveLength(1);
    expect(mounted.trace.finishErrors).toEqual([]);
  });

  it('G12 native TCP close precedes actual PG slot and shared permit release', async () => {
    const proof = await nativeCloseSensitivityFixture({
      release: (callback) => {
        releases.add(callback);
      },
      close: (callback) => {
        closers.push(callback);
      },
    });
    const f = await setup(proof.releaseProbe);
    const mounted = await f.mount(proof.provider);
    const collecting = mounted.collect();
    await proof.arrived.promise;
    await f.observe((value) => value.active === 1 && value.queued === 0);
    expect(await f.slots()).toBe(1);
    expect(proof.snapshot()).toMatchObject({
      calls: 1,
      sockets: 1,
      requests: 1,
      eof: 0,
      tcpPeer: true,
      peerOpen: true,
    });
    expect(
      proof.snapshot().events.filter((event) => event.kind === 'local-close'),
    ).toEqual([]);
    proof.arm();
    const revoked = own(mounted.gateway.revoke(f.binding));
    await proof.destroying.promise;
    await proof.rejected.promise;
    // Fixed source has only finite promise jobs from raw rejection to public
    // finishAttempt entry. One check phase drains those jobs, without a sleep.
    await setImmediate();
    const held = proof.snapshot();
    expect(held).toMatchObject({
      held: true,
      peerOpen: true,
      tcpPeer: true,
      eof: 0,
    });
    expect(held.events.filter((event) => event.kind === 'local-close')).toEqual(
      [],
    );
    const entered = held.events.some((event) => event.kind === 'slot-enter');
    if (entered) {
      // Keep the real FD open through REAL commit/join, defeating PG latency
      // as a mask. The probe never waits or releases anything in product work.
      await proof.committed.promise;
      await proof.finished.promise;
      await Promise.all([collecting, revoked, mounted.join()]);
      expect(await f.slots()).toBe(0);
      expect(await f.peer.observe(f.binding, caller.signal)).toMatchObject({
        active: 0,
        queued: 0,
        deferred: 0,
      });
      const beforeClose = proof.snapshot();
      expect(beforeClose).toMatchObject({ held: true, peerOpen: true });
      expect(
        beforeClose.events.filter((event) => event.kind === 'local-close'),
      ).toEqual([]);
    } else {
      expect(await f.slots()).toBe(1);
      expect(await f.peer.observe(f.binding, caller.signal)).toMatchObject({
        active: 1,
        queued: 0,
        deferred: 0,
      });
    }
    // Correct code is released independently of the release it must withhold.
    proof.allowPhysicalDestroy();
    await proof.closed.promise;
    const [chunks] = await Promise.all([collecting, revoked, mounted.join()]);
    await mounted.gateway.close();
    await proof.dispose();
    const final = proof.snapshot();
    console.info('NATIVE_CLOSE_RELEASE_FACTS', JSON.stringify(final));
    expect(terminal(chunks).reason.kind).toBe('error');
    expect(mounted.errors).toEqual([]);
    expect(mounted.starts).toBe(1);
    expect(mounted.trace.finishCalls).toHaveLength(1);
    expect(mounted.trace.finishErrors).toEqual([]);
    expect(await f.slots()).toBe(0);
    expect(await f.peer.observe(f.binding, caller.signal)).toMatchObject({
      active: 0,
      queued: 0,
      deferred: 0,
    });
    const rows = await f.modelA.attempts(f.claims[0]!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'model',
      protocol: 'opaque',
      dispatchObserved: true,
      httpStatus: null,
      outcome: 'canceled',
      terminal: null,
      usage: {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        cachedInputTokens: null,
        usageComplete: false,
        cacheUsageKnown: false,
      },
    });
    expect(final).toMatchObject({ calls: 1, requests: 1, eof: 0 });
    expect(final.connections.filter((row) => row.target)).toHaveLength(1);
    expect(final.connections.filter((row) => row.targetPeer)).toHaveLength(1);
    for (const row of final.connections) {
      const facts = row.facts;
      expect((facts.connector ?? 0) + (facts.accept ?? 0)).toBe(1);
      expect(facts.close).toBe(1);
      expect(facts.headers ?? 0).toBe(row.target ? 1 : 0);
      expect(facts.request ?? 0).toBe(row.targetPeer ? 1 : 0);
      expect(row.connectObserved).toBeLessThanOrEqual(facts.connector ?? 0);
      expect(row.peerMatches).toBeLessThanOrEqual(1);
    }
    const at = (kind: string) => {
      const matching = final.events.filter((event) => event.kind === kind);
      expect(matching, `exact real ${kind}`).toHaveLength(1);
      return matching[0]!.at;
    };
    at('send-headers');
    at('server-request');
    const close = at('local-close');
    const violations = ['slot-committed', 'permit-finished'].filter(
      (kind) => at(kind) < close,
    );
    expect(
      violations,
      'NATIVE_CLOSE_RELEASE_ORDER: ' + JSON.stringify(final.events),
    ).toEqual([]);
  });
});
