import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type {
  RequestContext,
  RuntimeActionBinding,
  RuntimeActionApprovalRequest,
} from '@allrice/contracts';
import postgres from 'postgres';
import type * as DatabaseClient from './core/client.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decideConnectorApproval } from './capabilities/connector-broker.ts';
import {
  createRuntimePolicyAdmission,
  decideRuntimeActionApproval,
  getRuntimeActionApproval,
  requestRuntimeActionApproval,
  revokeRuntimeActionApproval,
  runtimePolicyDigest,
  setRuntimePolicyControls,
} from './runtime-policy.ts';

const run = process.env.ALLRICE_RUN_DB_INTEGRATION === '1';
const suite = run ? describe.sequential : describe.skip;
let admin: ReturnType<typeof postgres>;
let database: ReturnType<typeof postgres>;
// Route the real legacy service to this test's isolated PostgreSQL schema.
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof DatabaseClient>()),
  getDatabase: () => database,
}));
const schema = `runtime_policy_test_${randomUUID().replaceAll('-', '')}`;
const d = (value: unknown) => runtimePolicyDigest(value);

async function fixture(effect: 'allow' | 'ask' | 'deny' = 'ask') {
  const org = randomUUID(),
    workspace = randomUUID(),
    user = randomUUID(),
    policy = randomUUID();
  const runId = randomUUID(),
    target = randomUUID(),
    device = randomUUID(),
    grant = randomUUID();
  const membership = randomUUID();
  const policyPayload = {
    memberships: [
      {
        id: membership,
        userId: user,
        organizationId: org,
        workspaceId: workspace,
        role: 'admin',
        active: true,
      },
    ],
    grants: [
      { resourceType: 'job', action: 'job:execute', workspaceId: workspace },
    ],
  };
  const context: RequestContext = {
    requestId: randomUUID(),
    sessionId: randomUUID(),
    actor: { type: 'user', id: user },
    organizationId: org,
    workspaceId: workspace,
    memberships: [],
    authenticatedAt: new Date().toISOString(),
  };
  const binding: RuntimeActionBinding = {
    task: {
      scope: { organizationId: org, workspaceId: workspace, projectId: null },
      chatSessionId: null,
      runId,
      rootRunId: runId,
      parentRunId: null,
      frozenConfiguration: { employeeVersionId: null, digest: d({}) },
    },
    attempt: {
      operationId: randomUUID(),
      attemptId: randomUUID(),
      attemptNumber: 1,
      generation: 0,
      fence: 1,
    },
    requestedBy: { type: 'user', id: user },
    policy: { snapshotId: policy, digest: d(policyPayload) },
    execution: {
      targetId: target,
      targetKind: 'rice_bridge',
      deviceId: device,
      grantId: grant,
      grantVersion: 1,
      scopeDigest: `sha256:${'a'.repeat(64)}`,
      workCopy: { id: randomUUID(), kind: 'in_place' },
    },
    action: 'local.fs.write',
    inputDigest: d({ path: 'test.txt', content: 'synthetic' }),
    dataScope: [],
    baseline: [],
    command: null,
  };
  await database.begin(async (sql) => {
    await sql`insert into allrice_users(id,email,display_name,password_hash) values (${user},${`${user}@example.test`},'P04 synthetic','not-login')`;
    await sql`insert into allrice_organizations(id,slug,name) values (${org},${`test-${org}`},'P04 synthetic')`;
    await sql`insert into allrice_workspaces(id,organization_id,slug,name) values (${workspace},${org},'test','P04 synthetic')`;
    await sql`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values (${membership},${org},${workspace},${user},'admin')`;
    await sql`insert into allrice_policy_snapshots(id,organization_id,subject_id,version,payload,expires_at) values (${policy},${org},${user},1,${sql.json(policyPayload)},clock_timestamp()+interval '1 hour')`;
    await sql`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,policy_snapshot_id,execution_spec,input) values (${runId},${org},${workspace},${user},'running',${policy},'{}','{}')`;
    await sql`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities,concurrency_limit,timeout_seconds) values (${target},${org},${workspace},'bridge.test','rice_bridge','P04 target','online','[]',1,60)`;
    await sql`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash) values (${device},${org},${workspace},${user},'P04 device','macos-x64',2,array['local.fs.write'],${d(device).slice(7)})`;
    await sql`insert into allrice_bridge_folder_grants(id,organization_id,workspace_id,owner_id,device_id,label,root_fingerprint) values (${grant},${org},${workspace},${user},${device},'P04 temp root',${'a'.repeat(64)})`;
  });
  const controls = {
    version: 1,
    enabled: true,
    mode: 'execute',
    rules: [{ action: binding.action, effect }],
  };
  await setRuntimePolicyControls(context, controls, null, database);
  // Synthetic adapter state is independent of caller mutations, emulating re-resolved server payload.
  let currentBinding = structuredClone(binding);
  const options = {
    context,
    resolveCurrentBinding: async () => structuredClone(currentBinding),
  };
  const admission = createRuntimePolicyAdmission(options);
  async function admit(
    phase: 'create' | 'dispatch' | 'heartbeat' = 'dispatch',
    input = binding,
  ) {
    return database.begin((transaction) =>
      admission({ transaction, binding: input, phase, now: new Date() }),
    );
  }
  const request = () =>
    requestRuntimeActionApproval(options, binding, 600_000, database);
  async function approve(existingRequest?: RuntimeActionApprovalRequest) {
    const req = existingRequest ?? (await request());
    const response = {
      contractVersion: 1 as const,
      direction: 'response' as const,
      kind: 'action_approval' as const,
      requestId: req.requestId,
      version: req.version,
      requestDigest: req.requestDigest,
      task: req.task,
      responseId: randomUUID(),
      respondedBy: user,
      respondedAt: new Date().toISOString(),
      approvalId: req.approvalId,
      decision: 'approved' as const,
    };
    await decideRuntimeActionApproval(
      context,
      req.approvalId,
      response,
      database,
    );
    return { req, response };
  }
  return {
    context,
    binding,
    options,
    admit,
    request,
    approve,
    controls,
    membership,
    policyPayload,
    changeBinding: (value: RuntimeActionBinding) => {
      currentBinding = structuredClone(value);
    },
  };
}

