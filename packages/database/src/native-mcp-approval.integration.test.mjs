import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import postgres from 'postgres';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { NativeActionApprovalResultSchema } from '@allrice/contracts';
import { createMcpExecutionFixture } from './mcp-execution.fixture.ts';
import {
  createMcpOperationLedger,
  getNativeMcpApprovalTarget,
} from './mcp-execution.ts';
import { assertRuntimeFixtureDatabase } from './runtime-fixture-database.ts';
import {
  runtimePolicyDigest,
  setRuntimePolicyControls,
} from './runtime-policy.ts';
import { updateWorkAutomation } from './work-automation.ts';
import {
  listCloudRuntimeOperations,
  cancelCloudRuntimeRun,
} from './cloud-operation-view.ts';
import * as TaskClock from './task-clock.ts';
import { mcpStableId } from './mcp-authority.ts';
import {
  host,
  text,
  gate,
  hold,
} from '../../../apps/worker/test/native-subagent/fixture.mjs';
import { dshInboundToolHandler } from '../../../apps/worker/src/harness/dsh/tool-bridge.ts';
import { executeRiceTool } from '../../../apps/worker/src/tool-broker.ts';
import * as McpExecutor from '../../../apps/worker/src/mcp/executor.ts';
import { createNativeActionApprovalHttpHandler } from '../../../apps/worker/src/native-action-approval-http.ts';
import { createMcpTransport } from '../../../apps/worker/src/mcp/transport.ts';
import { POST as stopCloudOperations } from '../../../apps/web/app/api/v1/runtime/cloud-operations/route.ts';

/* global process, URL, fetch, Request */

