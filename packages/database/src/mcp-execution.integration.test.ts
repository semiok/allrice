import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ExecutionContextSchema,
  type RequestContext,
} from '@allrice/contracts';
import { createMcpStore } from './mcp-connections.ts';
import { createMcpRuntimeOperation } from './mcp-execution.ts';
import {
  setRuntimePolicyControls,
  getRuntimeActionApproval,
  decideRuntimeActionApproval,
  revokeRuntimeActionApproval,
  runtimePolicyDigest as digest,
} from './runtime-policy.ts';
import { createMcpTransport } from '../../../apps/worker/src/mcp/transport.js';
import { startMcpAcceptanceService } from '../../../apps/worker/src/mcp/test-service.js';
import { executeNextMcpDiscovery } from '../../../apps/worker/src/mcp/lifecycle.js';
import {
  runMcpRuntimeOperation,
  recoverMcpRuntimeOperations,
} from '../../../apps/worker/src/mcp/executor.js';
import {
  listCloudRuntimeOperations,
  cancelCloudRuntimeRun,
} from './cloud-operation-view.ts';
import { mcpStableId } from './mcp-authority.ts';
import type * as Client from './core/client.ts';

let db: ReturnType<typeof postgres>, admin: ReturnType<typeof postgres>;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => db,
}));
const schema = `p16_exec_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const services: Awaited<ReturnType<typeof startMcpAcceptanceService>>[] = [];

/** Synthetic scoped Worker+frozen Run fixtures. Real PG policy, approvals,
 * operation leases and authenticated owned MCP HTTP; no personal connectors,
 * real model or public TLS/frontend route is claimed by this suite. */
async function fixture() {
  const org = randomUUID(),
    workspace = randomUUID(),
    user = randomUUID(),
    membership = randomUUID(),
    run = randomUUID(),
    policy = randomUUID(),
    employee = randomUUID(),
    version = randomUUID(),
    assignment = randomUUID(),
    session = randomUUID(),
    job = randomUUID(),
    worker = randomUUID(),
    lease = randomUUID();
  const now = new Date().toISOString();
  const memberships = [
    {
      id: membership,
      organizationId: org,
      workspaceId: workspace,
      userId: user,
      role: 'admin' as const,
      active: true,
    },
  ];
  const policyPayload = {
    memberships,
    grants: [
      { resourceType: 'job', action: 'job:execute', workspaceId: workspace },
    ],
  };
  const context: RequestContext = {
    actor: { type: 'user', id: user },
    organizationId: org,
    workspaceId: workspace,
    requestId: randomUUID(),
    sessionId: randomUUID(),
    authenticatedAt: now,
    memberships,
  };
  await db.begin(async (tx) => {
    await tx`insert into allrice_users(id,email,display_name,password_hash) values(${user},${`${user}@example.test`},'P16 synthetic','not-login')`;
    await tx`insert into allrice_organizations(id,slug,name) values(${org},${`p16-${org}`},'P16 synthetic')`;
    await tx`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspace},${org},'test','P16 synthetic')`;
    await tx`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${membership},${org},${workspace},${user},'admin')`;
  });
  const service = await startMcpAcceptanceService();
  services.push(service);
  const store = createMcpStore({
      database: db,
      credentialKey: 'af'.repeat(32),
    }),
    transport = createMcpTransport({ fetchOverride: service.fetchOverride });
  const connection = await store.create(context, {
    workspaceId: workspace,
    name: 'P16 owned acceptance',
    endpoint: service.endpoint,
    bearerToken: service.state.token,
  });
  await store.queueDiscovery(context, {
    workspaceId: workspace,
    connectionId: connection.id,
  });
  expect(
    await executeNextMcpDiscovery({
      workerId: worker,
      signal: AbortSignal.timeout(10000),
      store,
      transport,
    }),
  ).toBe(true);
  const [list] = await store.list(context, workspace);
  for (const tool of list!.tools)
    await store.grant(context, {
      workspaceId: workspace,
      connectionId: connection.id,
      revisionId: tool.revisionId,
      allowed: true,
      risk: tool.name === 'records.list' ? 'read_only' : 'write',
    });
  const mcpTools = await store.freeze({
    organizationId: org,
    workspaceId: workspace,
    actorId: user,
  });
  await db.begin(async (tx) => {
    await tx`insert into allrice_policy_snapshots(id,organization_id,subject_id,version,payload,expires_at) values(${policy},${org},${user},1,${tx.json(policyPayload)},clock_timestamp()+interval '1 hour')`;
    await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,policy_snapshot_id,execution_spec,input) values(${run},${org},${workspace},${user},'running',${policy},'{}','{}')`;
    await tx`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name) values(${employee},${org},${workspace},'p16','P16')`;
    await tx`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest) values(${version},${org},${workspace},${employee},1,'P16','synthetic','synthetic','[]',${digest('p16')},'{}')`;
    await tx`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id) values(${assignment},${org},${workspace},${employee},${version},${user})`;
    await tx`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id) values(${session},${org},${workspace},${user},'P16 synthetic',${assignment},${version})`;
    const um = randomUUID(),
      am = randomUUID();
    await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content) values(${um},${org},${workspace},${session},${user},'user','{"text":"synthetic","citations":[]}'),(${am},${org},${workspace},${session},${user},'assistant','{"text":"synthetic","citations":[]}')`;
    await tx`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,execution_snapshot) values(${run},${org},${workspace},${user},${assignment},${version},${session},${um},${am},'{}','{}',${tx.json(JSON.parse(JSON.stringify({ capabilitySnapshot: { bindings: { toolNames: ['cloud.mcp.call'] } }, mcpTools })))})`;
    await tx`insert into allrice_conversation_runtimes(organization_id,workspace_id,session_id,owner_id,thread_generation,config_checksum,state,active_run_id,worker_id) values(${org},${workspace},${session},${user},1,${digest('p16')},'running',${run},${worker})`;
    await tx`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at) values(${job},${org},${workspace},${user},${run},'running',${randomUUID()},clock_timestamp()+interval '5 minutes','{"schemaVersion":1,"type":"allrice.employee.run","input":{}}',${worker},${lease},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '5 minutes')`;
  });
  const execution = ExecutionContextSchema.parse({
    executionId: randomUUID(),
    runId: run,
    jobId: job,
    worker: { type: 'worker', id: worker },
    delegatedBy: context.actor,
    organizationId: org,
    workspaceId: workspace,
    policySnapshot: {
      id: policy,
      organizationId: org,
      subjectId: user,
      version: 1,
      issuedAt: now,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      ...policyPayload,
    },
    startedAt: now,
  });
  await setRuntimePolicyControls(
    context,
    {
      version: 1,
      enabled: true,
      mode: 'execute',
      rules: [{ action: 'cloud.mcp.call', effect: 'allow' }],
    },
    null,
    db,
  );
  const args = {
    connectionId: connection.id,
    tool: 'records.append',
    arguments: { value: 'synthetic-owned-record' },
  };
  const create = (callId = 'mcp-test', input: unknown = args) =>
    createMcpRuntimeOperation(
      { context: execution, arguments: input, callId },
      db,
    );
  const decide = async (
    c: Awaited<ReturnType<typeof create>>,
    decision: 'approved' | 'rejected' = 'approved',
  ) => {
    const [row] = await db<
      { id: string }[]
    >`select id from allrice_approval_requests where resource_type='runtime_operation' and resource_id=${c.snapshot.binding.attempt.operationId}`;
    const { request: req } = await getRuntimeActionApproval(
      context,
      row!.id,
      db,
    );
    await decideRuntimeActionApproval(
      context,
      req.approvalId,
      {
        contractVersion: 1,
        direction: 'response',
        kind: 'action_approval',
        requestId: req.requestId,
        version: req.version,
        requestDigest: req.requestDigest,
        task: req.task,
        responseId: randomUUID(),
        respondedBy: user,
        respondedAt: now,
        approvalId: req.approvalId,
        decision,
      },
      db,
    );
    return req;
  };
  const execute = (
    c: Awaited<ReturnType<typeof create>>,
    signal?: AbortSignal,
  ) =>
    runMcpRuntimeOperation(c, {
      database: db,
      store,
      transport,
      ...(signal ? { signal } : {}),
    });
  return {
    context,
    execution,
    store,
    transport,
    service,
    connection,
    mcpTools,
    args,
    create,
    decide,
    execute,
    org,
    workspace,
    user,
    worker,
    run,
    job,
  };
}
async function waitUntil(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(25);
  }
  throw Error('test condition timed out');
}
suite('P16 real approval → frozen MCP → HTTP operation ledger', () => {
  beforeAll(async () => {
    const base = process.env.ALLRICE_TEST_DATABASE_URL;
    if (!base) throw Error('explicit test database required');
    vi.stubEnv('ALLRICE_CLOUD_MCP_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.stubEnv('ALLRICE_MCP_CREDENTIAL_KEY', 'af'.repeat(32));
    const url = new URL(base);
    url.search = '';
    admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(20260907,1)`;
      await tx`create extension if not exists vector with schema public`;
      await tx`create extension if not exists pg_trgm with schema public`;
    });
    await admin.unsafe(`create schema "${schema}"`);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    db = postgres(url.toString(), { max: 12, onnotice: () => {} });
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(directory))
      .filter((f) => f.endsWith('.sql'))
      .sort())
      await db.unsafe(await readFile(new URL(file, directory), 'utf8'));
  }, 120000);
  afterAll(async () => {
    for (const service of services) await service.close();
    await db?.end({ timeout: 5 });
    if (admin && /^p16_exec_[a-f0-9]{32}$/.test(schema))
      await admin.unsafe(`drop schema "${schema}" cascade`);
    await admin?.end({ timeout: 5 });
    vi.unstubAllEnvs();
  });
  it('freezes exact tool authority, immutable input and always asks even for an allowed read', async () => {
    const f = await fixture(),
      c = await f.create();
    expect(c.snapshot.status).toBe('waiting_user');
    expect(c.snapshot.binding.execution.targetKind).toBe('cloud_mcp');
    expect((await f.create()).snapshot.binding).toEqual(c.snapshot.binding);
    expect(
      (
        await f.create('read', {
          ...f.args,
          tool: 'records.list',
          arguments: {},
        })
      ).snapshot.status,
    ).toBe('waiting_user');
    await expect(
      c.ledger.dispatch({
        scope: c.snapshot.binding.task.scope,
        operationId: c.snapshot.binding.attempt.operationId,
        leaseOwner: f.worker,
        leaseMs: 15000,
      }),
    ).rejects.toThrow('approval_invalid_or_stale');
    await expect(
      f.create('mcp-test', { ...f.args, arguments: { value: 'changed' } }),
    ).rejects.toThrow('idempotency_conflict');
    await expect(
      f.create('forge', { ...f.args, toolRevisionId: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      f.create('cross', { ...f.args, connectionId: randomUUID() }),
    ).rejects.toThrow('mcp_frozen_tool_not_allowed');
    await expect(
      db`update allrice_mcp_execution_inputs set payload='{}' where operation_id=${c.snapshot.binding.attempt.operationId}`,
    ).rejects.toThrow('MCP execution inputs are immutable');
    await expect(
      db`update allrice_mcp_tool_revisions set digest=${digest('tamper')} where id=${f.mcpTools[0]!.toolRevisionId}`,
    ).rejects.toThrow('MCP discovered tool revisions are immutable');
  });
  it('waits for exact approval, calls owned HTTP once, redacts the key and replays its durable receipt', async () => {
    const f = await fixture(),
      c = await f.create(),
      running = f.execute(c);
    await delay(250);
    expect(f.service.state.calls).toBe(0);
    await f.decide(c);
    const result = await running;
    expect(result.status).toBe('succeeded');
    expect(f.service.state.rows).toEqual(['synthetic-owned-record']);
    expect(result.output).not.toContain(f.service.state.token);
    const replay = await f.execute(c);
    expect(replay).toEqual(result);
    expect(f.service.state.calls).toBe(1);
    const [row] = await db<
      { consumed: boolean }[]
    >`select runtime_consumed_at is not null as consumed from allrice_approval_requests where resource_id=${result.operationId}`;
    expect(row?.consumed).toBe(true);
  });
  it('does not send after rejection or revoked approval', async () => {
    const f = await fixture(),
      c = await f.create();
    await f.decide(c, 'rejected');
    expect(await f.execute(c)).toMatchObject({
      status: 'blocked',
      code: 'MCP_APPROVAL_REJECTED',
    });
    const other = await f.create('revoke'),
      req = await f.decide(other);
    await revokeRuntimeActionApproval(f.context, req.approvalId, db);
    expect(await f.execute(other)).toMatchObject({
      status: 'blocked',
      code: 'MCP_APPROVAL_STALE',
    });
    expect(f.service.state.calls).toBe(0);
  });
  it('rechecks connector revocation and membership at dispatch', async () => {
    const f = await fixture(),
      c = await f.create();
    await f.decide(c);
    await f.store.revoke(f.context, {
      workspaceId: f.workspace,
      connectionId: f.connection.id,
    });
    expect((await f.execute(c)).code).toBe('MCP_DISPATCH_DENIED');
    expect(f.service.state.calls).toBe(0);
    const other = await fixture(),
      d = await other.create();
    await other.decide(d);
    await db`update allrice_memberships set active=false where user_id=${other.user}`;
    expect((await other.execute(d)).code).toBe('MCP_DISPATCH_DENIED');
    expect(other.service.state.calls).toBe(0);
  });
  it('live schema drift fails before tools/call and requires a new discovery and grant', async () => {
    const f = await fixture(),
      c = await f.create('read', {
        ...f.args,
        tool: 'records.list',
        arguments: {},
      });
    await f.decide(c);
    f.service.state.changed = true;
    const result = await f.execute(c);
    expect(result.status).toBe('failed');
    expect(result.code).toBe('MCP_DENIED');
    expect(f.service.state.reads).toBe(0);
  });
  it('loss of the reply after the write is unknown and re-entry never repeats it', async () => {
    const f = await fixture(),
      c = await f.create();
    await f.decide(c);
    f.service.state.dropReply = true;
    expect((await f.execute(c)).status).toBe('unknown');
    expect(f.service.state.calls).toBe(1);
    expect((await f.execute(c)).status).toBe('unknown');
    expect(f.service.state.calls).toBe(1);
    const state = await c.ledger.readOperation(
      c.snapshot.binding.task.scope,
      c.snapshot.binding.attempt.operationId,
    );
    expect(state.status).toBe('unknown');
    expect(state.result).toBeNull();
  }, 15000);
  it('a tool error after a write records unknown effects, never failed with none', async () => {
    const f = await fixture(),
      c = await f.create();
    await f.decide(c);
    f.service.state.toolError = true;
    expect(await f.execute(c)).toMatchObject({
      status: 'unknown',
      code: 'MCP_REMOTE_ERROR_EFFECTS_UNKNOWN',
    });
    expect(f.service.state.rows).toHaveLength(1);
    const state = await c.ledger.readOperation(
      c.snapshot.binding.task.scope,
      c.snapshot.binding.attempt.operationId,
    );
    expect(state.result).toBeNull();
    expect((await f.execute(c)).status).toBe('unknown');
    expect(f.service.state.calls).toBe(1);
  });
  it('a changed Worker job lease blocks dispatch without assuming the old context is authority', async () => {
    const f = await fixture(),
      c = await f.create();
    await f.decide(c);
    await db`update allrice_jobs set lease_token=${randomUUID()} where id=${f.job}`;
    expect(await f.execute(c)).toMatchObject({
      status: 'blocked',
      code: 'MCP_WORKER_LEASE_LOST',
    });
    expect(f.service.state.calls).toBe(0);
  });
  it.each(['root', 'job', 'grant'] as const)(
    'during a remote call, %s cancellation/revocation aborts transport but leaves effects unknown',
    async (kind) => {
      const f = await fixture(),
        c = await f.create('slow', {
          ...f.args,
          tool: 'records.slow',
          arguments: {},
        });
      await f.decide(c);
      const running = f.execute(c);
      await waitUntil(() => f.service.state.pending.length === 1);
      if (kind === 'root')
        await c.ledger.cancelRoot(
          c.snapshot.binding.task.scope,
          f.run,
          randomUUID(),
        );
      if (kind === 'job')
        await db`update allrice_jobs set lease_token=${randomUUID()} where id=${f.job}`;
      if (kind === 'grant')
        await f.store.revoke(f.context, {
          workspaceId: f.workspace,
          connectionId: f.connection.id,
        });
      expect((await running).status).toBe('unknown');
      const state = await c.ledger.readOperation(
        c.snapshot.binding.task.scope,
        c.snapshot.binding.attempt.operationId,
      );
      expect(state.result).toBeNull();
      f.service.state.pending.shift()!();
    },
    15000,
  );
  it('shares a root budget across MCP calls rather than resetting it per tool', async () => {
    const f = await fixture();
    await f.create('one');
    await db`update allrice_runtime_budgets set capacity=1 where root_run_id=${f.run}`;
    await expect(f.create('two')).rejects.toThrow('budget_exhausted');
  });
  it('keeps readable exact history with feature disabled, hides credentials and rejects cross-owner reads/cancel', async () => {
    const f = await fixture(),
      other = await fixture();
    await f.create('display', {
      ...f.args,
      arguments: { value: `note ${f.service.state.token}` },
    });
    vi.stubEnv('ALLRICE_CLOUD_MCP_ENABLED', '0');
    try {
      const views = await listCloudRuntimeOperations(f.context, f.run, db);
      expect(views).toHaveLength(1);
      expect(views[0]?.enabled).toBe(false);
      expect(views[0]?.proposal).toMatchObject({
        kind: 'mcp',
        endpoint: f.service.endpoint,
        tool: 'records.append',
        arguments: { value: 'note [REDACTED]' },
      });
      expect(JSON.stringify(views)).not.toContain(f.service.state.token);
      await expect(
        listCloudRuntimeOperations(other.context, f.run, db),
      ).rejects.toThrow('run_not_owned');
      await expect(
        cancelCloudRuntimeRun(other.context, f.run, db),
      ).rejects.toThrow('run_not_owned');
      expect(await cancelCloudRuntimeRun(f.context, f.run, db)).toMatchObject({
        accepted: true,
        remoteStopped: false,
      });
      expect(
        (await listCloudRuntimeOperations(f.context, f.run, db))[0]?.snapshot
          .status,
      ).toBe('cancel_requested');
      await db`update allrice_memberships set active=false where user_id=${f.user}`;
      await expect(
        listCloudRuntimeOperations(f.context, f.run, db),
      ).rejects.toThrow('run_not_owned');
    } finally {
      vi.stubEnv('ALLRICE_CLOUD_MCP_ENABLED', '1');
    }
  });
  it('persists dispatch ownership atomically and cold recovery marks lost started work unknown without HTTP', async () => {
    const f = await fixture(),
      c = await f.create();
    await f.decide(c);
    const b = c.snapshot.binding;
    const lease = await c.ledger.dispatch({
      scope: b.task.scope,
      operationId: b.attempt.operationId,
      leaseOwner: f.worker,
      leaseMs: 15000,
    });
    const [journal] = await db<
      { lease_token: string }[]
    >`select lease_token from allrice_mcp_execution_attempts where operation_id=${b.attempt.operationId}`;
    expect(journal?.lease_token).toBe(lease.leaseToken);
    await c.ledger.startOperation({
      scope: b.task.scope,
      operationId: b.attempt.operationId,
      leaseToken: lease.leaseToken,
      attempt: b.attempt,
      receiptId: mcpStableId(`${b.attempt.operationId}:start`),
    });
    await db`update allrice_jobs set lease_token=${randomUUID()} where id=${f.job}`;
    expect(
      (await recoverMcpRuntimeOperations({ database: db })).recovered,
    ).toBeGreaterThanOrEqual(1);
    expect(
      (await c.ledger.readOperation(b.task.scope, b.attempt.operationId))
        .status,
    ).toBe('unknown');
    expect(f.service.state.calls).toBe(0);
  });
  it('recovers a durable reply after receipt-write failure without reconnecting or resending', async () => {
    const f = await fixture(),
      c = await f.create();
    await f.decide(c);
    const b = c.snapshot.binding;
    const original = c.ledger.recordReceipt.bind(c.ledger);
    const spy = vi
      .spyOn(c.ledger, 'recordReceipt')
      .mockImplementation(async (input) => {
        if (input.receiptId === mcpStableId(`${b.attempt.operationId}:result`))
          throw Error('synthetic receipt failure');
        return original(input);
      });
    await expect(f.execute(c)).rejects.toThrow('synthetic receipt failure');
    spy.mockRestore();
    expect(f.service.state.calls).toBe(1);
    await db`update allrice_jobs set lease_token=${randomUUID()} where id=${f.job}`;
    await recoverMcpRuntimeOperations({ database: db });
    expect(
      (await c.ledger.readOperation(b.task.scope, b.attempt.operationId))
        .status,
    ).toBe('succeeded');
    expect(f.service.state.calls).toBe(1);
    const [meter] = await db<
      { settled_amount: string }[]
    >`select settled_amount from allrice_runtime_reservations where operation_id=${b.attempt.operationId} and metric='tool_calls'`;
    expect(Number(meter?.settled_amount)).toBe(1);
  });
  it('lists approvals and atomically cancels with a single pool connection, without nested connection starvation', async () => {
    const f = await fixture();
    await f.create();
    const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
    url.search = '';
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    const single = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      expect(
        (await listCloudRuntimeOperations(f.context, f.run, single))[0]
          ?.approval?.request,
      ).toBeTruthy();
      expect(
        await cancelCloudRuntimeRun(f.context, f.run, single),
      ).toMatchObject({ accepted: true, remoteStopped: false });
      expect(
        (await listCloudRuntimeOperations(f.context, f.run, single))[0]
          ?.snapshot.status,
      ).toBe('cancel_requested');
    } finally {
      await single.end({ timeout: 1 });
    }
  }, 10000);
});
