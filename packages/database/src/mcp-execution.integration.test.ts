import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMcpExecutionFixture } from './mcp-execution.fixture.ts';
import * as McpConnections from './mcp-connections.ts';
import {
  revokeRuntimeActionApproval,
  runtimePolicyDigest as digest,
} from './runtime-policy.ts';
import type { startMcpAcceptanceService } from '../../../apps/worker/src/mcp/test-service.js';
import { recoverMcpRuntimeOperations } from '../../../apps/worker/src/mcp/executor.js';
import {
  listCloudRuntimeOperations,
  cancelCloudRuntimeRun,
} from './cloud-operation-view.ts';
import { mcpStableId } from './mcp-authority.ts';
import type * as Client from './core/client.ts';
import { nativeBrokerRoundtrip } from '../../../apps/worker/src/harness/dsh-native-broker.fixture.js';
import { executeRiceTool } from '../../../apps/worker/src/tool-broker.js';
import { riceToolDefinitionsForCapabilities } from '../../../apps/worker/src/tool-broker/definitions.js';
import * as McpExecutor from '../../../apps/worker/src/mcp/executor.js';
import { createNativeMcpTransport } from '../../../apps/worker/src/mcp/native-transport.js';
import { executeNextMcpDiscovery } from '../../../apps/worker/src/mcp/lifecycle.js';
import {
  managedMcpRunContext,
  requestManagedMcpLogin,
  resumeManagedMcpConnections,
} from './mcp-managed-connections.ts';
import {
  parkNativeQuestion,
  beginNativeTask,
  wakeNativeQuestionWaits,
} from './task-native-wait.ts';
import { resolveTaskRuntimePolicy } from './task-runtime-policy.ts';
import { refreshTaskClock } from './task-clock.ts';
import { updateEmployeeStatus } from './employees/employeehub.ts';
import { PlatformEmployeeDefinitionSchema } from '@allrice/contracts';
import {
  compilePlatformEmployee,
  queuePlatformEmployeeTestRun,
  completePlatformEmployeeTestRun,
  publishPlatformEmployee,
} from './employees/platform-employees.ts';

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