suite('P04 real PostgreSQL policy / exact approval', () => {
  beforeAll(async () => {
    if (!process.env.ALLRICE_TEST_DATABASE_URL)
      throw Error('ALLRICE_TEST_DATABASE_URL required');
    admin = postgres(process.env.ALLRICE_TEST_DATABASE_URL, {
      max: 2,
      onnotice: () => {},
    });
    await admin.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(20260907, 1)`;
      await transaction`create extension if not exists vector with schema public`;
      await transaction`create extension if not exists pg_trgm with schema public`;
    });
    await admin.unsafe(`create schema ${schema}`);
    const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    database = postgres(url.toString(), { max: 12, onnotice: () => {} });
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(directory))
      .filter((file) => file.endsWith('.sql'))
      .sort())
      await database.unsafe(await readFile(new URL(file, directory), 'utf8'));
  }, 60_000);
  afterAll(async () => {
    await database?.end();
    if (admin) {
      if (!/^runtime_policy_test_[a-f0-9]{32}$/.test(schema))
        throw Error('invalid test schema');
      await admin.unsafe(`drop schema ${schema} cascade`);
      await admin.end();
    }
  });
  it('waits without consuming, preserves request identity and returns durable state', async () => {
    const f = await fixture();
    expect(await f.admit('create')).toEqual({ status: 'waiting_user' });
    const req = await f.request();
    expect((await f.request()).approvalId).toBe(req.approvalId);
    const stored = await getRuntimeActionApproval(
      f.context,
      req.approvalId,
      database,
    );
    expect(stored.request).toEqual(req);
    expect(stored.consumedAt).toBeNull();
    await expect(f.admit()).rejects.toThrow('approval_invalid_or_stale');
  });
  it('legacy connector approval cannot approve a runtime request; ordinary approvals still work', async () => {
    const f = await fixture();
    const req = await f.request();
    const context = {
      ...f.context,
      memberships: f.policyPayload.memberships,
    } as RequestContext;
    const decision = {
      workspaceId: f.context.workspaceId,
      decision: 'approved',
      reason: 'Synthetic old client',
    };
    await expect(
      decideConnectorApproval(context, req.approvalId, decision),
    ).rejects.toThrow('authorization_denied');
    expect(
      (await getRuntimeActionApproval(f.context, req.approvalId, database))
        .response,
    ).toBeNull();
    const id = randomUUID();
    await database`insert into allrice_approval_requests (id,organization_id,workspace_id,run_id,actor_id,resource_type,resource_id,action,input_digest)
      values (${id},${f.context.organizationId},${f.context.workspaceId},${f.binding.task.runId},${f.context.actor.id},'connector_call',${randomUUID()},'synthetic',${d('legacy')})`;
    await expect(
      decideConnectorApproval(context, id, decision),
    ).resolves.toEqual({ id, status: 'approved' });
  });
  it('allows exactly one of 12 concurrent consumptions; renewal does not consume again', async () => {
    const f = await fixture();
    await f.approve();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, () => f.admit()),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(11);
    await expect(f.admit('heartbeat')).resolves.toBeUndefined();
  });
  it('rolls consumption back when enclosing dispatch transaction fails', async () => {
    const f = await fixture();
    const { req } = await f.approve();
    await expect(
      database.begin(async (transaction) => {
        await createRuntimePolicyAdmission(f.options)({
          transaction,
          binding: f.binding,
          phase: 'dispatch',
          now: new Date(),
        });
        throw Error('injected_dispatch_failure');
      }),
    ).rejects.toThrow('injected_dispatch_failure');
    expect(
      (await getRuntimeActionApproval(f.context, req.approvalId, database))
        .consumedAt,
    ).toBeNull();
    await expect(f.admit()).resolves.toBeUndefined();
  });
  it('idempotent response replay does not repeat consumption or create another decision', async () => {
    const f = await fixture();
    const { req, response } = await f.approve();
    await f.admit();
    expect(
      await decideRuntimeActionApproval(
        f.context,
        req.approvalId,
        response,
        database,
      ),
    ).toEqual(response);
    await expect(
      decideRuntimeActionApproval(
        f.context,
        req.approvalId,
        { ...response, responseId: randomUUID() },
        database,
      ),
    ).rejects.toThrow('approval_response_conflict');
    await expect(f.admit()).rejects.toThrow('approval_already_consumed');
  });
  it('rejects Ask User/plan acknowledgement as execution permission', async () => {
    const f = await fixture();
    const req = await f.request();
    await expect(
      decideRuntimeActionApproval(
        f.context,
        req.approvalId,
        { kind: 'ask_user', decision: 'approved' },
        database,
      ),
    ).rejects.toThrow();
    await expect(f.admit()).rejects.toThrow('approval_invalid_or_stale');
  });
  it('cross-tenant reads and response attempts reveal no approval', async () => {
    const a = await fixture(),
      b = await fixture();
    const { req, response } = await a.approve();
    await expect(
      getRuntimeActionApproval(b.context, req.approvalId, database),
    ).rejects.toThrow('approval_not_found');
    await expect(
      decideRuntimeActionApproval(
        b.context,
        req.approvalId,
        response,
        database,
      ),
    ).rejects.toThrow('approval_not_found');
    await expect(b.admit('dispatch', a.binding)).rejects.toThrow(
      'binding_scope_mismatch',
    );
  });
  it('re-reads memberships instead of trusting old context snapshots', async () => {
    const f = await fixture();
    await f.approve();
    await database`update allrice_memberships set active=false where id=${f.membership}`;
    await expect(f.admit()).rejects.toThrow('membership_denied');
    await expect(
      setRuntimePolicyControls(
        f.context,
        { ...f.controls, version: 2 },
        1,
        database,
      ),
    ).rejects.toThrow('membership_denied');
  });
  it('disabled actor cannot consume old approval', async () => {
    const f = await fixture();
    await f.approve();
    await database`update allrice_users set status='disabled' where id=${f.context.actor.id}`;
    await expect(f.admit()).rejects.toThrow('membership_denied');
  });
  it('tenant Deny and plan-only override an existing approval', async () => {
    for (const change of [
      { rules: [{ action: 'local.fs.write', effect: 'deny' }] },
      { mode: 'plan_only' },
    ]) {
      const f = await fixture();
      await f.approve();
      await setRuntimePolicyControls(
        f.context,
        { ...f.controls, ...change, version: 2 },
        1,
        database,
      );
      await expect(f.admit()).rejects.toThrow();
    }
  });
  it('policy revisions cannot consume older permission even if still Ask', async () => {
    const f = await fixture();
    await f.approve();
    await setRuntimePolicyControls(
      f.context,
      { ...f.controls, version: 2 },
      1,
      database,
    );
    await expect(f.admit()).rejects.toThrow('approval_invalid_or_stale');
  });
  it('grant and device revocation deny dispatch and renewal', async () => {
    for (const revokeDevice of [false, true]) {
      const f = await fixture();
      await f.approve();
      await f.admit();
      if (revokeDevice)
        await database`update allrice_bridge_devices set revoked_at=clock_timestamp() where id=${f.binding.execution.deviceId}`;
      else
        await database`update allrice_bridge_folder_grants set revoked_at=clock_timestamp() where id=${f.binding.execution.grantId}`;
      await expect(f.admit('heartbeat')).rejects.toThrow(
        'grant_revoked_or_changed',
      );
    }
  });
  it('approval revocation does not falsely report process stopped', async () => {
    const f = await fixture();
    const { req } = await f.approve();
    await f.admit();
    expect(
      await revokeRuntimeActionApproval(f.context, req.approvalId, database),
    ).toEqual({ revoked: true, executionStopped: false });
    await expect(f.admit('heartbeat')).rejects.toThrow(
      'approval_invalid_or_stale',
    );
  });
  it('revoked execution target never inherits an old Allow', async () => {
    const f = await fixture('allow');
    await database`update allrice_execution_targets set state='revoked' where id=${f.binding.execution.targetId}`;
    await expect(f.admit()).rejects.toThrow('target_unavailable');
  });
  it('old clients reselecting the same folder cannot resurrect old approvals', async () => {
    const f = await fixture();
    await f.approve();
    const execution = f.binding.execution;
    await database`update allrice_bridge_folder_grants set revoked_at=clock_timestamp() where id=${execution.grantId}`;
    await database`insert into allrice_bridge_folder_grants
      (organization_id,workspace_id,owner_id,device_id,label,root_fingerprint)
      values (${f.context.organizationId},${f.context.workspaceId},${f.context.actor.id},${execution.deviceId},'Reselected',${'a'.repeat(64)})
      on conflict (device_id,root_fingerprint) do update set label=excluded.label,revoked_at=null`;
    const [row] =
      await database`select id,runtime_generation from allrice_bridge_folder_grants where id=${execution.grantId}`;
    expect(row?.id).toBe(execution.grantId);
    expect(row?.runtime_generation).toBe(3);
    await expect(f.admit()).rejects.toThrow('grant_revoked_or_changed');
    await database`update allrice_bridge_folder_grants set label='Only label',runtime_generation=1 where id=${execution.grantId}`;
    const [after] =
      await database`select runtime_generation from allrice_bridge_folder_grants where id=${execution.grantId}`;
    expect(after?.runtime_generation).toBe(3);
  });
  it('rechecks expiration after adapter work, including an Allow with no approval', async () => {
    const f = await fixture('allow');
    let resolved = false;
    await database`update allrice_policy_snapshots set expires_at=clock_timestamp()+interval '1 second' where id=${f.binding.policy.snapshotId}`;
    const admission = createRuntimePolicyAdmission({
      ...f.options,
      resolveCurrentBinding: async ({ transaction }) => {
        resolved = true;
        await transaction`select pg_sleep(1.1)`;
        return f.binding;
      },
    });
    await expect(
      database.begin((transaction) =>
        admission({
          transaction,
          binding: f.binding,
          phase: 'dispatch',
          now: new Date(0),
        }),
      ),
    ).rejects.toThrow('frozen_policy_invalid');
    expect(resolved).toBe(true);
  });
  it('rejects expired approval using DB time, not caller time', async () => {
    const f = await fixture();
    const { req } = await f.approve();
    await database`update allrice_approval_requests set requested_at=clock_timestamp()-interval '2 hours',runtime_expires_at=clock_timestamp()-interval '1 hour' where id=${req.approvalId}`;
    await expect(f.admit()).rejects.toThrow('approval_invalid_or_stale');
  });
  it('input/file baseline changed after approval requires a new exact review', async () => {
    const f = await fixture();
    await f.approve();
    f.changeBinding({
      ...f.binding,
      inputDigest: d({ path: 'other.txt', content: 'changed' }),
    });
    await expect(f.admit()).rejects.toThrow('execution_binding_changed');
  });
  it('attempt, target, scope and command changes cannot reuse approval', async () => {
    const f = await fixture();
    await f.approve();
    const variants = [
      {
        ...f.binding,
        attempt: { ...f.binding.attempt, attemptId: randomUUID() },
      },
      {
        ...f.binding,
        execution: { ...f.binding.execution, targetId: randomUUID() },
      },
      { ...f.binding, execution: { ...f.binding.execution, grantVersion: 2 } },
      {
        ...f.binding,
        command: {
          executableDigest: d('e'),
          argumentsDigest: d('args'),
          workingDirectoryDigest: d('cwd'),
          effectiveEnvironmentDigest: d('env'),
          networkPolicyDigest: d('net'),
          toolchainDigest: d('v'),
          budgetDigest: d('budget'),
        },
      },
    ];
    for (const value of variants)
      await expect(f.admit('dispatch', value)).rejects.toThrow();
  });
  it('frozen Run and policy payload tampering deny', async () => {
    for (const policy of [false, true]) {
      const f = await fixture('allow');
      if (policy)
        await database`update allrice_policy_snapshots set payload='{"changed":true}' where id=${f.binding.policy.snapshotId}`;
      else
        await database`update allrice_runs set execution_spec='{"changed":true}' where id=${f.binding.task.runId}`;
      await expect(f.admit()).rejects.toThrow();
    }
  });
  it('terminal run cannot resume by approval', async () => {
    const f = await fixture();
    await f.approve();
    await database`update allrice_runs set state='canceled' where id=${f.binding.task.runId}`;
    await expect(f.admit()).rejects.toThrow(
      'run_or_frozen_configuration_changed',
    );
  });
  it('explicit Allow works but cannot override platform Deny', async () => {
    const f = await fixture('allow');
    await expect(f.admit()).resolves.toBeUndefined();
    await expect(
      database.begin((transaction) =>
        createRuntimePolicyAdmission({
          ...f.options,
          platformDeniedActions: [f.binding.action],
        })({
          transaction,
          binding: f.binding,
          phase: 'dispatch',
          now: new Date(),
        }),
      ),
    ).rejects.toThrow('platform_deny');
  });
  it('fresh default has no auto-enabled policy', async () => {
    const f = await fixture('allow');
    await database`delete from allrice_runtime_policy_controls where organization_id=${f.context.organizationId}`;
    await expect(f.admit()).rejects.toThrow(
      'runtime_policy_missing_or_invalid',
    );
  });
  it('expired frozen policy cannot authorize execution', async () => {
    const f = await fixture('allow');
    await database`update allrice_policy_snapshots set issued_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' where id=${f.binding.policy.snapshotId}`;
    await expect(f.admit()).rejects.toThrow('frozen_policy_invalid');
  });
  it('policy expiry while waiting on the approval row cannot authorize dispatch', async () => {
    const f = await fixture();
    const { req } = await f.approve();
    await database`update allrice_policy_snapshots set expires_at=clock_timestamp()+interval '800 milliseconds' where id=${f.binding.policy.snapshotId}`;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = database.begin(async (transaction) => {
      await transaction`select id from allrice_approval_requests where id=${req.approvalId} for update`;
      locked();
      await transaction`select pg_sleep(1.2)`;
    });
    await ready;
    await expect(f.admit()).rejects.toThrow('frozen_policy_invalid');
    await holder;
    expect(
      (await getRuntimeActionApproval(f.context, req.approvalId, database))
        .consumedAt,
    ).toBeNull();
  });
  it('cannot approve after the run ends or the local grant is revoked', async () => {
    for (const revokeGrant of [false, true]) {
      const f = await fixture();
      const req = await f.request();
      if (revokeGrant)
        await database`update allrice_bridge_folder_grants set revoked_at=clock_timestamp() where id=${f.binding.execution.grantId}`;
      else
        await database`update allrice_runs set state='canceled' where id=${f.binding.task.runId}`;
      await expect(f.approve(req)).rejects.toThrow(
        revokeGrant
          ? 'grant_revoked_or_changed'
          : 'run_or_frozen_configuration_changed',
      );
      expect(
        (await getRuntimeActionApproval(f.context, req.approvalId, database))
          .response,
      ).toBeNull();
    }
  });
  it('a correctly digested but malformed or unprivileged snapshot still denies', async () => {
    for (const payload of [{}, { memberships: [], grants: [] }]) {
      const f = await fixture('allow');
      await database`update allrice_policy_snapshots set payload=${database.json(payload)} where id=${f.binding.policy.snapshotId}`;
      const binding = {
        ...f.binding,
        policy: { ...f.binding.policy, digest: d(payload) },
      };
      f.changeBinding(binding);
      await expect(f.admit('dispatch', binding)).rejects.toThrow(
        'frozen_policy_permission_denied',
      );
    }
  });
  it('audit records references/digests, never raw arguments or secret values', async () => {
    const f = await fixture();
    await f.approve();
    await f.admit();
    const rows =
      await database`select metadata from allrice_audit_events where organization_id=${f.context.organizationId}`;
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(rows)).not.toContain('test.txt');
    expect(JSON.stringify(rows)).not.toContain('synthetic');
  });
});
