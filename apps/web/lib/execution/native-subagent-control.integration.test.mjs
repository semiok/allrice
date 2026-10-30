/* global process, Request, AbortController */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  assertNativeRunAuthority,
  authenticateSession,
  createSession,
  getNativeSubagentControl,
  releaseConversationRuntime,
  sendChatMessage,
} from '@allrice/database';
import * as client from '../../../../packages/database/src/core/client.ts';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
import { nativeBindingDescriptor } from '../../../../packages/database/src/native-session-binding.fixture.ts';
import { createEmployeeAdministrationFixture } from '../../../../packages/database/src/employee-administration.fixture.ts';
import { buildEmployeeRuntimePackage } from '../../../../packages/database/src/platform-employees/runtime-package.ts';
import { bindJobNativeSession } from '../../../../packages/database/src/execution/queue.ts';
import * as artifact from '../../../worker/src/harness/dsh-native-artifact.ts';
import { DshProtocolClient } from '../../../worker/src/harness/dsh-protocol-client.ts';
import { getHarnessRouter } from '../../../worker/src/harness/router.ts';
import { assertNativeControlScope } from '../../../worker/src/harness/dsh/run-scope.ts';
import { pollNativeSubagentControl } from '../../../worker/src/conversation/native-subagent-control.ts';
import {
  beginEmployeeConversationTurn,
  pollEmployeeConversationSteers,
} from '../../../worker/src/conversation/turn-lifecycle.ts';
import { createNativeRunDiagnosticsHttpHandler } from '../../../worker/src/native-run-diagnostics-http.ts';
import {
  gate,
  hold,
  host,
  text,
} from '../../../worker/test/native-subagent/fixture.mjs';

