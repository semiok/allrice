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
import { listCloudRuntimeOperations } from './cloud-operation-view.ts';
import { mcpStableId } from './mcp-authority.ts';
import {
  host,
  text,
} from '../../../apps/worker/test/native-subagent/fixture.mjs';
import { dshInboundToolHandler } from '../../../apps/worker/src/harness/dsh/tool-bridge.ts';
import { executeRiceTool } from '../../../apps/worker/src/tool-broker.ts';
import * as McpExecutor from '../../../apps/worker/src/mcp/executor.ts';
import { createNativeActionApprovalHttpHandler } from '../../../apps/worker/src/native-action-approval-http.ts';

/* global process, URL, fetch */

// Real PostgreSQL, production DSH approval, Broker and owned MCP HTTP. Only
// the model, login/session-pin issuer and fixed service identity are fixtures;
// this is not real-model, public HTTPS or browser acceptance.
let db, admin;
const identity = vi.hoisted(() => ({ current: null }));
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
  ])(
    '“向记录服务只追加 S-Q2”：real Worker entry, native $decision and member automation=$automation',
    async ({ decision, automation }) => {
      const f = await fixture();
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
            transport: f.transport,
          }),
        );
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
      const token = 'synthetic_session_token_248';
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
        expect(
          (await http('answer', answer(pending.request, decision))).status,
        ).toBe(200);
        await h.wait();
        const snapshot = await operation(f, operationId);
        expect(f.service.state.rows).toEqual(
          decision === 'approved' ? ['S-Q2'] : [],
        );
        expect(snapshot.status).toBe(
          decision === 'approved' ? 'succeeded' : 'canceled',
        );
        expect(snapshot.result.effects).toBe(
          decision === 'approved' ? 'applied' : 'none',
        );
        const [saved] =
          await db`select status,runtime_consumed_at from allrice_approval_requests where id=${operationId}`;
        expect(saved.status).toBe(decision);
        expect(!!saved.runtime_consumed_at).toBe(decision === 'approved');
        expect(
          h.root.session
            .snapshotEvents()
            .filter((e) => e.type === 'approval/asked'),
        ).toHaveLength(1);
        expect((await http('read')).status).toBe(409);
      } finally {
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
});
