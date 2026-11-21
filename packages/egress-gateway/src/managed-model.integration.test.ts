/** Concrete egress -> model gateway -> PG admission -> native DSH/loopback SSE.
 * VM runtime/disk and trusted execution registry are explicit fixture owners.
 * No live model, secrets, private producer SQL or guest-supplied identity. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PersonVmService,
  PostgresPersonVmStore,
  type PersonVmAdmissionBoundary,
  type PersonVmAdmissionPermit,
} from '@allrice/person-vm';
import {
  createModelGateway,
  createPostgresModelGatewayStore,
  GatewayLlmAdapter,
  ModelGatewayError,
  type ModelCallBinding,
  type ModelGatewayPort,
} from '@allrice/model-gateway';
import { context, harness } from '../../person-vm/src/test-support.ts';
import { assertRuntimeFixtureDatabase } from '../../database/src/runtime-fixture-database.ts';
import {
  deferred,
  freshCall,
  modelBinding,
} from '../../model-gateway/src/gateway.fixture.ts';
import { responsesFixture } from '../../model-gateway/src/revision.fixture.ts';
import { createEgressGateway } from './gateway.ts';
import type { GuestEgressAccess } from './contract.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'n2 managed model composition through egress and formal PG admission',
  () => {
    let admin: postgres.Sql, schema: string, cancel: AbortController;
    const clients = new Set<postgres.Sql>();
    const close: (() => Promise<unknown>)[] = [];
    beforeEach(async () => {
      cancel = new AbortController();
      const url = process.env.ALLRICE_TEST_DATABASE_URL!;
      assertRuntimeFixtureDatabase(new URL(url));
      admin = postgres(url, { max: 1, onnotice: () => {} });
      schema = 'n2_managed_' + randomUUID().replaceAll('-', '');
      await admin.unsafe(`create schema "${schema}"`);
      const db = open();
      for (const file of [
        '0247_person_virtual_machines.sql',
        '0248_model_gateway_attempts.sql',
        '0250_person_vm_admission.sql',
      ])
        await db.unsafe(
          await readFile(
            new URL('../../database/migrations/' + file, import.meta.url),
            'utf8',
          ),
        );
    });
    afterEach(async () => {
      cancel.abort();
      const results = [];
      for (const fn of close.splice(0).reverse())
        results.push(...(await Promise.allSettled([fn()])));
      await Promise.all([...clients].map((db) => db.end({ timeout: 0 })));
      clients.clear();
      await admin.unsafe(`drop schema "${schema}" cascade`);
      await admin.end({ timeout: 0 });
      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
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
      const rc = context();
      const ports = harness(new PostgresPersonVmStore(open));
      const native = await responsesFixture();
      close.push(() => native.close());
      let access!: GuestEgressAccess;
      let model!: ModelGatewayPort;
      const portProbe = createServer();
      await new Promise<void>((resolve) =>
        portProbe.listen(0, '127.0.0.1', resolve),
      );
      const port = (portProbe.address() as { port: number }).port;
      await new Promise<void>((resolve) => portProbe.close(() => resolve()));
      const vm = new PersonVmService({
        ...ports.options,
        egress: {
          prepare: (...args) => egress.prepare(...args),
          assertActive: (...args) => egress.assertActive(...args),
          revoke: (...args) => egress.revoke(...args),
        },
      });
      const host = vm.createAdmissionHost({ openSql: open });
      const permits: PersonVmAdmissionPermit[] = [];
      const waiting = deferred();
      let waitedSignal: AbortSignal | undefined;
      let egressClaims = 0,
        handled = 0,
        checked = 0;
      const ended = new Set<PersonVmAdmissionPermit>();
      const boundary: PersonVmAdmissionBoundary = {
        admit: async (...args) => {
          const p = await host.admit(...args);
          permits.push(p);
          return p;
        },
        queued: (...args) => host.queued(...args),
        activate: (...args) => host.activate(...args),
        waitUntilReady: (...args) => {
          waitedSignal = args[2];
          waiting.resolve();
          return host.waitUntilReady(...args);
        },
        finish: async (p) => {
          await host.finish(p);
          ended.add(p);
        },
      };
      const issued = new Map<string, ModelCallBinding>();
      const calls: ModelCallBinding[] = [];
      let invalidIdentity = false;
      const egress = createEgressGateway({
        vm,
        admission: {
          ...boundary,
          admit: (...args) => {
            egressClaims++;
            return boundary.admit(...args);
          },
        },
        authority: { context: async () => rc, allow: async () => {} },
        policy: { routes: [] },
        transport: {
          read: async () => {
            throw Error('managed model must not use read transport');
          },
        },
        revokeModel: async (binding) => {
          if (model) await model.revoke(binding);
        },
        services: [
          {
            id: 'model',
            path: '/v1/stream',
            method: 'POST',
            admissionOwner: 'service',
            async handle(request, response, trusted, signal) {
              expect(request.headers.authorization).toBeUndefined();
              handled++;
              const call = freshCall({
                ...modelBinding(
                  trusted.binding.personId,
                  trusted.binding.organizationId,
                ),
                context: trusted.context,
                vm: trusted.binding,
                provider: native.binding.provider,
                model: native.binding.model,
              });
              issued.set(call.native.callId, structuredClone(call));
              calls.push(call);
              // Mutate only the trusted fixture's execution envelope to prove that
              // local capability does not substitute complete assertCall identity.
              await model.handle(
                request,
                response,
                invalidIdentity
                  ? {
                      ...call,
                      execution: {
                        ...call.execution,
                        executionId: randomUUID(),
                      },
                    }
                  : call,
                signal,
              );
            },
          },
        ],
        provisioner: {
          endpoint: async () => ({
            host: '127.0.0.1',
            port,
            guestOrigin: `http://127.0.0.1:${port}`,
          }),
          install: async (_b, value) => {
            access = value;
          },
          remove: async () => {},
        },
      });
      await vm.prewarm(rc, { trigger: 'page' }, cancel.signal);
      const binding = await vm.resolve(rc, cancel.signal);
      const receipt = await egress.prepare(binding, cancel.signal);
      const store = createPostgresModelGatewayStore(open());
      model = createModelGateway({
        ownerId: randomUUID(),
        store,
        provider: native.provider,
        admission: { boundary, participant: host.participant('gateway') },
        authority: {
          async assertCall(call, signal) {
            checked++;
            if (
              JSON.stringify(issued.get(call.native.callId)) !==
              JSON.stringify(call)
            )
              throw new ModelGatewayError('BINDING_INVALID');
            await vm.assertAdmissionBinding(call.context, call.vm, signal);
          },
          authorizeUsage: async (c) => ({
            personId: c.actor.id,
            organizationId: c.organizationId,
          }),
          confirmOwnerStopped: async () => {
            throw new ModelGatewayError('AUTHORIZATION_DENIED');
          },
        },
      });
      close.push(() => model.close());
      close.push(() =>
        egress.revoke(receipt, 'stop', new AbortController().signal),
      );
      async function post(
        capability: string | null = access.capability,
        signal = cancel.signal,
      ) {
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'x-allrice-model-contract': '1',
        };
        if (capability !== null) headers.authorization = 'Bearer ' + capability;
        const response = await fetch(access.origin + '/v1/stream', {
          method: 'POST',
          headers,
          signal,
          body: JSON.stringify({
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: 'Synthetic n2 request' }],
              },
            ],
          }),
        });
        return { status: response.status, body: await response.text() };
      }
      return {
        vm,
        rc,
        host,
        binding,
        permits,
        ended,
        waiting,
        calls,
        native,
        store,
        post,
        get egressClaims() {
          return egressClaims;
        },
        get handled() {
          return handled;
        },
        get checked() {
          return checked;
        },
        get waitedSignal() {
          return waitedSignal;
        },
        invalidateIdentity() {
          invalidIdentity = true;
        },
        async collect() {
          const adapter = new GatewayLlmAdapter(
            access.origin + '/v1/stream',
            access.capability,
          );
          const chunks = [];
          for await (const c of adapter.stream({
            provider: 'host-gateway',
            model: 'fixture-model',
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: 'Synthetic n2 request' }],
              },
            ],
            signal: cancel.signal,
          }))
            chunks.push(c);
          return chunks;
        },
        async freeze() {
          const lease = await host.issue(rc, binding, cancel.signal);
          await host.participant('gateway').freeze(lease, cancel.signal);
          await host.participant('entry').freeze(lease, cancel.signal);
          return lease;
        },
      };
    }
    it.each([null, 'wrong-capability'])(
      'rejects missing/wrong local capability %s before model admission',
      async (capability) => {
        const f = await setup();
        expect((await f.post(capability)).status).toBe(403);
        expect(f.handled).toBe(0);
        expect(f.permits).toHaveLength(0);
        expect(f.native.requests).toHaveLength(0);
      },
    );
    it('native adapter capability traverses actual gateways, persists raw usage, claims only model permit', async () => {
      const f = await setup();
      const chunks = await f.collect();
      expect(chunks.some((c) => c.type === 'text-delta')).toBe(true);
      expect(chunks.at(-1)?.type).toBe('finish');
      expect(f.checked).toBeGreaterThan(0);
      expect(f.handled).toBe(1);
      expect(f.egressClaims).toBe(0);
      expect(f.permits).toHaveLength(1);
      expect(f.ended.size).toBe(1);
      expect(f.native.requests).toHaveLength(1);
      const usage = await f.store.usage(
        f.binding.personId,
        f.binding.organizationId,
      );
      expect(usage).toBeDefined();
      expect(
        await f.host.participant('gateway').observe(f.binding, cancel.signal),
      ).toMatchObject({ state: 'known', active: 0, queued: 0, deferred: 0 });
    });
    it('valid capability cannot bypass full execution identity', async () => {
      const f = await setup();
      f.invalidateIdentity();
      const response = await f.post();
      expect(response.status).toBe(403);
      expect(response.body).toContain('BINDING_INVALID');
      expect(f.permits).toHaveLength(0);
      expect(f.native.requests).toHaveLength(0);
    });
    it('frozen model waits for exact dual release; old call requires rebind, separately authorized fresh call succeeds', async () => {
      const f = await setup();
      const lease = await f.freeze();
      const pending = f.post();
      expect(
        await Promise.race([
          f.waiting.promise.then(() => 'waiting'),
          pending.then(() => 'returned'),
        ]),
      ).toBe('waiting');
      expect(f.permits.map((p) => p.disposition)).toEqual(['deferred']);
      expect(f.native.requests).toHaveLength(0);
      await f.host.participant('gateway').thaw(lease, cancel.signal);
      expect(
        await f.host.participant('gateway').observe(f.binding, cancel.signal),
      ).toMatchObject({ deferred: 1, active: 0 });
      await f.host.participant('entry').thaw(lease, cancel.signal);
      const old = await pending;
      expect(old.status).toBe(200);
      expect(old.body).toContain('EXECUTION_REBIND_REQUIRED');
      expect(f.native.requests).toHaveLength(0);
      expect((await f.post()).status).toBe(200);
      expect(f.native.requests).toHaveLength(1);
      expect(f.calls[0]!.native.callId).not.toBe(f.calls[1]!.native.callId);
      expect(f.permits.map((p) => p.disposition)).toEqual([
        'deferred',
        'queued',
      ]);
      expect(f.egressClaims).toBe(0);
    });
    it('user cancellation in frozen managed chain joins without dispatch', async () => {
      const f = await setup();
      await f.freeze();
      const caller = new AbortController();
      const pending = f.post(undefined, caller.signal);
      void pending.catch(() => {});
      await f.waiting.promise;
      caller.abort();
      await expect(pending).rejects.toThrow();
      await expect.poll(() => f.waitedSignal?.aborted).toBe(true);
      await expect.poll(() => f.ended.size).toBe(1);
      expect(f.native.requests).toHaveLength(0);
      expect(f.egressClaims).toBe(0);
    });
  },
);
