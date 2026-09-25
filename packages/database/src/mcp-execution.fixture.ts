import { updateWorkAutomation } from './work-automation.ts';
/** Synthetic fixture only; never imported by the production Worker. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import {
  ExecutionContextSchema,
  EmployeeExecutionSnapshotSchema,
  type RequestContext,
} from '@allrice/contracts';
import { createMcpStore } from './mcp-connections.ts';
import { createEmployeeMcpBindingStore } from './mcp-employee-bindings.ts';
import { employeeManifest } from './employees/employee-config.ts';
import { prepareEmployeeRunBinding } from './employees/employeehub.ts';
import { createMcpRuntimeOperation } from './mcp-execution.ts';
import {
  setRuntimePolicyControls,
  getRuntimeActionApproval,
  decideRuntimeActionApproval,
  runtimePolicyDigest as digest,
} from './runtime-policy.ts';
import { startMcpAcceptanceService } from '../../../apps/worker/src/mcp/test-service.js';
import { createMcpTransport } from '../../../apps/worker/src/mcp/transport.js';
import { executeNextMcpDiscovery } from '../../../apps/worker/src/mcp/lifecycle.js';
import { runMcpRuntimeOperation } from '../../../apps/worker/src/mcp/executor.js';
// Web integration suites reuse the database package's declared test dependency
// instead of adding a direct production postgres dependency to the Web app.
export const createMcpFixtureDatabase = postgres;
/** Synthetic scoped Worker+frozen Run fixtures. Real PG policy, approvals,
 * operation leases and authenticated owned MCP HTTP; no personal connectors,
 * real model or public TLS/frontend route is claimed by this suite. */
export async function createMcpExecutionFixture(
  db: ReturnType<typeof postgres>,
  options: {
    bind?: boolean;
    deniedCapabilities?: ('secret:use' | 'network:outbound')[];
    authorize?: (scope: {
      user: string;
      org: string;
      workspace: string;
      employee: string;
      version: string;
      session: string;
      connectionId: string;
    }) => Promise<void>;
  } = {},
) {
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
    lease = randomUUID(),
    um = randomUUID(),
    am = randomUUID();
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
  try {
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
    assert.equal(
      await executeNextMcpDiscovery({
        workerId: worker,
        signal: AbortSignal.timeout(10000),
        store,
        transport,
      }),
      true,
    );
    const [list] = await store.list(context, workspace);
    for (const tool of list!.tools)
      await store.grant(context, {
        workspaceId: workspace,
        connectionId: connection.id,
        revisionId: tool.revisionId,
        allowed: true,
        risk: tool.name === 'records.list' ? 'read_only' : 'write',
      });
    const manifest = employeeManifest({
      key: 'p16',
      name: 'P16',
      description: 'Synthetic MCP employee',
      toolNames: ['cloud.mcp.call', 'web.fetch'],
      securityPolicy: {
        dataScopes: ['workspace'],
        connectorIdentityModes: ['service'],
        approvalPolicy: 'confirm_side_effects',
        deniedCapabilities: options.deniedCapabilities ?? [],
      },
    });
    await db.begin(async (tx) => {
      await tx`insert into allrice_policy_snapshots(id,organization_id,subject_id,version,payload,expires_at) values(${policy},${org},${user},1,${tx.json(policyPayload)},clock_timestamp()+interval '1 hour')`;
      await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,policy_snapshot_id,execution_spec,input) values(${run},${org},${workspace},${user},'running',${policy},'{}','{}')`;
      await tx`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name) values(${employee},${org},${workspace},'p16','P16')`;
      await tx`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot) values(${version},${org},${workspace},${employee},1,'P16',${manifest.provider.model},${manifest.systemPrompt},${tx.json(manifest.capabilities)},${digest(manifest)},${tx.json(manifest)},${tx.json(manifest.provider)})`;
      await tx`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id) values(${assignment},${org},${workspace},${employee},${version},${user})`;
      await tx`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id) values(${session},${org},${workspace},${user},'P16 synthetic',${assignment},${version})`;
      await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content) values(${um},${org},${workspace},${session},${user},'user','{"text":"synthetic","citations":[]}'),(${am},${org},${workspace},${session},${user},'assistant','{"text":"synthetic","citations":[]}')`;
      await tx`insert into allrice_conversation_runtimes(organization_id,workspace_id,session_id,owner_id,thread_generation,config_checksum,state,active_run_id,worker_id) values(${org},${workspace},${session},${user},1,${digest('p16')},'running',${run},${worker})`;
      await tx`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at) values(${job},${org},${workspace},${user},${run},'running',${randomUUID()},clock_timestamp()+interval '5 minutes','{"schemaVersion":1,"type":"allrice.employee.run","input":{}}',${worker},${lease},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '5 minutes')`;
    });
    const employeeBindings = createEmployeeMcpBindingStore({ database: db });
    const prepare = () =>
      prepareEmployeeRunBinding({
        context,
        workspaceId: workspace,
        assignmentId: assignment,
        employeeVersionId: version,
        sessionId: session,
        userMessageId: um,
        assistantMessageId: am,
        promptSnapshot: {
          systemPrompt: 'synthetic',
          conversation: [],
          memories: [],
          userRequest: 'Use the owned MCP service',
        },
      });
    const beforeBinding = await prepare();
    await options.authorize?.({
      user,
      org,
      workspace,
      employee,
      version,
      session,
      connectionId: connection.id,
    });
    const employeeGrant =
      options.bind === false
        ? null
        : await employeeBindings.bind(context, {
            workspaceId: workspace,
            connectionId: connection.id,
            employeeId: employee,
            employeeVersionId: version,
            expectedRevision: 0,
            enabled: true,
          });
    const prepared = await prepare();
    const snapshot = EmployeeExecutionSnapshotSchema.parse({
      ...prepared.executionSnapshot,
      tenantContext: {
        organizationId: org,
        workspaceId: workspace,
        actorId: user,
        policySnapshotId: policy,
      },
      createdAt: now,
    });
    if (snapshot.schemaVersion !== 2) throw Error('expected v2 snapshot');
    const mcpTools = snapshot.mcpTools!;
    await db`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,native_skills,execution_snapshot) values(${run},${org},${workspace},${user},${assignment},${version},${session},${um},${am},${db.json(prepared.providerSnapshot)},${db.json(prepared.promptSnapshot)},${db.json(prepared.nativeSkills)},${db.json(JSON.parse(JSON.stringify(snapshot)))})`;
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
    await updateWorkAutomation(
      context,
      workspace,
      { expectedRevision: 0, capability: 'cloud', enabled: false },
      db,
    );
    await updateWorkAutomation(
      context,
      workspace,
      { expectedRevision: 1, capability: 'computer', enabled: false },
      db,
    );
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
      employee,
      version,
      assignment,
      session,
      employeeBindings,
      employeeGrant,
      beforeBinding,
      prepared,
      snapshot,
      prepare,
    };
  } catch (error) {
    await service.close();
    throw error;
  }
}