// Real PostgreSQL, production DSH approval, Broker and owned MCP HTTP. Only
// the model, login/session-pin issuer and fixed service identity are fixtures;
// this is not real-model, public HTTPS or browser acceptance.
let db, admin;
const identity = vi.hoisted(() => ({ current: null }));
const login = vi.hoisted(() => ({
  context: null,
  token: 'synthetic_session_token_248',
}));
vi.mock('../../../apps/web/lib/identity/session', () => ({
  requireRequestContext: async () => login.context,
  sessionCookieName: 'synthetic_session',
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: login.token }) }),
}));
vi.mock('./mcp-owned-records-service.ts', () => ({
  ownedRecordsServiceIdentity: () => identity.current,
}));
vi.mock('./core/client.ts', async (original) => ({
  ...(await original()),
  getDatabase: () => db,
}));
const schema = `native_mcp_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const services = [];
const execute = McpExecutor.runMcpRuntimeOperation;

async function fixture() {
  identity.current = null;
  const f = await createMcpExecutionFixture(db);
  services.push(f.service);
  const tool = f.mcpTools.find((t) => t.name === 'records.append');
  identity.current = { endpoint: f.service.endpoint, toolDigest: tool.digest };
  return f;
}
const answer = (request, decision = 'approved') => ({
  contractVersion: 1,
  direction: 'response',
  kind: 'action_approval',
  requestId: request.requestId,
  version: request.version,
  requestDigest: request.requestDigest,
  task: request.task,
  responseId: randomUUID(),
  respondedBy: request.respondentId,
  respondedAt: new Date().toISOString(),
  approvalId: request.approvalId,
  decision,
});
function syntheticPort(decision = 'approved', live = true) {
  return {
    request: async (request) =>
      NativeActionApprovalResultSchema.parse({
        request,
        response: answer(request, decision),
        outcome: decision === 'approved' ? 'allowed-once' : 'rejected',
      }),
    assertLive: async () => {
      if (!live) throw Error('NATIVE_ACTION_NOT_LIVE');
    },
  };
}
async function operation(f, id) {
  const [row] =
    await db`select snapshot from allrice_runtime_operations where id=${id} and organization_id=${f.org} and workspace_id=${f.workspace}`;
  return row.snapshot;
}
async function approvalCount(id) {
  const [row] =
    await db`select count(*)::int as n from allrice_approval_requests where resource_id=${id}`;
  return row.n;
}

suite('MET-248 native approval → exact owned append', () => {
  beforeAll(async () => {
    const base = process.env.ALLRICE_TEST_DATABASE_URL;
    if (!base) throw Error('explicit test database required');
    const url = new URL(base);
    assertRuntimeFixtureDatabase(url);
    admin = postgres(url.toString(), { max: 1, onnotice() {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(20260907,1)`;
      await tx`create extension if not exists vector with schema public`;
      await tx`create extension if not exists pg_trgm with schema public`;
    });
    await admin.unsafe(`create schema "${schema}"`);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    db = postgres(url.toString(), { max: 12, onnotice() {} });
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(directory))
      .filter((f) => f.endsWith('.sql'))
      .sort())
      await db.unsafe(await readFile(new URL(file, directory), 'utf8'));
  }, 120000);
  beforeEach(() => {
    vi.stubEnv('ALLRICE_CLOUD_MCP_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.stubEnv('ALLRICE_MCP_CREDENTIAL_KEY', 'af'.repeat(32));
    vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', `sha256:${'a'.repeat(64)}`);
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', `sha256:${'a'.repeat(64)}`);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    for (const service of services) await service.close();
    await db?.end({ timeout: 5 });
    if (admin && /^native_mcp_[a-f0-9]{32}$/.test(schema))
      await admin.unsafe(`drop schema "${schema}" cascade`);
    await admin?.end({ timeout: 5 });
  });

  it.each([
    { decision: 'approved', automation: true },
    { decision: 'rejected', automation: false },
    { decision: 'cancelled', automation: true },
    { decision: 'cancel_after_start', automation: true },
  ])(
    '“向记录服务只追加 S-Q2”：real Worker entry, native $decision and member automation=$automation',
    async ({ decision, automation }) => {
      const f = await fixture();
      login.context = f.context;
      if (automation)
        await updateWorkAutomation(
          f.context,
          f.workspace,
          { expectedRevision: 2, capability: 'cloud', enabled: true },
          db,
        );
      const [employeeRun] =
        await db`select user_message_id from allrice_employee_runs where run_id=${f.run}`;
      const userText = '向验收记录服务只追加一条 S-Q2，不要做其他修改。';
      await db`update allrice_messages set content=${db.json({ text: userText, citations: [] })} where id=${employeeRun.user_message_id}`;
      const args = { ...f.args, arguments: { value: 'S-Q2' } };
      const callId = 'append-from-user',
        operationId = mcpStableId(`mcp-call:${f.run}:${callId}`);
      // Inject only the fixture HTTP transport into the real executor. All
      // admission, lease, START, receipt and DB writes remain production code.
      const spy = vi
        .spyOn(McpExecutor, 'runMcpRuntimeOperation')
        .mockImplementation((created, options) =>
          execute(created, {
            ...options,
            database: db,
            store: f.store,
            transport:
              decision === 'cancel_after_start' ? heldTransport : f.transport,
          }),
        );
      const releaseReply = gate();
      const heldTransport = createMcpTransport({
        fetchOverride: async (input, init) => {
          const response = await f.service.fetchOverride(input, init);
          if (f.service.state.calls > 0) {
            const signal =
              init?.signal ??
              (input instanceof Request ? input.signal : undefined);
            if (!signal)
              throw Error('fixture requires the real execution signal');
            await hold(signal, releaseReply);
          }
          return response;
        },
      });
      let h;
      const inbound = dshInboundToolHandler(
        {
          tools: [
            {
              name: 'cloud.mcp.call',
              description: 'owned fixture',
              inputSchema: {},
            },
          ],
          onToolCall: (call) =>
            executeRiceTool({
              context: f.execution,
              capabilities: f.snapshot.capabilitySnapshot.grantedCapabilities,
              frozenMcpTools: f.mcpTools,
              storageRoot: h.directory,
              sessionId: f.session,
              userMessageId: employeeRun.user_message_id,
              userRequest: userText,
              call,
            }),
        },
        (call) => ({
          request: async (request) =>
            NativeActionApprovalResultSchema.parse(
              await h.server.handleRequest('native-action/request', {
                sessionId: h.root.id,
                callId: call.id,
                request,
              }),
            ),
          assertLive: async (requestId) => {
            await h.server.handleRequest('native-action/verify', {
              sessionId: h.root.id,
              callId: call.id,
              requestId,
            });
          },
        }),
      );
      h = await host({
        productionProfile: 'allrice-restricted',
        runId: f.run,
        nativeTools: ['cloud.mcp.call'],
        bridge: (method, params) =>
          method === 'allrice/run-authorize'
            ? { allowed: true }
            : inbound(method, params),
        model: async (_request, n) =>
          n === 1
            ? [
                {
                  type: 'tool-call',
                  id: callId,
                  name: 'cloud_mcp_call',
                  arguments: JSON.stringify(args),
                },
              ]
            : text('完成'),
      });
      const token = login.token;
      const target = {
        workerId: f.worker,
        rootSessionId: h.root.id,
        generation: 1,
      };
      const handler = createNativeActionApprovalHttpHandler({
        authenticate: async (provided, tenant) =>
          provided === token &&
          tenant.organizationId === f.org &&
          tenant.workspaceId === f.workspace
            ? f.context
            : null,
        target: (context, id) => getNativeMcpApprovalTarget(context, id, db),
        sessionTarget: async () => target,
        exchange: async (_target, { action, ...query }) =>
          h.server.handleRequest(`native-action/${action}`, {
            ...query,
            sessionId: h.root.id,
          }),
      });
      const server = createServer((req, res) => {
        void handler(req, res).then((handled) => {
          if (!handled) res.end();
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const endpoint = `http://127.0.0.1:${server.address().port}/internal/native-action-approval`;
      vi.stubEnv('ALLRICE_WORKER_INTERNAL_URL', endpoint);
      const http = (action, response, bearer = token) =>
        fetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${bearer}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            organizationId: f.org,
            workspaceId: f.workspace,
            approvalId: operationId,
            action,
            ...(response ? { response } : {}),
          }),
        });
      try {
        await h.prompt(userText);
        let pending;
        await expect
          .poll(
            async () => {
              const response = await http('read');
              if (response.status === 200) pending = await response.json();
              return response.status;
            },
            { timeout: 10000 },
          )
          .toBe(200);
        expect(await approvalCount(operationId)).toBe(0); // no shadow PG wait
        expect((await operation(f, operationId)).status).toBe('waiting_user');
        const views = await listCloudRuntimeOperations(f.context, f.run, db);
        expect(views[0].proposal).toMatchObject({
          endpoint: f.service.endpoint,
          tool: 'records.append',
          arguments: { value: 'S-Q2' },
        });
        expect(f.service.state.rows).toEqual([]);
        expect(
          (
            await http(
              'answer',
              answer(pending.request),
              'wrong_synthetic_token',
            )
          ).status,
        ).toBe(401);
        expect(
          (
            await http('answer', {
              ...answer(pending.request),
              requestDigest: runtimePolicyDigest('wrong'),
            })
          ).status,
        ).toBe(409);
        const waiting = h.wait();
        if (decision === 'cancelled' || decision === 'cancel_after_start') {
          if (decision === 'cancel_after_start') {
            expect((await http('answer', answer(pending.request))).status).toBe(
              200,
            );
            await expect.poll(() => f.service.state.calls).toBe(1);
            expect((await operation(f, operationId)).status).toBe('running');
          }
          const stopped = await stopCloudOperations(
            new Request(
              `http://allrice.test/api/v1/runtime/cloud-operations?workspaceId=${f.workspace}`,
              {
                method: 'POST',
                headers: {
                  origin: 'http://allrice.test',
                  'content-type': 'application/json',
                },
                body: JSON.stringify({ action: 'cancel', runId: f.run }),
              },
            ),
          );
          expect(stopped.status).toBe(200);
          expect((await http('answer', answer(pending.request))).status).toBe(
            409,
          );
        } else
          expect(
            (await http('answer', answer(pending.request, decision))).status,
          ).toBe(200);
        await waiting;
        const snapshot = await operation(f, operationId);
        expect(f.service.state.rows).toEqual(
          ['approved', 'cancel_after_start'].includes(decision) ? ['S-Q2'] : [],
        );
        expect(snapshot.status).toBe(
          decision === 'approved'
            ? 'succeeded'
            : decision === 'cancel_after_start'
              ? 'unknown'
              : 'canceled',
        );
        if (decision === 'cancel_after_start')
          expect(snapshot.result).toBeNull();
        else
          expect(snapshot.result.effects).toBe(
            decision === 'approved' ? 'applied' : 'none',
          );
        const [saved] =
          await db`select status,runtime_consumed_at from allrice_approval_requests where id=${operationId}`;
        if (decision === 'cancelled') expect(saved).toBeUndefined();
        else {
          expect(saved.status).toBe(
            decision === 'cancel_after_start' ? 'approved' : decision,
          );
          expect(!!saved.runtime_consumed_at).toBe(
            ['approved', 'cancel_after_start'].includes(decision),
          );
        }
        expect(
          h.root.session
            .snapshotEvents()
            .filter((e) => e.type === 'approval/asked'),
        ).toHaveLength(1);
        const decisions = h.root.session
          .snapshotEvents()
          .filter((e) => e.type === 'approval/decided');
        expect(decisions).toHaveLength(1);
        if (decision === 'cancelled')
          expect(decisions[0].data.outcome).toBe('cancelled');
        expect((await http('read')).status).toBe(409);
      } finally {
        releaseReply.resolve();
        spy.mockRestore();
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      }
    },
    30000,
  );

  it('missing native answerer terminates waiting_user and releases reservations once, with no PG pending', async () => {
    const f = await fixture(),
      created = await f.create();
    const id = created.snapshot.binding.attempt.operationId;
    expect(await created.confirmNativeAction(undefined)).toBe('unavailable');
    expect(await created.stopNativeAction()).toMatchObject({
      status: 'canceled',
      result: { effects: 'none' },
    });
    expect(await approvalCount(id)).toBe(0);
    const [receipts] =
      await db`select count(*)::int as n from allrice_runtime_operation_receipts where operation_id=${id}`;
    expect(receipts.n).toBe(1);
    const rows =
      await db`select reserved from allrice_runtime_budgets where root_run_id=${f.run}`;
    expect(rows.every((row) => Number(row.reserved) === 0)).toBe(true);
    expect(f.service.state.rows).toEqual([]);
  });

  it('PG approved with the same job lease cannot dispatch without the original live native grant', async () => {
    const f = await fixture(),
      created = await f.create();
    await created.confirmNativeAction(syntheticPort('approved', false));
    expect(
      await approvalCount(created.snapshot.binding.attempt.operationId),
    ).toBe(1);
    const restartedLedger = createMcpOperationLedger(created.principal, db);
    await expect(
      restartedLedger.dispatch({
        scope: created.snapshot.binding.task.scope,
        operationId: created.snapshot.binding.attempt.operationId,
        leaseOwner: f.worker,
        leaseMs: 15000,
      }),
    ).rejects.toThrow('approval_required');
    const result = await f.execute(created);
    expect(result.code).toBe('MCP_NATIVE_APPROVAL_UNAVAILABLE');
    expect(f.service.state.rows).toEqual([]);
    expect((await operation(f, result.operationId)).result.effects).toBe(
      'none',
    );
  });

  it('an approved START with a lost HTTP reply stays unknown and is never re-approved or resent', async () => {
    const f = await fixture(),
      created = await f.create();
    f.service.state.dropReply = true;
    await created.confirmNativeAction(syntheticPort());
    expect((await f.execute(created)).status).toBe('unknown');
    expect((await f.execute(created)).status).toBe('unknown');
    expect(f.service.state.rows).toEqual(['synthetic-owned-record']);
    await expect(created.stopNativeAction()).rejects.toThrow();
    await expect(f.create()).rejects.toThrow();
    expect(
      await operation(f, created.snapshot.binding.attempt.operationId),
    ).toMatchObject({ status: 'unknown', result: null });
  });

  it('approval/cancel racing cannot label a dispatched write as effects:none', async () => {
    const f = await fixture(),
      created = await f.create();
    await created.confirmNativeAction(syntheticPort());
    await Promise.allSettled([f.execute(created), created.stopNativeAction()]);
    const snapshot = await operation(
      f,
      created.snapshot.binding.attempt.operationId,
    );
    if (f.service.state.rows.length) {
      expect(snapshot.result.effects).toBe('applied');
      await expect(created.stopNativeAction()).rejects.toThrow();
    } else
      expect(snapshot).toMatchObject({
        status: 'canceled',
        result: { effects: 'none' },
      });
  });

  it('policy changes after prepare reject the old native response and safely stop without a send', async () => {
    const f = await fixture(),
      created = await f.create();
    await setRuntimePolicyControls(
      f.context,
      {
        version: 2,
        enabled: true,
        mode: 'execute',
        rules: [{ action: 'cloud.mcp.call', effect: 'deny' }],
      },
      1,
      db,
    );
    await expect(
      created.confirmNativeAction(syntheticPort()),
    ).rejects.toThrow();
    await created.stopNativeAction();
    expect(f.service.state.rows).toEqual([]);
    expect(
      (await operation(f, created.snapshot.binding.attempt.operationId)).status,
    ).toBe('canceled');
  });

  it('model confirmed/token fields cannot supply a host-owned native grant', async () => {
    const f = await fixture();
    await expect(
      f.create('forged', { ...f.args, confirmed: true, token: 'model_fake' }),
    ).rejects.toThrow();
    expect(f.service.state.rows).toEqual([]);
  });

  it('no fixed production identity leaves unrelated legacy MCP paths unchanged', async () => {
    const f = await fixture();
    identity.current = null;
    const created = await f.create();
    expect(created.nativeApproval).toBeNull();
    await f.decide(created);
    expect((await f.execute(created)).status).toBe('succeeded');
  });

  it('redacted append content is refused before creating a waiting operation', async () => {
    const f = await fixture();
    await expect(
      f.create('hidden', {
        ...f.args,
        arguments: { value: f.service.state.token },
      }),
    ).rejects.toThrow('native_action_display_unavailable');
    expect(f.service.state.rows).toEqual([]);
    const id = mcpStableId(`mcp-call:${f.run}:hidden`);
    const rows =
      await db`select id from allrice_runtime_operations where id=${id}`;
    expect(rows).toHaveLength(0);
  });

  it.each(['waiting', 'allowed-before-dispatch', 'root-cutoff'])(
    'cold PG recovery after %s has no original closure, sends nothing and releases each reservation once',
    async (phase) => {
      const f = await fixture(),
        created = await f.create();
      const id = created.snapshot.binding.attempt.operationId;
      if (phase === 'allowed-before-dispatch')
        await created.confirmNativeAction(syntheticPort());
      expect(
        await McpExecutor.recoverMcpRuntimeOperations({ database: db }),
      ).toEqual({ recovered: 0, failed: 0 });
      if (phase === 'root-cutoff') {
        await cancelCloudRuntimeRun(f.context, f.run, db);
        expect(
          await McpExecutor.recoverMcpRuntimeOperations({
            database: db,
            cancelNative: async () => {
              throw Error('live cancellation unacknowledged');
            },
          }),
        ).toEqual({ recovered: 0, failed: 1 });
        expect((await operation(f, id)).status).toBe('cancel_requested');
      } else
        await db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.job}`;
      expect(
        await McpExecutor.recoverMcpRuntimeOperations({ database: db }),
      ).toEqual({ recovered: 1, failed: 0 });
      expect(
        await McpExecutor.recoverMcpRuntimeOperations({ database: db }),
      ).toEqual({ recovered: 0, failed: 0 });
      expect(await operation(f, id)).toMatchObject({
        status: 'canceled',
        result: { effects: 'none' },
      });
      expect(f.service.state.rows).toEqual([]);
      const [receipts] =
        await db`select count(*)::int as n from allrice_runtime_operation_receipts where operation_id=${id}`;
      expect(receipts.n).toBe(1);
      const reservations =
        await db`select amount,settled_amount,observation from allrice_runtime_reservations where operation_id=${id}`;
      expect(
        reservations.every(
          (r) => Number(r.settled_amount) === 0 && r.observation.amount === 0,
        ),
      ).toBe(true);
      const budgets =
        await db`select reserved from allrice_runtime_budgets where root_run_id=${f.run}`;
      expect(budgets.every((r) => Number(r.reserved) === 0)).toBe(true);
      if (phase === 'allowed-before-dispatch') {
        const [approval] =
          await db`select status,runtime_consumed_at from allrice_approval_requests where id=${id}`;
        expect(approval).toMatchObject({
          status: 'approved',
          runtime_consumed_at: null,
        });
      }
      expect((await getNativeMcpApprovalTarget(f.context, id, db)).cutoff).toBe(
        true,
      );
    },
  );

  it('a real policy change after operation creation makes prepare fail and still records not-executed cleanup', async () => {
    const f = await fixture(),
      callId = 'prepare-race';
    const id = mcpStableId(`mcp-call:${f.run}:${callId}`);
    const realLink = TaskClock.linkTaskOperationCall;
    const barrier = vi
      .spyOn(TaskClock, 'linkTaskOperationCall')
      .mockImplementationOnce(async (...args) => {
        await realLink(...args);
        await setRuntimePolicyControls(
          f.context,
          {
            version: 2,
            enabled: true,
            mode: 'execute',
            rules: [{ action: 'cloud.mcp.call', effect: 'deny' }],
          },
          1,
          db,
        );
      });
    try {
      await expect(f.create(callId)).rejects.toThrow();
    } finally {
      barrier.mockRestore();
    }
    expect(await operation(f, id)).toMatchObject({
      status: 'canceled',
      result: { effects: 'none' },
    });
    expect(await approvalCount(id)).toBe(0);
    expect(f.service.state.rows).toEqual([]);
    const reservations =
      await db`select settled_amount from allrice_runtime_reservations where operation_id=${id}`;
    expect(reservations.every((r) => Number(r.settled_amount) === 0)).toBe(
      true,
    );
  });

  it('cold recovery after durable dispatch/START preserves unknown and refuses a none receipt', async () => {
    const f = await fixture(),
      created = await f.create();
    await created.confirmNativeAction(syntheticPort());
    const binding = created.snapshot.binding,
      scope = binding.task.scope,
      operationId = binding.attempt.operationId;
    const { leaseToken } = await created.ledger.dispatch({
      scope,
      operationId,
      leaseOwner: f.worker,
      leaseMs: 15000,
    });
    expect(
      (
        await created.ledger.startOperation({
          scope,
          operationId,
          leaseToken,
          attempt: binding.attempt,
          receiptId: mcpStableId(`${operationId}:start`),
        })
      ).mayExecute,
    ).toBe(true);
    await db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.job}`;
    expect(
      await McpExecutor.recoverMcpRuntimeOperations({ database: db }),
    ).toEqual({ recovered: 1, failed: 0 });
    expect(await operation(f, operationId)).toMatchObject({
      status: 'unknown',
      result: null,
    });
    await expect(created.stopNativeAction()).rejects.toThrow();
    expect(
      await McpExecutor.recoverMcpRuntimeOperations({ database: db }),
    ).toEqual({ recovered: 0, failed: 0 });
    expect(f.service.state.rows).toEqual([]);
  });
});