async function fixture() {
  const f = await createMcpExecutionFixture(db);
  services.push(f.service);
  if (!f.employeeGrant) throw Error('fixture employee grant required');
  return { ...f, employeeGrant: f.employeeGrant };
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
  it('an ordinary member connects an app during a running task, supplies credentials privately and executes through DSH without republishing', async () => {
    const f = await fixture();
    await db`update allrice_memberships set role='member' where user_id=${f.user}`;
    const context = await managedMcpRunContext(f.execution, db);
    expect(context.memberships[0]?.role).toBe('member');
    const store = McpConnections.createMcpStore({
      database: db,
      memberManaged: true,
      credentialKey: 'af'.repeat(32),
    });
    const native = createNativeMcpTransport({
      fetchOverride: f.service.fetchOverride,
    });
    const connection = await store.create(context, {
      workspaceId: f.workspace,
      name: 'My records',
      endpoint: f.service.endpoint,
    });
    await executeNextMcpDiscovery({
      workerId: f.worker,
      signal: AbortSignal.timeout(10000),
      store,
      transport: native,
    });
    expect(
      (await store.memberConnection(context, f.workspace, connection.id))
        .discoveryCode,
    ).toBe('MCP_AUTH_REQUIRED');
    await store.rotate(context, {
      workspaceId: f.workspace,
      connectionId: connection.id,
      bearerToken: f.service.state.token,
    });
    await executeNextMcpDiscovery({
      workerId: f.worker,
      signal: AbortSignal.timeout(10000),
      store,
      transport: native,
    });
    const ready = await store.memberConnection(
      context,
      f.workspace,
      connection.id,
    );
    expect(ready.discoveryState).toBe('ready');
    expect(ready.tools.every((t) => t.allowed)).toBe(true);
    expect(JSON.stringify(ready)).not.toContain(f.service.state.token);
    const tool = ready.tools.find(
      (t) => t.description === 'Append a synthetic record',
    )!;
    const created = await f.create('managed-native-write', {
      connectionId: connection.id,
      tool: tool.name,
      arguments: { value: 'same-task' },
    });
    await f.decide(created);
    const result = await McpExecutor.runMcpRuntimeOperation(created, {
      database: db,
      store,
      transport: native,
    });
    expect(result.status).toBe('succeeded');
    expect(f.service.state.rows).toEqual(['same-task']);
    const [unchanged] =
      await db`select execution_snapshot from allrice_employee_runs where run_id=${f.run}`;
    expect(
      unchanged!.execution_snapshot.mcpTools.some(
        (t: { connectionId: string }) => t.connectionId === connection.id,
      ),
    ).toBe(false);
    await store.setMemberConnected(context, {
      workspaceId: f.workspace,
      connectionId: connection.id,
      connected: false,
    });
    const again = await store.create(context, {
      workspaceId: f.workspace,
      name: 'Do not reconnect',
      endpoint: f.service.endpoint,
    });
    expect(again.id).toBe(connection.id);
    expect(again.disconnected).toBe(true);
    await expect(
      f.create('after-disconnect', {
        connectionId: connection.id,
        tool: tool.name,
        arguments: { value: 'blocked' },
      }),
    ).rejects.toThrow();
  }, 15000);
  it('member disconnect of a shared app preserves other members and reconnect cannot revive old approvals', async () => {
    const f = await fixture();
    const operation = await f.create('before-member-disconnect');
    await f.decide(operation);
    await f.store.setMemberConnected(f.context, {
      workspaceId: f.workspace,
      connectionId: f.connection.id,
      connected: false,
    });
    const [binding] =
      await db`select enabled from allrice_connector_bindings where id=${f.connection.id}`;
    expect(binding!.enabled).toBe(true);
    await f.store.setMemberConnected(f.context, {
      workspaceId: f.workspace,
      connectionId: f.connection.id,
      connected: true,
    });
    await expect(
      f.store.assertAuthorized(
        { organizationId: f.org, workspaceId: f.workspace, actorId: f.user },
        f.mcpTools[0]!,
      ),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
    await expect(f.execute(operation)).resolves.toMatchObject({
      code: 'MCP_DISPATCH_DENIED',
    });
    expect(f.service.state.calls).toBe(0);
  });
  it('reuses SDK OAuth discovery, PKCE callback and token refresh with encrypted member-owned state', async () => {
    const f = await fixture();
    f.service.state.oauthEnabled = true;
    const store = McpConnections.createMcpStore({
      database: db,
      memberManaged: true,
      credentialKey: 'af'.repeat(32),
    });
    const transport = createNativeMcpTransport({
      fetchOverride: f.service.fetchOverride,
    });
    const connection = await store.create(f.context, {
      workspaceId: f.workspace,
      name: 'OAuth records',
      endpoint: f.service.endpoint,
    });
    await store.beginOAuth(f.context, {
      workspaceId: f.workspace,
      connectionId: connection.id,
      redirectUrl: 'https://allrice.example.test/api/v1/connections/callback',
    });
    const discover = () =>
      executeNextMcpDiscovery({
        workerId: f.worker,
        signal: AbortSignal.timeout(10000),
        store,
        transport,
      });
    await discover();
    expect(
      (await store.memberConnection(f.context, f.workspace, connection.id))
        .loginState,
    ).toBe('redirect');
    const url = await store.oauthAuthorizationUrl(
      f.context,
      f.workspace,
      connection.id,
    );
    const authorization = await f.service.fetchOverride(url, {
      redirect: 'manual',
    });
    const callback = new URL(authorization.headers.get('location')!);
    const answer = {
      state: callback.searchParams.get('state')!,
      code: callback.searchParams.get('code')!,
    };
    await expect(
      store.completeOAuthCallback(f.context, {
        ...answer,
        state: '0'.repeat(64),
      }),
    ).rejects.toThrow();
    await store.completeOAuthCallback(f.context, answer);
    await expect(
      store.completeOAuthCallback(f.context, answer),
    ).rejects.toThrow();
    await discover();
    const ready = await store.memberConnection(
      f.context,
      f.workspace,
      connection.id,
    );
    expect(ready).toMatchObject({
      discoveryState: 'ready',
      loginState: 'connected',
      credentialConfigured: true,
    });
    expect(f.service.state.exchanges).toBe(1);
    const [encrypted] =
      await db`select oauth_envelope from allrice_mcp_binding_config where binding_id=${connection.id}`;
    expect(JSON.stringify(encrypted)).not.toContain('synthetic-refresh-token');
    expect(JSON.stringify(ready)).not.toContain(f.service.state.token);
    f.service.state.token = 'simulate-access-token-expiry';
    const tool = ready.tools.find(
      (t) => t.description === 'Append a synthetic record',
    )!;
    const operation = await f.create('native-oauth-refresh', {
      connectionId: connection.id,
      tool: tool.name,
      arguments: { value: 'oauth-result' },
    });
    await f.decide(operation);
    const result = await McpExecutor.runMcpRuntimeOperation(operation, {
      database: db,
      store,
      transport,
    });
    expect(result.status).toBe('succeeded');
    expect(result.output).not.toContain(f.service.state.token);
    expect(f.service.state.refreshes).toBe(1);
    expect(f.service.state.calls).toBe(1);
  }, 15000);
  it('successful login automatically answers the persisted native question and requeues the original task exactly once', async () => {
    const f = await fixture();
    const store = McpConnections.createMcpStore({
      database: db,
      memberManaged: true,
      credentialKey: 'af'.repeat(32),
    });
    const transport = createNativeMcpTransport({
      fetchOverride: f.service.fetchOverride,
    });
    const connection = await store.create(f.context, {
      workspaceId: f.workspace,
      name: 'Resume records',
      endpoint: f.service.endpoint,
    });
    const discover = () =>
      executeNextMcpDiscovery({
        workerId: f.worker,
        signal: AbortSignal.timeout(10000),
        store,
        transport,
      });
    await discover();
    const requestId = await requestManagedMcpLogin(
      f.execution,
      connection.id,
      db,
    );
    const questionId = `question-${randomUUID()}`,
      thread = `dsh-${f.session}`,
      turnId = `${thread}:turn:0`;
    const questions = [
      {
        id: `app-connect:${requestId}`,
        question: '完成应用登录后继续',
        multiSelect: false,
        options: [{ label: '已连接，继续任务' }, { label: '取消连接' }],
      },
    ];
    await db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy) values(${f.run},${f.org},${f.workspace},${db.json({ ...resolveTaskRuntimePolicy([]) })})`;
    await db`insert into allrice_task_questions(run_id,question_id,pending) values(${f.run},${questionId},true)`;
    await db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
      values(${f.org},${f.workspace},${f.run},0,'harness.native',${db.json({ source: 'dsh', sourceEventType: 'session/user-question', nativePayload: { questionId, questions } })})`;
    await db`update allrice_jobs set attempt=1 where id=${f.job}`;
    await db`update allrice_conversation_runtimes set thread_id=${thread},active_turn_id=${turnId} where session_id=${f.session}`;
    const [job] =
      await db`select lease_token::text from allrice_jobs where id=${f.job}`;
    const owner = {
      context: f.execution,
      worker: {
        jobId: f.job,
        workerId: f.worker,
        leaseToken: String(job!.lease_token),
      },
      configChecksum: digest('p16'),
      generation: 1,
    };
    await db.begin((tx) => refreshTaskClock(tx, f.run));
    await beginNativeTask({ ...owner, attempt: 1 }, db);
    await parkNativeQuestion(
      {
        ...owner,
        checkpoint: {
          sessionId: thread,
          questionId,
          turnId,
          sequence: 20,
          questions,
        },
      },
      db,
    );
    await resumeManagedMcpConnections(20, db);
    expect(
      await db`select id from allrice_conversation_commands where session_id=${f.session}`,
    ).toHaveLength(0);
    await store.rotate(f.context, {
      workspaceId: f.workspace,
      connectionId: connection.id,
      bearerToken: f.service.state.token,
    });
    await discover();
    await resumeManagedMcpConnections(20, db);
    await resumeManagedMcpConnections(20, db);
    const commands =
      await db`select message,input_kind,expected_turn_id from allrice_conversation_commands where session_id=${f.session}`;
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      input_kind: 'ask_user',
      expected_turn_id: turnId,
    });
    expect(String(commands[0]!.message)).not.toContain(f.service.state.token);
    await wakeNativeQuestionWaits(20, db);
    const [resumed] =
      await db`select status from allrice_jobs where id=${f.job}`;
    expect(resumed!.status).toBe('queued');
  }, 15000);
  it('real platform compile/preview/publish permits narrow MCP service policy, never tenant IDs or explicit denials', async () => {
    const f = await fixture();
    await db`update allrice_provider_status set status='connected',checked_at=clock_timestamp() where provider='codex'`;
    const base = PlatformEmployeeDefinitionSchema.parse({
      schemaVersion: 1,
      key: 'synthetic-mcp',
      name: 'MCP policy',
      description: 'Synthetic only',
      appearance: { avatarType: 'initials', avatarValue: 'M' },
      identity: {
        role: 'Reviewer',
        mission: 'Test scoped service',
        workStyle: 'Controlled',
        behaviorRules: ['No implicit authority'],
        safetyBoundaries: ['Synthetic only'],
        expressionStyle: 'structured',
        outputLanguage: 'zh-CN',
      },
      systemPrompt: 'Synthetic policy',
      modelPolicy: {
        provider: 'openai-codex',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'xhigh',
        timeoutMs: 300000,
        fallbackModels: [],
        credentialReference: 'deployment:codex-default',
        baseUrl: null,
      },
      capabilities: {
        nativeSkillIds: [],
        workflowRevisionIds: [],
        knowledgeRevisionIds: [],
        toolNames: ['cloud.mcp.call'],
        connectorRefs: [],
      },
      securityPolicy: {
        dataScopes: ['workspace'],
        approvalPolicy: 'confirm_side_effects',
        bridgeAccess: 'none',
        connectorIdentityModes: ['service'],
        deniedCapabilities: [],
      },
    });
    async function draft(definition: typeof base) {
      const id = randomUUID(),
        revision = randomUUID(),
        value = { ...definition, key: `mcp-${id}` };
      await db`insert into allrice_platform_employees(id,employee_key,name,description,status) values(${id},${value.key},${value.name},${value.description},'draft')`;
      await db`insert into allrice_platform_employee_revisions(id,employee_id,revision,status,definition,checksum) values(${revision},${id},1,'draft',${db.json(value)},${digest(value)})`;
      await db`update allrice_platform_employees set current_draft_revision_id=${revision} where id=${id}`;
      return { id, value };
    }
    for (const cap of ['secret:use', 'network:outbound'] as const) {
      const denied = await draft({
        ...base,
        securityPolicy: { ...base.securityPolicy, deniedCapabilities: [cap] },
      });
      const result = await compilePlatformEmployee(denied.id);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        `工具 cloud.mcp.call 所需能力 ${cap} 已被员工策略禁止`,
      );
    }
    const tenantIds = await draft({
      ...base,
      capabilities: {
        ...base.capabilities,
        connectorRefs: [`mcp.${f.connection.id}`],
      },
    });
    expect(
      (await compilePlatformEmployee(tenantIds.id)).errors.join(' '),
    ).toContain('草稿不能引用租户 Connector');
    const noMcp = await draft({
      ...base,
      capabilities: { ...base.capabilities, toolNames: ['web.fetch'] },
    });
    const withoutMcp = await compilePlatformEmployee(noMcp.id);
    expect(withoutMcp.valid).toBe(true);
    expect(withoutMcp.runtimeProfile?.toolNames).toEqual(['web.fetch']);
    const allowed = await draft(base);
    expect((await compilePlatformEmployee(allowed.id)).valid).toBe(true);
    const trial = await queuePlatformEmployeeTestRun(allowed.id, {
      workspaceId: f.workspace,
      prompt: 'Synthetic compile and release only',
    });
    expect(trial.queued).toBe(true);
    await db`update allrice_platform_employee_test_runs set status='running',started_at=clock_timestamp(),timeout_at=clock_timestamp()+interval '5 minutes' where id=${trial.testRun!.id}`;
    await completePlatformEmployeeTestRun(trial.testRun!.id, {
      answer: 'Synthetic preview complete; no remote tools executed.',
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      threadId: null,
      usage: null,
      events: [],
      error: null,
    });
    await publishPlatformEmployee(allowed.id, { workspaceIds: [f.workspace] });
    const [published] =
      await db`select v.manifest from allrice_employee_versions v join allrice_employees e on e.id=v.employee_id where e.organization_id=${f.org} and e.workspace_id=${f.workspace} and e.employee_key=${allowed.value.key}`;
    expect(published!.manifest.capabilities).toContain('secret:use');
    expect(published!.manifest.securityPolicy.connectorIdentityModes).toContain(
      'service',
    );
    expect(published!.manifest.capabilityBindings.connectorRefs ?? []).toEqual(
      [],
    );
    expect(f.service.state.calls).toBe(0);
  });
  it('published MCP capability exposes connection setup before an app is bound; calls still require database authority', async () => {
    const f = await fixture();
    const before = f.beforeBinding.executionSnapshot,
      after = f.prepared.executionSnapshot;
    expect(before.mcpTools).toEqual([]);
    expect(before.capabilitySnapshot.grantedCapabilities).toContain(
      'secret:use',
    );
    expect(after.capabilitySnapshot.grantedCapabilities).toContain(
      'secret:use',
    );
    // web.fetch is explicitly selected in this employee. It is available
    // before binding MCP and does not require an unrelated Skill.
    expect(before.capabilitySnapshot.grantedCapabilities).toContain(
      'network:outbound',
    );
    expect(
      after.capabilitySnapshot.grantedCapabilities.filter(
        (capability) => capability !== 'secret:use',
      ),
    ).toEqual(
      before.capabilitySnapshot.grantedCapabilities.filter(
        (capability) => capability !== 'secret:use',
      ),
    );
    const visible = (value: typeof after) =>
      riceToolDefinitionsForCapabilities(
        value.capabilitySnapshot.grantedCapabilities,
        value.capabilitySnapshot.bindings.toolNames,
        value.mcpTools,
      ).map((t) => t.name);
    expect(visible(before)).toContain('cloud.mcp.call');
    expect(visible(after)).toContain('cloud.mcp.call');
    expect(visible(before)).toContain('web.fetch');
    expect(visible(after)).toContain('web.fetch');
    expect(
      after.mcpTools?.every(
        (t) => t.employeeAuthorization?.id === f.employeeGrant.id,
      ),
    ).toBe(true);
    const listing = await f.employeeBindings.list(f.context, f.workspace);
    expect(listing[0]?.eligible).toBe(true);
    expect(listing[0]?.bindings[0]?.revision).toBe(1);
    await expect(
      executeRiceTool({
        context: f.execution,
        storageRoot: `/tmp/${schema}`,
        call: { id: 'no-secret', name: 'cloud.mcp.call', arguments: f.args },
        capabilities: ['storage:read'],
        frozenMcpTools: f.mcpTools,
      }),
    ).rejects.toThrow('Rice 未被授予');
    await expect(
      executeRiceTool({
        context: f.execution,
        storageRoot: `/tmp/${schema}`,
        call: {
          id: 'no-freeze',
          name: 'cloud.mcp.call',
          arguments: { ...f.args, connectionId: randomUUID() },
        },
        capabilities: ['secret:use'],
      }),
    ).rejects.toThrow();
  });
  it('revoke and regrant cannot revive an old Run or approval, while new Runs freeze the new revision', async () => {
    const f = await fixture(),
      c = await f.create();
    await f.decide(c);
    const change = {
      workspaceId: f.workspace,
      connectionId: f.connection.id,
      employeeId: f.employee,
      employeeVersionId: f.version,
    };
    const revoked = await f.employeeBindings.bind(f.context, {
      ...change,
      expectedRevision: 1,
      enabled: false,
    });
    expect(revoked.revision).toBe(2);
    expect((await f.prepare()).executionSnapshot.mcpTools).toEqual([]);
    await expect(f.create('after-revoke')).rejects.toThrow('MCP_DENIED');
    const result = await f.execute(c);
    expect(result.code).toBe('MCP_DISPATCH_DENIED');
    expect(f.service.state.calls).toBe(0);
    const restored = await f.employeeBindings.bind(f.context, {
      ...change,
      expectedRevision: 2,
      enabled: true,
    });
    expect(restored.revision).toBe(3);
    await expect(f.create('after-regrant')).rejects.toThrow('MCP_DENIED');
    expect(
      (await f.prepare()).executionSnapshot.mcpTools?.[0]?.employeeAuthorization
        ?.revision,
    ).toBe(3);
    const [row] =
      await db`select execution_snapshot from allrice_employee_runs where run_id=${f.run}`;
    expect(row!.execution_snapshot).toEqual(f.snapshot);
    await expect(
      db`update allrice_employee_mcp_bindings set grant_revision=grant_revision where id=${f.employeeGrant.id}`,
    ).rejects.toThrow('employee_mcp_binding_identity_or_revision_immutable');
    await expect(
      db`delete from allrice_employee_mcp_bindings where id=${f.employeeGrant.id}`,
    ).rejects.toThrow('employee_mcp_binding_must_be_revoked');
  });
  it('current assignment revocation blocks already-approved operations before dispatch', async () => {
    const f = await fixture(),
      c = await f.create();
    await f.decide(c);
    await db`update allrice_employee_assignments set active=false where id=${f.assignment}`;
    expect((await f.execute(c)).code).toBe('MCP_DISPATCH_DENIED');
    expect(f.service.state.calls).toBe(0);
  });
  it('actual employee archival races dispatch without employee/assignment lock inversion', async () => {
    const f = await fixture(),
      c = await f.create();
    await f.decide(c);
    const [archived, dispatch] = await Promise.allSettled([
      updateEmployeeStatus(f.context, f.employee, {
        workspaceId: f.workspace,
        status: 'archived',
      }),
      c.ledger.dispatch({
        scope: c.snapshot.binding.task.scope,
        operationId: c.snapshot.binding.attempt.operationId,
        leaseOwner: f.worker,
        leaseMs: 15000,
      }),
    ]);
    expect(archived.status).toBe('fulfilled');
    if (dispatch.status === 'rejected')
      expect(dispatch.reason?.code).not.toBe('40P01');
    else
      await expect(
        c.ledger.startOperation({
          scope: c.snapshot.binding.task.scope,
          operationId: c.snapshot.binding.attempt.operationId,
          leaseToken: dispatch.value.leaseToken,
          attempt: c.snapshot.binding.attempt,
          receiptId: randomUUID(),
        }),
      ).rejects.toThrow();
    expect(f.service.state.calls).toBe(0);
  });
  it.each(['secret:use', 'network:outbound'] as const)(
    'real tenant admin cannot bind or freeze a version that explicitly denies %s',
    async (cap) => {
      const f = await createMcpExecutionFixture(db, {
        bind: false,
        deniedCapabilities: [cap],
      });
      services.push(f.service);
      const [target] = await f.employeeBindings.list(f.context, f.workspace);
      expect(target!.eligible).toBe(false);
      expect(target!.reasons).toContain(`员工策略明确禁止 ${cap}`);
      await expect(
        f.employeeBindings.bind(f.context, {
          workspaceId: f.workspace,
          connectionId: f.connection.id,
          employeeId: f.employee,
          employeeVersionId: f.version,
          expectedRevision: 0,
          enabled: true,
        }),
      ).rejects.toThrow('MCP_DENIED');
      expect(f.prepared.executionSnapshot.mcpTools).toEqual([]);
      await expect(f.create()).rejects.toThrow('mcp_frozen_tool_not_allowed');
      expect(f.service.state.calls).toBe(0);
    },
  );
  it('concurrent employee revoke and approval/dispatch share lock order and never authorize a post-revoke START', async () => {
    for (let i = 0; i < 3; i++) {
      const f = await fixture(),
        c = await f.create();
      await f.decide(c);
      const result = await Promise.allSettled([
        f.employeeBindings.bind(f.context, {
          workspaceId: f.workspace,
          connectionId: f.connection.id,
          employeeId: f.employee,
          employeeVersionId: f.version,
          expectedRevision: 1,
          enabled: false,
        }),
        c.ledger.dispatch({
          scope: c.snapshot.binding.task.scope,
          operationId: c.snapshot.binding.attempt.operationId,
          leaseOwner: f.worker,
          leaseMs: 15000,
        }),
      ]);
      expect(result[0]!.status).toBe('fulfilled');
      for (const item of result)
        if (item.status === 'rejected')
          expect(item.reason?.code).not.toBe('40P01');
      if (result[1]!.status === 'fulfilled')
        await expect(
          c.ledger.startOperation({
            scope: c.snapshot.binding.task.scope,
            operationId: c.snapshot.binding.attempt.operationId,
            leaseToken: result[1].value.leaseToken,
            attempt: c.snapshot.binding.attempt,
            receiptId: randomUUID(),
          }),
        ).rejects.toThrow();
      expect(f.service.state.calls).toBe(0);
    }
  }, 15000);
  it('checks current DB administrator, tenant/version scope and stale revisions rather than trusting claims', async () => {
    const f = await fixture(),
      other = await fixture();
    const change = {
      workspaceId: f.workspace,
      connectionId: f.connection.id,
      employeeId: f.employee,
      employeeVersionId: f.version,
      enabled: false,
      expectedRevision: 1,
    };
    await expect(
      f.employeeBindings.bind(other.context, change),
    ).rejects.toThrow('MCP_DENIED');
    await expect(
      f.employeeBindings.bind(f.context, {
        ...change,
        connectionId: other.connection.id,
      }),
    ).rejects.toThrow('MCP_DENIED');
    await expect(
      f.employeeBindings.bind(f.context, {
        ...change,
        employeeVersionId: other.version,
      }),
    ).rejects.toThrow('MCP_DENIED');
    await expect(
      f.employeeBindings.bind(f.context, { ...change, expectedRevision: 0 }),
    ).rejects.toThrow('MCP_BINDING_CHANGED');
    await db`update allrice_memberships set role='member' where user_id=${f.user} and organization_id=${f.org}`;
    await expect(
      f.employeeBindings.list(f.context, f.workspace),
    ).rejects.toThrow('MCP_DENIED');
    await expect(f.employeeBindings.bind(f.context, change)).rejects.toThrow(
      'MCP_DENIED',
    );
    await db`update allrice_memberships set active=false where user_id=${f.user} and organization_id=${f.org}`;
    // Inactive members now fail at employee binding, before MCP preparation.
    await expect(f.prepare()).rejects.toMatchObject({ code: 'not_found' });
    expect(f.service.state.calls).toBe(0);
  });
  it('actual DSH native → generic Broker → real PG approval → owned HTTP, without a model key or production localhost bypass', async () => {
    const f = await fixture(),
      realExecute = McpExecutor.runMcpRuntimeOperation;
    const spy = vi
      .spyOn(McpExecutor, 'runMcpRuntimeOperation')
      .mockImplementation((created, options) =>
        realExecute(created, {
          ...options,
          database: db,
          store: f.store,
          transport: f.transport,
        }),
      );
    try {
      await nativeBrokerRoundtrip({
        canonicalName: 'cloud.mcp.call',
        wireName: 'cloud_mcp_call',
        args: f.args,
        invalidArgs: { ...f.args, connectionId: 'not-a-uuid' },
        onToolCall: async (call) => {
          const pending = executeRiceTool({
            context: f.execution,
            storageRoot: `/tmp/${schema}`,
            call,
            capabilities: f.snapshot.capabilitySnapshot.grantedCapabilities,
            frozenMcpTools: f.mcpTools,
          });
          await waitUntil(async () => {
            const rows =
              await db`select id from allrice_approval_requests where organization_id=${f.org} and resource_type='runtime_operation'`;
            return rows.length === 1;
          });
          expect(f.service.state.calls).toBe(0);
          const c = await f.create(call.id);
          await f.decide(c);
          const result = await pending;
          expect(JSON.parse(result.modelContent).status).toBe('succeeded');
          return result;
        },
      });
      expect(f.service.state.calls).toBe(1);
      const rows =
        await db`select id from allrice_audit_events where organization_id=${f.org} and action='tool.execute' and resource_type='tool_broker' and decision='allowed'`;
      // The real Broker always records its normal tenant-scoped audit.
      expect(rows).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  }, 30000);
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
  it('MET-159 default automatic work executes a real HTTP MCP call without an approval', async () => {
    const f = await fixture();
    await db`delete from allrice_member_work_automation where organization_id=${f.org}`;
    const op = await f.create();
    expect(op.snapshot.status).toBe('ready');
    expect((await f.execute(op)).status).toBe('succeeded');
    expect(f.service.state.calls).toBe(1);
    expect(
      await db`select id from allrice_approval_requests where resource_id=${op.snapshot.binding.attempt.operationId}`,
    ).toHaveLength(0);
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
  it('projects real connection revocation without rewriting approval, and the old decision is denied', async () => {
    const f = await fixture();
    const created = await f.create();
    const [before] = await listCloudRuntimeOperations(f.context, f.run, db);
    expect(before!.mcpAuthorization).toEqual({
      available: true,
      reason: 'available',
    });
    const originalApproval = before!.approval!;
    await f.store.revoke(f.context, {
      workspaceId: f.workspace,
      connectionId: f.connection.id,
    });
    const [after] = await listCloudRuntimeOperations(f.context, f.run, db);
    expect(after!.mcpAuthorization).toEqual({
      available: false,
      reason: 'connection_revoked',
    });
    expect(after!.enabled).toBe(true); // Environment enablement is not connector authority.
    expect(after!.snapshot).toEqual(before!.snapshot);
    expect(after!.approval).toEqual(originalApproval);
    expect(after!.approval!.revokedAt).toBeNull();
    await expect(f.decide(created)).rejects.toThrow();
    const [retained] = await listCloudRuntimeOperations(f.context, f.run, db);
    expect(retained!.approval).toEqual(originalApproval);
    expect(f.service.state.calls).toBe(0);
  });
  it.each(['tool', 'credential', 'employee'] as const)(
    'projects current %s authorization changes and never revives the frozen approval',
    async (kind) => {
      const f = await fixture();
      const created = await f.create();
      const [before] = await listCloudRuntimeOperations(f.context, f.run, db);
      if (kind === 'tool') {
        const tool = f.mcpTools.find((tool) => tool.name === 'records.append')!;
        await f.store.grant(f.context, {
          workspaceId: f.workspace,
          connectionId: f.connection.id,
          revisionId: tool.toolRevisionId,
          allowed: false,
          risk: 'write',
        });
      } else if (kind === 'credential') {
        await f.store.rotate(f.context, {
          workspaceId: f.workspace,
          connectionId: f.connection.id,
          bearerToken: 'synthetic-rotated-bearer-token',
        });
      } else {
        await f.employeeBindings.bind(f.context, {
          workspaceId: f.workspace,
          connectionId: f.connection.id,
          employeeId: f.employee,
          employeeVersionId: f.version,
          expectedRevision: 1,
          enabled: false,
        });
      }
      const [after] = await listCloudRuntimeOperations(f.context, f.run, db);
      expect(after!.mcpAuthorization).toEqual({
        available: false,
        reason:
          kind === 'employee'
            ? 'employee_authorization_changed'
            : 'connection_or_tool_changed',
      });
      expect(after!.approval).toEqual(before!.approval);
      expect(after!.snapshot).toEqual(before!.snapshot);
      await expect(f.decide(created)).rejects.toThrow();
      expect(f.service.state.calls).toBe(0);
    },
  );
  it('fails closed on unexpected display-authority errors without losing historical results or cancel access', async () => {
    const f = await fixture();
    const created = await f.create();
    await f.decide(created);
    await f.execute(created);
    const [before] = await listCloudRuntimeOperations(f.context, f.run, db);
    expect(before!.snapshot.status).toBe('succeeded');
    const original = McpConnections.createMcpStore;
    const unavailable = vi
      .spyOn(McpConnections, 'createMcpStore')
      .mockImplementation((options) => ({
        ...original(options),
        assertAuthorized: async () => {
          throw new Error('secret database failure');
        },
      }));
    try {
      const [after] = await listCloudRuntimeOperations(f.context, f.run, db);
      expect(after!.mcpAuthorization).toEqual({
        available: false,
        reason: 'unavailable',
      });
      expect(after!.snapshot).toEqual(before!.snapshot);
      expect(after!.result).toEqual(before!.result);
      expect(after!.approval).toEqual(before!.approval);
      expect(JSON.stringify(after)).not.toContain('secret database failure');
      expect(f.service.state.calls).toBe(1);
    } finally {
      unavailable.mockRestore();
    }
    await f.store.revoke(f.context, {
      workspaceId: f.workspace,
      connectionId: f.connection.id,
    });
    const [revokedHistory] = await listCloudRuntimeOperations(
      f.context,
      f.run,
      db,
    );
    expect(revokedHistory!.mcpAuthorization).toEqual({
      available: false,
      reason: 'connection_revoked',
    });
    expect(revokedHistory!.snapshot).toEqual(before!.snapshot);
    expect(revokedHistory!.result).toEqual(before!.result);
    expect(f.service.state.calls).toBe(1);
    const pending = await fixture();
    await pending.create();
    await pending.store.revoke(pending.context, {
      workspaceId: pending.workspace,
      connectionId: pending.connection.id,
    });
    expect(
      await cancelCloudRuntimeRun(pending.context, pending.run, db),
    ).toMatchObject({ accepted: true, remoteStopped: false });
    expect(pending.service.state.calls).toBe(0);
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