const cookie = vi.hoisted(() => ({ token: '' }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name) =>
      name === 'allrice_session' && cookie.token
        ? { value: cookie.token }
        : undefined,
  }),
}));
import {
  GET,
  POST,
} from '../../app/api/v1/sessions/[id]/subagents/controls/route';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'MET-230 C3 actual authenticated Web → PG → owning Worker → native controls',
  () => {
    let fixture, runtimePackage, directory;
    const residents = [],
      servers = [];
    beforeAll(async () => {
      fixture = await createRuntimeFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      directory = await realpath(
        await mkdtemp(join(tmpdir(), 'allrice-control-c3-')),
      );
      const employee = await createEmployeeAdministrationFixture(fixture.db);
      runtimePackage = buildEmployeeRuntimePackage({
        revision: 1,
        definition: {
          ...employee.definition,
          capabilities: {
            ...employee.definition.capabilities,
            nativeSkillIds: [],
          },
        },
        skills: [],
      });
      vi.spyOn(artifact, 'currentDshNativeLaunch');
    }, 120000);
    beforeEach(() => {
      for (const [key, value] of Object.entries({
        ALLRICE_RUNTIME_POLICY_ENABLED: '1',
        ALLRICE_DSH_NATIVE_ARTIFACT_ID: 'sha256:' + 'c'.repeat(64),
        ALLRICE_DSH_RUNTIME_ROOT: directory,
        ALLRICE_PORTAL_AUTH_ENABLED: '0',
        ALLRICE_LOCAL_PORTAL: 'unified',
      }))
        vi.stubEnv(key, value);
      // Same-generation local artifact location only; all reader/Host code is real.
      vi.mocked(artifact.currentDshNativeLaunch).mockReturnValue({
        generation: 'dsh-0.2.1-rc.2-687f282',
        args: [
          resolve(
            import.meta.dirname,
            '../../../worker/dsh/allrice-jsonrpc-runtime.mjs',
          ),
        ],
      });
    });
    afterEach(async () => {
      cookie.token = '';
      for (const [pool, id] of residents.splice(0))
        Reflect.get(pool, 'runtimes').delete(id);
      for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      }
    });
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    async function chat({
      model,
      questionMode,
      transport = async (send) => send(),
    } = {}) {
      const f = await createRunAuthorityFixture(fixture.db, {
        configure: false,
        memberRole: 'member',
        runtimePackage,
        businessCreationOrigin: true,
        allowedTools: runtimePackage.runtimeManifest.toolNames,
        runtimePolicy: {
          harness: 'dsh',
          provider: runtimePackage.runtimeManifest.provider,
          model: runtimePackage.runtimeManifest.model,
          reasoningEffort: 'xhigh',
          timeoutMs: 300000,
          fallbackModels: [],
          credentialReference: 'deployment:synthetic-never-resolved',
          baseUrl: null,
        },
      });
      await fixture.db`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
      const [row] =
        await fixture.db`select * from allrice_conversation_runtimes where session_id=${f.session}`;
      const descriptor = nativeBindingDescriptor({
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        contextKey: f.session,
      });
      descriptor.storageNamespace = join(
        directory,
        f.org,
        f.workspace,
        f.user,
        f.session,
        'sessions',
      );
      const bound = await bindJobNativeSession({
        workerId: f.worker.workerId,
        jobId: f.worker.jobId,
        leaseToken: f.worker.leaseToken,
        attempt: 1,
        subject: {
          kind: 'chat',
          id: f.session,
          configChecksum: row.config_checksum,
          generation: row.thread_generation,
          expectedThreadId: row.thread_id,
        },
        descriptor,
      });
      const worker = {
        ...f.worker,
        attempt: 1,
        generation: bound.conversation.generation,
      };
      const authority = { ...f.base, worker };
      const { token } = await createSession(f.user);
      const context = await authenticateSession(token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      const rootHold = gate(),
        facts = [];
      let runtime;
      const h = await host({
        rootId: descriptor.nativeSessionId,
        runId: f.rootRunId,
        accounting: true,
        questionMode,
        prepare: () =>
          vi.stubEnv('DSH_SESSION_ROOT', descriptor.storageNamespace),
        model: model
          ? (r, n) => model(r, n, descriptor.nativeSessionId)
          : async (r) => {
              if (r.sessionId === descriptor.nativeSessionId)
                await hold(r.signal, rootHold);
              return text('完成');
            },
        bridge: async (method, params) => {
          expect(params.runId).toBe(f.rootRunId);
          if (method === 'allrice/model-receipt') {
            facts.push(params);
            return {};
          }
          if (method === 'allrice/subagent-authorize') {
            assertNativeControlScope(runtime, params.scope);
            return assertNativeRunAuthority(authority);
          }
          expect(method).toBe('allrice/run-authorize');
          await assertNativeRunAuthority(authority);
          return { allowed: true };
        },
      });
      const adapter = getHarnessRouter().resolve('dsh'),
        pool = Reflect.get(adapter, 'runtimePool');
      const dispatched = [];
      // Replace stdio with an in-process pipe, preserving the real adapter scope
      // check, protocol DTO parsing, production Host and native public services.
      runtime = {
        id: randomUUID(),
        sessionId: descriptor.nativeSessionId,
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        productSessionId: f.session,
        nativePin: bound.binding,
        nativeGeneration: worker.generation,
        executionObservation: {
          runId: f.rootRunId,
          jobId: worker.jobId,
          attempt: 1,
          generation: worker.generation,
        },
        client: {
          steer: DshProtocolClient.prototype.steer.bind({
            request: (method, params) => h.server.handleRequest(method, params),
          }),
          nativeSubagentControl:
            DshProtocolClient.prototype.nativeSubagentControl.bind({
              runId: f.rootRunId,
              request: (method, params) => {
                dispatched.push(params);
                return transport(
                  () => h.server.handleRequest(method, params),
                  params,
                );
              },
            }),
        },
      };
      Reflect.get(pool, 'runtimes').set(runtime.sessionId, runtime);
      residents.push([pool, runtime.sessionId]);
      let open = true;
      const revoke = vi.fn();
      const poll = (overrides = {}) =>
        pollNativeSubagentControl({
          authority,
          ownerId: f.user,
          sessionId: f.session,
          adapter,
          open: () => open,
          revoke,
          ...overrides,
        });
      const close = async () => {
        open = false;
        await releaseConversationRuntime({
          organizationId: f.org,
          workspaceId: f.workspace,
          sessionId: f.session,
          runId: f.rootRunId,
          workerId: worker.workerId,
          outcome: 'idle',
        });
      };
      const read = (id) => getNativeSubagentControl(context, f.session, id);
      const input = (child, message, delivery = 'queue') => ({
        requestId: randomUUID(),
        parentSessionId: h.root.id,
        childSessionId: child.childId,
        mode: 'continuable',
        ...(message === undefined
          ? { kind: 'interrupt' }
          : { kind: 'prompt', delivery, content: text(message) }),
      });
      async function request(method, value, headerOverrides = {}) {
        cookie.token = token;
        const url =
          `http://localhost/api/v1/sessions/${f.session}/subagents/controls?workspaceId=${f.workspace}` +
          (method === 'GET' ? `&requestId=${value}` : '');
        return (method === 'GET' ? GET : POST)(
          new Request(url, {
            method,
            headers: {
              host: 'localhost',
              origin: 'http://localhost',
              'x-allrice-organization-id': f.org,
              'x-allrice-workspace-id': f.workspace,
              ...headerOverrides,
            },
            ...(method === 'POST'
              ? {
                  body: JSON.stringify({
                    rootRunId: f.rootRunId,
                    generation: worker.generation,
                    input: value,
                  }),
                }
              : {}),
          }),
          { params: Promise.resolve({ id: f.session }) },
        );
      }
      return {
        ...f,
        authority,
        worker,
        descriptor,
        runtime,
        context,
        token,
        h,
        rootHold,
        facts,
        adapter,
        dispatched,
        revoke,
        poll,
        close,
        read,
        input,
        request,
      };
    }
    async function reader() {
      const handler = createNativeRunDiagnosticsHttpHandler();
      const server = createServer(async (req, res) => {
        if (!(await handler(req, res))) {
          res.writeHead(404);
          res.end();
        }
      });
      servers.push(server);
      await new Promise((done) => server.listen(0, '127.0.0.1', done));
      vi.stubEnv(
        'ALLRICE_WORKER_INTERNAL_URL',
        `http://127.0.0.1:${server.address().port}`,
      );
    }
    const accepted = async (f, id) => {
      await expect
        .poll(async () => (await f.read(id)).ticket.result.status)
        .toBe('accepted');
      return (await f.read(id)).ticket;
    };
    async function counts(f) {
      const [row] = await fixture.db`select
      (select count(*) from allrice_runs where organization_id=${f.org}) runs,
      (select count(*) from allrice_jobs where organization_id=${f.org}) jobs,
      (select count(*) from allrice_messages where session_id=${f.session}) messages,
      (select count(*) from allrice_conversation_followups where session_id=${f.session}) followups`;
      return row;
    }

    it.each(['queue', 'steer'])(
      '“给完成的子任务补上上海” carries %s once through the real entrypoints',
      async (delivery) => {
        const f = await chat();
        await f.h.prompt('等我补充材料。');
        const child = await f.h.spawn();
        await child.result;
        const command = f.input(child, '请加上上海。', delivery),
          before = await counts(f);
        const post = await f.request('POST', command);
        expect(post.status).toBe(202);
        expect((await post.json()).ticket.result).toEqual({
          status: 'recorded',
        });
        expect(await f.poll()).toBe(true);
        const receipt = await accepted(f, command.requestId);
        expect(receipt.result).toMatchObject({
          source: { kind: 'native_ack' },
          acceptance: { kind: 'prompt', messageId: expect.any(String) },
        });
        expect((await f.request('POST', command)).status).toBe(200);
        expect(await f.poll()).toBe(false);
        const response = await f.request('GET', command.requestId),
          dto = await response.json();
        expect(dto).toEqual({ ticket: receipt });
        expect(JSON.stringify(dto)).not.toContain(
          f.descriptor.storageNamespace,
        );
        expect(JSON.stringify(dto)).not.toContain(f.worker.leaseToken);
        expect(f.dispatched).toHaveLength(1);
        expect(await counts(f)).toEqual(before);
        f.rootHold.resolve();
        await f.h.wait();
        const observed = await f.h.ctx.sessionQuery.observeSession(
          child.childId,
        );
        try {
          expect(
            observed.events
              .slice(observed.inheritedEventCount)
              .filter(
                (e) =>
                  e.type === 'user/message' &&
                  e.data.source.rpcId === command.requestId,
              ),
          ).toMatchObject([
            {
              data: {
                id: receipt.result.acceptance.messageId,
                content: text('请加上上海。'),
              },
            },
          ]);
        } finally {
          observed[Symbol.dispose]();
        }
        expect(f.facts.length).toBeGreaterThan(0);
        expect(
          f.facts.every(
            (fact) =>
              fact.runId === f.rootRunId && fact.rootSessionId === f.h.root.id,
          ),
        ).toBe(true);
      },
    );

    it('a cold child admission does not block the existing root question pump or another child Stop', async () => {
      const creating = gate(),
        cold = gate(),
        finish = gate();
      let rootCalls = 0,
        blockChildren = false;
      const f = await chat({
        questionMode: 'legacy',
        model: async (r, _n, root) => {
          if (r.sessionId === root && ++rootCalls === 1)
            return [
              {
                type: 'tool-call',
                id: 'ask',
                name: 'ask_user_question',
                arguments: JSON.stringify({
                  questions: [
                    {
                      id: 'go',
                      question: '继续吗？',
                      options: [{ label: '继续' }],
                    },
                  ],
                }),
              },
            ];
          if (r.sessionId === root || blockChildren)
            await hold(r.signal, finish);
          return text('完成');
        },
      });
      await f.h.prompt('先问我，允许单独给子任务补材料。');
      await expect
        .poll(() => f.h.server.pendingUserQuestions.has(f.h.root.id))
        .toBe(true);
      const question = f.h.server.pendingUserQuestions.get(f.h.root.id);
      const a = await f.h.spawn();
      await a.result;
      blockChildren = true;
      const b = await f.h.spawn();
      const dispose = f.h.ctx.on('agent/created', async ({ agent, signal }) => {
        if (agent.id === a.childId) {
          creating.resolve();
          await hold(signal, cold);
        }
      });
      const turnId = `${f.h.root.id}:turn:1`;
      const ownership = {
        organizationId: f.org,
        workspaceId: f.workspace,
        sessionId: f.session,
        runId: f.rootRunId,
        workerId: f.worker.workerId,
      };
      await beginEmployeeConversationTurn({
        ownership,
        adapterKind: 'dsh',
        threadId: f.h.root.id,
        turnId,
        appendEvent: async (
          event_type,
          payload,
        ) => fixture.db`insert into allrice_run_events
        (organization_id,workspace_id,run_id,sequence,event_type,payload)
        values(${f.org},${f.workspace},${f.rootRunId},1,${event_type},${fixture.db.json(payload)})`,
      });
      const prompt = f.input(a, '补充冷子任务');
      await f.request('POST', prompt);
      let polling = true;
      const loop = pollEmployeeConversationSteers({
        ownership,
        generation: f.worker.generation,
        threadId: f.h.root.id,
        turnId,
        signal: new AbortController().signal,
        adapter: f.adapter,
        polling: () => polling,
        pollNativeControl: f.poll,
      });
      try {
        await creating.promise;
        const stop = f.input(b);
        await f.request('POST', stop);
        const answer = await sendChatMessage(
          f.context,
          f.workspace,
          f.session,
          {
            clientMessageId: randomUUID(),
            text: '继续',
            deliveryMode: 'steer',
            expectedTurnId: turnId,
            expectedGeneration: f.worker.generation,
            userQuestionAnswer: {
              questionId: question.questionId,
              answers: [{ id: 'go', selected: ['继续'] }],
            },
          },
        );
        expect(answer.delivery).toBe('steer_pending');
        await accepted(f, stop.requestId);
        await b.result;
        await expect.poll(() => rootCalls).toBe(2);
        expect(f.h.server.pendingUserQuestions.has(f.h.root.id)).toBe(false);
        expect((await f.read(prompt.requestId)).ticket.result.status).toBe(
          'unknown',
        );
        await expect
          .poll(async () => {
            const [row] =
              await fixture.db`select state from allrice_conversation_commands
          where session_id=${f.session} and command_type='steer'`;
            return row.state;
          })
          .toBe('consumed');
        cold.resolve();
        await accepted(f, prompt.requestId);
      } finally {
        polling = false;
        cold.resolve();
        finish.resolve();
        await loop;
        dispose();
        await f.h.wait();
      }
    });

    it('“只停 A” does not stop the parent or B and never repeats a lost interrupt ACK', async () => {
      const all = gate();
      const f = await chat({
        model: async (r) => {
          await hold(r.signal, all);
          return text('完成');
        },
        transport: async (send) => {
          await send();
          throw Error('DSH_REQUEST_TIMEOUT');
        },
      });
      await f.h.prompt('两个子任务都继续。');
      const a = await f.h.spawn(),
        b = await f.h.spawn();
      await expect.poll(() => f.h.calls.length).toBe(3);
      const command = f.input(a);
      expect((await f.request('POST', command)).status).toBe(202);
      await f.poll();
      await a.result;
      await expect
        .poll(
          async () => (await f.read(command.requestId)).ticket.result.status,
        )
        .toBe('unknown');
      expect(f.h.root.status).toBe('running');
      expect(f.h.ctx.agents.get(b.childId).status).toBe('running');
      await reader();
      expect(
        (await (await f.request('GET', command.requestId)).json()).ticket
          .result,
      ).toEqual({ status: 'unknown' });
      expect(await f.poll()).toBe(false);
      expect(f.dispatched).toHaveLength(1);
      all.resolve();
      await f.h.wait();
    });

    it('recovers a lost prompt ACK from the frozen own suffix after root closure without redispatch', async () => {
      const f = await chat({
        transport: async (send) => {
          await send();
          throw Error('lost ACK');
        },
      });
      await f.h.prompt('等我补充材料。');
      const child = await f.h.spawn();
      await child.result;
      const command = f.input(child, '真实补充内容');
      await f.request('POST', command);
      await f.poll();
      await expect
        .poll(
          async () => (await f.read(command.requestId)).ticket.result.status,
        )
        .toBe('unknown');
      f.rootHold.resolve();
      await f.h.wait();
      await f.close();
      await reader();
      const recovered = await (
        await f.request('GET', command.requestId)
      ).json();
      expect(recovered.ticket.result).toMatchObject({
        status: 'accepted',
        acceptance: { kind: 'prompt', messageId: expect.any(String) },
        source: {
          kind: 'user_rpc',
          rpcId: command.requestId,
          sequence: expect.any(Number),
        },
      });
      expect(f.dispatched).toHaveLength(1);
      expect(await f.poll()).toBe(false);
    });

    it('records a late positive ACK only on the original ticket after close', async () => {
      const ack = gate(),
        arrived = gate();
      const f = await chat({
        transport: async (send) => {
          const value = await send();
          arrived.resolve();
          await ack.promise;
          return value;
        },
      });
      await f.h.prompt('保留本轮归属。');
      const child = await f.h.spawn();
      await child.result;
      const command = f.input(child, '补充');
      await f.request('POST', command);
      await f.poll();
      await arrived.promise;
      f.rootHold.resolve();
      await f.h.wait();
      await f.close();
      expect((await f.read(command.requestId)).ticket.result).toEqual({
        status: 'unknown',
      });
      ack.resolve();
      const ticket = await accepted(f, command.requestId);
      expect(ticket.result.source.kind).toBe('native_ack');
      expect((await f.read(command.requestId)).request.scope.rootRunId).toBe(
        f.rootRunId,
      );
      expect(f.dispatched).toHaveLength(1);
    });

    it('rejects stale identity locally, real lease revocation fail closed, and idle POST creates no Host or execution', async () => {
      const f = await chat();
      await f.h.prompt('保持根运行。');
      const child = await f.h.spawn();
      await child.result;
      const wrong = {
        ...f.input(child, '不能发给伪父'),
        parentSessionId: 'not-the-parent',
      };
      await f.request('POST', wrong);
      await f.poll();
      await expect
        .poll(async () => (await f.read(wrong.requestId)).ticket.result)
        .toEqual({
          status: 'rejected',
          code: 'NATIVE_CONTROL_CHILD_UNVERIFIED',
        });
      expect(f.revoke).not.toHaveBeenCalled();
      expect(f.h.root.status).toBe('running');
      const valid = f.input(child, '租约撤销后不能发送');
      await f.request('POST', valid);
      await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
      await expect(f.poll()).rejects.toThrow(
        'final_delivery_evidence_unavailable',
      );
      expect(f.revoke).toHaveBeenCalledTimes(1);
      expect(f.dispatched).toHaveLength(1);
      f.rootHold.resolve();
      await f.h.wait();
      await f.close();
      const before = await counts(f);
      expect(
        (await f.request('POST', f.input(child, '结束后不重启'))).status,
      ).toBe(409);
      expect(await counts(f)).toEqual(before);
      expect(
        (
          await f.request('POST', f.input(child), {
            origin: 'https://attacker.example',
          })
        ).status,
      ).toBe(403);
    });
  },
);
