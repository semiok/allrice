import { createHash, randomUUID } from 'node:crypto';
import {
  readFile,
  readdir,
  mkdtemp,
  mkdir,
  realpath,
  writeFile,
  rm,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as Playwright from '../../../apps/worker/node_modules/playwright-core/index.js';

import {
  BridgeCommandPayloadSchema,
  BridgeDeviceSchema,
  RuntimeOperationSnapshotSchema,
  type BridgeCommandPayload,
  type RequestContext,
  type RuntimeActionBinding,
  EmployeeExecutionSnapshotSchema,
  ExecutionContextSchema,
  RuntimeLocalCommandResultSchema,
  localCommandToolchainImageV1,
} from '@allrice/contracts';
import postgres from 'postgres';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  createLocalCommandOperation,
  listLocalCommandOperations,
  cancelLocalCommandRun,
} from './local-command-service.ts';
import { reportLocalCommandProfile } from './local-command-profile.ts';
import { LocalCommandRunner } from '../../../apps/rice-bridge/src/local-command-runner.js';
import { BridgeJournal } from '../../../apps/rice-bridge/src/journal.js';
import { RuntimeBridgeOperationClient } from '../../../apps/rice-bridge/src/operation-client.js';
import { createRuntimeBridgeHttpHandler } from '../../../apps/web/lib/bridge/operation-http.js';

import { createGovernedBridgeOperationLedger } from './runtime-governed-bridge.ts';
import {
  decideRuntimeActionApproval,
  getRuntimeActionApproval,
  requestRuntimeActionApproval,
  runtimePolicyDigest as digest,
  setRuntimePolicyControls,
} from './runtime-policy.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
let admin: ReturnType<typeof postgres>;
let database: ReturnType<typeof postgres>;
const schema = `runtime_bridge_test_${randomUUID().replaceAll('-', '')}`;

async function fixture(
  effect: 'allow' | 'ask' | 'deny' = 'ask',
  chat = false,
  root = true,
  makeSnapshot?: (ids: {
    employeeId: string;
    versionId: string;
    assignmentId: string;
    org: string;
    workspace: string;
    user: string;
    policy: string;
  }) => unknown,
) {
  const org = randomUUID(),
    workspace = randomUUID(),
    user = randomUUID(),
    run = randomUUID();
  const policy = randomUUID(),
    membership = randomUUID(),
    deviceId = randomUUID(),
    grant = randomUUID(),
    target = randomUUID();
  const context: RequestContext = {
    actor: { type: 'user', id: user },
    organizationId: org,
    workspaceId: workspace,
    requestId: randomUUID(),
    sessionId: randomUUID(),
    memberships: [],
    authenticatedAt: new Date().toISOString(),
  };
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
  const employeeId = randomUUID(),
    versionId = randomUUID(),
    assignmentId = randomUUID(),
    sessionId = randomUUID();
  const executionSpec = { employeeVersionId: chat ? versionId : null };
  await database.begin(async (tx) => {
    await tx`insert into allrice_users(id,email,display_name,password_hash) values(${user},${`${user}@example.test`},'B1 assembly','not-login')`;
    await tx`insert into allrice_organizations(id,slug,name) values(${org},${`assembly-${org}`},'B1 assembly')`;
    await tx`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspace},${org},'test','B1 assembly')`;
    await tx`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${membership},${org},${workspace},${user},'admin')`;
    await tx`insert into allrice_policy_snapshots(id,organization_id,subject_id,version,payload,expires_at)
      values(${policy},${org},${user},1,${tx.json(policyPayload)},clock_timestamp()+interval '1 hour')`;
    await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,policy_snapshot_id,execution_spec,input)
      values(${run},${org},${workspace},${user},'running',${policy},${tx.json(executionSpec)},'{}')`;
    await tx`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at)
      values(${deviceId},${org},${workspace},${user},'B1 device','macos-x64',2,array['local.fs.write','local.fs.list'],${digest(deviceId).slice(7)},clock_timestamp())`;
    await tx`insert into allrice_bridge_folder_grants(id,organization_id,workspace_id,owner_id,device_id,label,root_fingerprint)
      values(${grant},${org},${workspace},${user},${deviceId},'B1 root',${'a'.repeat(64)})`;
    await tx`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities,metadata)
      values(${target},${org},${workspace},${`bridge.${deviceId}`},'rice_bridge','B1 device','online',
        ${tx.json(['files.read', 'files.write'])},${tx.json({ bridgeDeviceId: deviceId })})`;
    if (chat) {
      await tx`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name)
        values(${employeeId},${org},${workspace},'assembly','B1 employee')`;
      await tx`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum)
        values(${versionId},${org},${workspace},${employeeId},1,'B1 frozen employee','synthetic','synthetic','[]',${digest('employee')})`;
      await tx`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id)
        values(${assignmentId},${org},${workspace},${employeeId},${versionId},${user})`;
      await tx`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
        values(${sessionId},${org},${workspace},${user},'B1 chat',${assignmentId},${versionId})`;
      const userMessage = randomUUID(),
        assistantMessage = randomUUID();
      await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
        values(${userMessage},${org},${workspace},${sessionId},${user},'user','{}'),
          (${assistantMessage},${org},${workspace},${sessionId},${user},'assistant','{}')`;
      await tx`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,
        employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,execution_snapshot)
        values(${run},${org},${workspace},${user},${assignmentId},${versionId},${sessionId},${userMessage},${assistantMessage},'{}','{}',
          ${tx.json(JSON.parse(JSON.stringify(makeSnapshot?.({ employeeId, versionId, assignmentId, org, workspace, user, policy }) ?? {})))})`;
      await tx`insert into allrice_conversation_runtimes(organization_id,workspace_id,session_id,owner_id,thread_generation,config_checksum,state,active_run_id,worker_id)
        values(${org},${workspace},${sessionId},${user},3,${digest('runtime')},'running',${run},${randomUUID()})`;
    }
  });
  await setRuntimePolicyControls(
    context,
    {
      version: 1,
      enabled: true,
      mode: 'execute',
      rules: [
        { action: 'local.fs.write', effect },
        { action: 'local.fs.list', effect },
      ],
    },
    null,
    database,
  );
  const now = new Date().toISOString();
  const device = BridgeDeviceSchema.parse({
    id: deviceId,
    organizationId: org,
    workspaceId: workspace,
    ownerId: user,
    name: 'B1 device',
    platform: 'macos-x64',
    protocolVersion: 2,
    capabilities: ['local.fs.write', 'local.fs.list'],
    status: 'online',
    lastSeenAt: now,
    createdAt: now,
    revokedAt: null,
  });
  const task = {
    scope: { organizationId: org, workspaceId: workspace, projectId: null },
    runId: run,
    rootRunId: run,
    parentRunId: null,
    chatSessionId: chat ? sessionId : null,
    frozenConfiguration: {
      employeeVersionId: executionSpec.employeeVersionId,
      digest: digest(executionSpec),
    },
  };
  const ledger = () =>
    createGovernedBridgeOperationLedger(device, { database });
  if (root)
    await ledger().createRoot({
      task,
      deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
      budgets: [
        {
          metric: 'tool_calls',
          unit: 'calls',
          currency: null,
          capacity: 100,
          source: { kind: 'bridge', sourceId: deviceId },
        },
      ],
    });
  function operation(
    raw: BridgeCommandPayload = {
      capability: 'local.fs.write',
      arguments: {
        path: 'test.txt',
        content: 'synthetic',
        expectedSha256: null,
      },
    },
  ) {
    const payload = BridgeCommandPayloadSchema.parse(raw);
    const binding: RuntimeActionBinding = {
      task,
      attempt: {
        operationId: randomUUID(),
        attemptId: randomUUID(),
        attemptNumber: 1,
        generation: chat ? 3 : 0,
        fence: 1,
      },
      requestedBy: { type: 'user', id: user },
      policy: { snapshotId: policy, digest: digest(policyPayload) },
      execution: {
        targetId: target,
        targetKind: 'rice_bridge',
        deviceId,
        grantId: grant,
        grantVersion: 1,
        scopeDigest: `sha256:${'a'.repeat(64)}`,
        workCopy: { id: grant, kind: 'in_place' },
      },
      action: payload.capability,
      inputDigest: digest(payload),
      dataScope: [],
      baseline: [],
      command: null,
    };
    const input = {
      snapshot: RuntimeOperationSnapshotSchema.parse({
        contractVersion: 1,
        binding,
        stepId: null,
        agentInstanceId: null,
        processId: null,
        cancelRequestId: null,
        idempotencyKey: randomUUID(),
        status: 'planned',
        result: null,
      }),
      bridgePayload: payload,
      reservations: [
        {
          metric: 'tool_calls' as const,
          accountingId: randomUUID(),
          amount: 1,
        },
      ],
    };
    const factory = () =>
      createGovernedBridgeOperationLedger(device, {
        database,
        initialOperation: {
          binding: input.snapshot.binding,
          payload: input.bridgePayload,
        },
      });
    async function approve() {
      const req = await requestRuntimeActionApproval(
        ledger().policyOptions,
        input.snapshot.binding,
        600_000,
        database,
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
          respondedAt: new Date().toISOString(),
          approvalId: req.approvalId,
          decision: 'approved',
        },
        database,
      );
      return req;
    }
    return { input, factory, approve };
  }
  const claim = () =>
    ledger().claimNextBridgeOperation({
      scope: task.scope,
      deviceId,
      leaseMs: 30_000,
    });
  return {
    context,
    device,
    task,
    ledger,
    operation,
    claim,
    grant,
    target,
    run,
    policy,
    membership,
    sessionId,
    versionId,
    employeeId,
    assignmentId,
    policyPayload,
  };
}

async function commandFixture(toolNames = ['local.process.execute']) {
  vi.stubEnv('ALLRICE_LOCAL_COMMAND_ENABLED', '1');
  vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
  vi.stubEnv('ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED', '1');
  const now = new Date().toISOString();
  const capabilities = ['model:invoke', 'storage:read', 'storage:write'];
  const f = await fixture('allow', true, false, (ids) => {
    const frozen = EmployeeExecutionSnapshotSchema.parse({
      schemaVersion: 1,
      employee: {
        id: ids.employeeId,
        versionId: ids.versionId,
        key: 'fixture',
        revision: 1,
        definitionChecksum: digest('fixture'),
        definition: {
          schemaVersion: 1,
          key: 'fixture',
          name: 'P05 Fixture',
          description: 'Synthetic tests only',
          systemPrompt: 'Synthetic tests only',
          provider: {
            provider: 'basic',
            authMode: 'none',
            model: 'allrice/basic-assistant-v1',
            reasoningEffort: 'none',
            sandbox: 'none',
          },
          capabilities,
          skillVersionIds: [],
        },
      },
      assignment: {
        id: ids.assignmentId,
        userId: ids.user,
        assignedBy: ids.user,
        assignedAt: now,
      },
      runtimePolicy: {
        harness: 'dsh',
        provider: 'openai-codex',
        model: 'fixture',
        reasoningEffort: 'high',
        timeoutMs: 300000,
        fallbackModels: [],
        credentialReference: 'test:never-resolved',
      },
      capabilitySnapshot: {
        declaredCapabilities: capabilities,
        grantedCapabilities: capabilities,
        bindings: {
          skillVersionIds: [],
          toolNames,
          knowledgeScopes: ['workspace'],
          workflowIds: [],
        },
        skillBindings: [],
      },
      tenantContext: {
        organizationId: ids.org,
        workspaceId: ids.workspace,
        actorId: ids.user,
        policySnapshotId: ids.policy,
      },
      userProfile: {
        schemaVersion: 1,
        displayName: 'P05 synthetic',
        preferences: {},
      },
      createdAt: now,
    });
    return frozen;
  });
  const jobId = randomUUID(),
    workerId = randomUUID();
  await database`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at)
    values(${jobId},${f.context.organizationId},${f.context.workspaceId},${f.context.actor.id},${f.run},'running',${randomUUID()},clock_timestamp()+interval '5 minutes','{}',
      ${workerId},${randomUUID()},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '5 minutes')`;
  await setRuntimePolicyControls(
    f.context,
    {
      version: 2,
      enabled: true,
      mode: 'execute',
      rules: [{ action: 'local.process.execute', effect: 'allow' }],
    },
    1,
    database,
  );
  const imageDigest =
    process.env.ALLRICE_LOCAL_DOCKER_TEST_IMAGE ?? localCommandToolchainImageV1;
  await reportLocalCommandProfile(
    f.device,
    {
      contractVersion: 1,
      backend: 'local-vm-container-v1',
      imageDigest,
      architecture: 'amd64',
      available: true,
    },
    database,
  );
  const execution = ExecutionContextSchema.parse({
    executionId: randomUUID(),
    runId: f.run,
    jobId,
    worker: { type: 'worker', id: workerId },
    delegatedBy: f.context.actor,
    organizationId: f.context.organizationId,
    workspaceId: f.context.workspaceId,
    policySnapshot: {
      id: f.policy,
      organizationId: f.context.organizationId,
      subjectId: f.context.actor.id,
      version: 1,
      issuedAt: now,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      ...f.policyPayload,
    },
    startedAt: now,
  });
  const args = {
    executable: '/usr/local/bin/node',
    args: ['test.mjs'],
    path: '.',
    files: [{ path: 'test.mjs', sha256: digest('synthetic') }],
    limits: {
      timeoutMs: 10000,
      outputBytes: 8192,
      memoryMiB: 128,
      cpuMillis: 500,
      pids: 32,
    },
  };
  const create = (callId = 'p05-call', argumentsInput: unknown = args) =>
    createLocalCommandOperation(
      { context: execution, arguments: argumentsInput, callId },
      database,
    );
  const claim = (supportsLocalCommand = true) =>
    f.ledger().claimNextBridgeOperation({
      scope: f.task.scope,
      deviceId: f.device.id,
      leaseMs: 30000,
      supportsLocalCommand,
    });
  async function approve(decision: 'approved' | 'rejected' = 'approved') {
    const [op] = await listLocalCommandOperations(f.context, f.run, database);
    const req = op!.approval!.request;
    return decideRuntimeActionApproval(
      f.context,
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
        respondedBy: f.context.actor.id,
        respondedAt: new Date().toISOString(),
        approvalId: req.approvalId,
        decision,
      },
      database,
    );
  }
  return { ...f, execution, args, create, claim, approve, imageDigest };
}

suite('B1 production Bridge authority assembly / real PostgreSQL', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeAll(async () => {
    if (!process.env.ALLRICE_TEST_DATABASE_URL)
      throw Error('ALLRICE_TEST_DATABASE_URL required');
    admin = postgres(process.env.ALLRICE_TEST_DATABASE_URL, {
      max: 2,
      onnotice: () => {},
    });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(20260907, 1)`;
      await tx`create extension if not exists vector with schema public`;
      await tx`create extension if not exists pg_trgm with schema public`;
    });
    await admin.unsafe(`create schema ${schema}`);
    const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    database = postgres(url.toString(), { max: 12, onnotice: () => {} });
    const migrations = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(migrations))
      .filter((f) => f.endsWith('.sql'))
      .sort())
      await database.unsafe(await readFile(new URL(file, migrations), 'utf8'));
    // Delays only explicitly named synthetic operations, after normal admission.
    await database`create table b1_test_write_delay(operation_id uuid primary key,event_kind text not null)`;
    await database.unsafe(`create function b1_test_event_delay() returns trigger language plpgsql as $$
      begin
        if exists(select 1 from b1_test_write_delay where operation_id=new.operation_id
          and event_kind=new.payload->'signal'->>'type') then perform pg_sleep(0.8); end if;
        return new;
      end; $$;
      create trigger b1_test_event_delay before insert on allrice_runtime_operation_events
        for each row execute function b1_test_event_delay();
      create function b1_test_lease_delay() returns trigger language plpgsql as $$
      begin
        if new.lease_expires_at is distinct from old.lease_expires_at
          and exists(select 1 from b1_test_write_delay where operation_id=new.id and event_kind='lease_update')
          then perform pg_sleep(0.8); end if;
        return new;
      end; $$;
      create trigger b1_test_lease_delay before update on allrice_runtime_operations
        for each row execute function b1_test_lease_delay();`);
  }, 60_000);
  afterAll(async () => {
    await database?.end();
    if (admin) {
      if (!/^runtime_bridge_test_[a-f0-9]{32}$/.test(schema))
        throw Error('invalid isolated schema');
      await admin.unsafe(`drop schema ${schema} cascade`);
      await admin.end();
    }
  });
  it('P05 requires exact approval even for tenant Allow; old clients cannot claim commands', async () => {
    const f = await commandFixture();
    const created = await f.create();
    expect(created.snapshot.status).toBe('waiting_user');
    expect(await f.claim()).toBeNull();
    await f.approve();
    expect(await f.claim(false)).toBeNull();
    const claim = await f.claim();
    expect(claim?.bridgePayload?.capability).toBe('local.process.execute');
    const retry = await f.create();
    expect(retry.snapshot.binding).toEqual(created.snapshot.binding);
    expect(await f.claim()).toBeNull();
  });
  it('P05 rejects same-call mutations, expired profiles, unverified platforms and frozen tool removal', async () => {
    const f = await commandFixture();
    await f.create();
    await expect(
      f.create('p05-call', { ...f.args, args: ['other.mjs'] }),
    ).rejects.toThrow('idempotency_conflict');
    await f.approve();
    await database`update allrice_bridge_runtime_profiles set reported_at=clock_timestamp()-interval '91 seconds' where device_id=${f.device.id}`;
    expect(await f.claim()).toBeNull();
    await database`update allrice_bridge_runtime_profiles set reported_at=clock_timestamp() where device_id=${f.device.id}`;
    await expect(
      reportLocalCommandProfile(
        { ...f.device, platform: 'macos-arm64' },
        {
          contractVersion: 1,
          backend: 'local-vm-container-v1',
          imageDigest: f.imageDigest,
          architecture: 'arm64',
          available: true,
        },
        database,
      ),
    ).rejects.toThrow('target_unavailable');
    const without = await commandFixture([]);
    await expect(without.create('new-call')).rejects.toThrow();
  });
  it('P05 isolates browser reads and cancel intent by owner, tenant and membership', async () => {
    const f = await commandFixture();
    await f.create();
    expect(
      await listLocalCommandOperations(f.context, f.run, database),
    ).toHaveLength(1);
    for (const context of [
      { ...f.context, actor: { type: 'user' as const, id: randomUUID() } },
      { ...f.context, organizationId: randomUUID() },
      { ...f.context, workspaceId: randomUUID() },
    ]) {
      await expect(
        listLocalCommandOperations(context, f.run, database),
      ).rejects.toThrow('operation_not_found');
      await expect(
        cancelLocalCommandRun(context, f.run, database),
      ).rejects.toThrow('operation_not_found');
    }
    await database`update allrice_memberships set active=false where id=${f.membership}`;
    await expect(
      listLocalCommandOperations(f.context, f.run, database),
    ).rejects.toThrow('operation_not_found');
  });
  it.each(['cancel', 'lease_expired'])(
    'P05 rechecks the live Worker job on %s, including during device heartbeat',
    async (change) => {
      const f = await commandFixture();
      await expect(
        createLocalCommandOperation(
          {
            context: {
              ...f.execution,
              worker: { type: 'worker', id: randomUUID() },
            },
            arguments: f.args,
            callId: 'foreign-worker',
          },
          database,
        ),
      ).rejects.toThrow('run_or_frozen_configuration_changed');
      await f.create();
      await f.approve();
      const claim = (await f.claim())!,
        attempt = claim.snapshot.binding.attempt,
        ledger = f.ledger();
      const lease = {
        scope: f.task.scope,
        operationId: attempt.operationId,
        leaseToken: claim.leaseToken,
      };
      await ledger.startOperation({
        ...lease,
        attempt,
        receiptId: randomUUID(),
      });
      if (change === 'cancel')
        await database`update allrice_jobs set cancel_requested_at=clock_timestamp() where id=${f.execution.jobId}`;
      else
        await database`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.execution.jobId}`;
      await expect(
        ledger.heartbeat({ ...lease, leaseMs: 30000 }),
      ).rejects.toThrow();
      await expect(f.create('later-call')).rejects.toThrow(
        'run_or_frozen_configuration_changed',
      );
    },
  );
  it('P05 bounds ordered output, deduplicates exactly, and stops permission renewal on cancellation', async () => {
    const f = await commandFixture();
    await f.create();
    await f.approve();
    const claim = (await f.claim())!,
      attempt = claim.snapshot.binding.attempt;
    const ledger = f.ledger(),
      lease = {
        scope: f.task.scope,
        operationId: attempt.operationId,
        leaseToken: claim.leaseToken,
      };
    await ledger.startOperation({ ...lease, attempt, receiptId: randomUUID() });
    await ledger.heartbeat({ ...lease, leaseMs: 30000 });
    const chunk = {
      ...lease,
      attempt,
      sequence: 0,
      stream: 'stdout' as const,
      content: 'one',
    };
    await ledger.recordOutput(chunk);
    await ledger.recordOutput(chunk);
    await expect(
      ledger.recordOutput({ ...chunk, content: 'different' }),
    ).rejects.toThrow('receipt_conflict');
    await expect(
      ledger.recordOutput({ ...chunk, sequence: 2 }),
    ).rejects.toThrow();
    const [view] = await listLocalCommandOperations(f.context, f.run, database);
    expect(view?.output).toEqual([
      { sequence: 0, stream: 'stdout', content: 'one' },
    ]);
    const cancel = await cancelLocalCommandRun(f.context, f.run, database);
    expect(cancel.operations[0]?.status).toBe('cancel_requested');
    await expect(
      ledger.heartbeat({ ...lease, leaseMs: 30000 }),
    ).rejects.toThrow();
  });
  it('P05 rejects feature-off execution without touching the operation ledger', async () => {
    const f = await commandFixture();
    vi.stubEnv('ALLRICE_LOCAL_COMMAND_ENABLED', '0');
    await expect(f.create()).rejects.toThrow('runtime_policy_disabled');
    expect(
      await listLocalCommandOperations(f.context, f.run, database),
    ).toEqual([]);
  });
  it('P05 rejection before dispatch is confirmed not-executed, not a forever-stopping process', async () => {
    const f = await commandFixture();
    await f.create();
    await f.approve('rejected');
    expect(await f.claim()).toBeNull();
    const canceled = await cancelLocalCommandRun(f.context, f.run, database);
    expect(canceled.operations[0]?.status).toBe('canceled');
    const [view] = await listLocalCommandOperations(f.context, f.run, database);
    expect(view?.evidence).toMatchObject({ output: { notExecuted: true } });
  });
  it.skipIf(!process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET)(
    'P05 real Chrome → approval DB → HTTP Bridge → local VM → durable receipt; lost ACK never repeats execution',
    async () => {
      const f = await commandFixture();
      const temporary = await realpath(
          await mkdtemp(join(tmpdir(), 'allrice-p05-e2e-')),
        ),
        root = join(temporary, 'workspace');
      await mkdir(root);
      const source =
        'console.log("P05 browser fixture");console.error("separate stderr");setTimeout(()=>process.exit(0),1500);';
      await writeFile(join(root, 'test.mjs'), source);
      const fingerprint = createHash('sha256').update(root).digest('hex');
      await database`update allrice_bridge_folder_grants set root_fingerprint=${fingerprint} where id=${f.grant}`;
      const created = await f.create('p05-browser', {
        ...f.args,
        files: [
          {
            path: 'test.mjs',
            sha256: `sha256:${createHash('sha256').update(source).digest('hex')}`,
          },
        ],
      });
      const require = createRequire(resolve('apps/worker/package.json'));
      const { chromium } = require('playwright-core') as typeof Playwright;
      const build = createRequire(require.resolve('tsx/package.json'))(
        'esbuild',
      ).build;
      const assets = await build({
        entryPoints: [resolve('apps/web/test/local-command-page.tsx')],
        bundle: true,
        write: false,
        outdir: temporary,
        platform: 'browser',
        format: 'iife',
        jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"production"' },
      });
      const js = assets.outputFiles.find((file: { path: string }) =>
        file.path.endsWith('.js'),
      ).text;
      const css = assets.outputFiles.find((file: { path: string }) =>
        file.path.endsWith('.css'),
      ).text;
      const deviceHandler = createRuntimeBridgeHttpHandler({
        enabled: () => true,
        authenticate: async (token) => {
          if (token !== 'synthetic-p05-device-token')
            throw Object.assign(Error('unauthorized'), {
              code: 'device_unauthorized',
            });
          return {
            device: f.device,
            grants: [
              {
                id: f.grant,
                deviceId: f.device.id,
                label: 'P05 fixture',
                rootFingerprint: fingerprint,
                createdAt: new Date().toISOString(),
                revokedAt: null,
              },
            ],
          };
        },
        ledgerForDevice: async () => f.ledger(),
      });
      let lostAck = false;
      const server = createServer((req, res) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks),
            path = new URL(req.url ?? '/', 'http://localhost').pathname;
          if (path === '/') {
            res.setHeader('content-type', 'text/html');
            res.end(
              `<!doctype html><meta name="viewport" content="width=device-width"><style>body{font:14px system-ui;margin:12px}*{box-sizing:border-box}${css}</style><div id="root"></div><script id="p05-input" type="application/json">${JSON.stringify({ runId: f.run, workspaceId: f.context.workspaceId, tenantHeaders: { 'x-p05-browser': 'synthetic' }, runActive: false })}</script><script src="/fixture.js"></script>`,
            );
            return;
          }
          if (path === '/fixture.js') {
            res.setHeader('content-type', 'application/javascript');
            res.end(js);
            return;
          }
          if (path.startsWith('/api/v1/bridge/device/operations/')) {
            const action = path.split('/').at(-1)! as
              'next' | 'start' | 'receipts' | 'heartbeat' | 'output';
            const result = await deviceHandler(
              new Request(`http://localhost${path}`, {
                method: 'POST',
                headers: {
                  authorization: String(req.headers.authorization ?? ''),
                  'content-type': 'application/json',
                },
                ...(body.length ? { body } : {}),
              }),
              action,
              path.split('/').at(-2),
            );
            if (action === 'receipts' && !lostAck && result.ok) {
              lostAck = true;
              res.destroy();
              return;
            }
            res.statusCode = result.status;
            res.setHeader('content-type', 'application/json');
            res.end(await result.text());
            return;
          }
          // Synthetic browser identity only. Production cookie auth has separate route tests.
          if (req.headers['x-p05-browser'] !== 'synthetic') {
            res.statusCode = 401;
            res.end();
            return;
          }
          res.setHeader('content-type', 'application/json');
          if (path === '/api/v1/runtime/local-commands') {
            res.end(
              JSON.stringify({
                operations: await listLocalCommandOperations(
                  f.context,
                  f.run,
                  database,
                ),
              }),
            );
            return;
          }
          if (path.startsWith('/api/v1/runtime/approvals/')) {
            res.end(
              JSON.stringify({
                approval: await decideRuntimeActionApproval(
                  f.context,
                  path.split('/').at(-1)!,
                  JSON.parse(body.toString()),
                  database,
                ),
              }),
            );
            return;
          }
          res.statusCode = 404;
          res.end();
        })().catch(() => {
          res.statusCode = 500;
          res.end('fixture request failed');
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw Error('fixture listener');
      const origin = `http://127.0.0.1:${address.port}`;
      const journal = await BridgeJournal.open({
        directory: join(temporary, 'journal'),
        server: origin,
        deviceId: f.device.id,
      });
      const runner = new LocalCommandRunner({
        socketPath: process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET!,
        imageDigest: f.imageDigest,
      });
      const client = new RuntimeBridgeOperationClient({
        config: {
          server: origin,
          deviceId: f.device.id,
          deviceName: 'fixture',
          grants: [
            {
              id: f.grant,
              label: 'fixture',
              rootPath: root,
              rootFingerprint: fingerprint,
            },
          ],
        },
        token: 'synthetic-p05-device-token',
        journal,
        runner,
      });
      const browser = await chromium.launch({
        headless: true,
        executablePath:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      });
      let child: ReturnType<typeof spawn> | undefined,
        recoveredJournal: BridgeJournal | undefined;
      try {
        expect(await client.pollOnce()).toBe(false);
        const page = await browser.newPage({
            viewport: { width: 1200, height: 900 },
          }),
          pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await page.goto(origin);
        await page
          .getByRole('button', { name: '批准这一次执行', exact: true })
          .click();
        await page
          .getByText('已批准这一次执行（不等于已完成）', { exact: false })
          .waitFor();
        await expect(client.pollOnce()).rejects.toThrow();
        expect(lostAck).toBe(true);
        expect(await journal.pending()).toHaveLength(1);
        const snapshot = await f
          .ledger()
          .readOperation(
            f.task.scope,
            created.snapshot.binding.attempt.operationId,
          );
        expect(snapshot.status).toBe('succeeded');
        await client.flush();
        expect(await client.pollOnce()).toBe(false);
        expect(await journal.pending()).toHaveLength(0);
        await page.getByText('命令执行成功', { exact: true }).waitFor();
        await page.reload();
        await page.getByText('命令执行成功', { exact: true }).waitFor();
        await page.getByText(/stdout \/ stderr/).click();
        expect(
          await page.getByLabel('stdout', { exact: true }).textContent(),
        ).toContain('P05 browser fixture');
        expect(
          await page.getByLabel('stderr', { exact: true }).textContent(),
        ).toContain('separate stderr');
        await page.setViewportSize({ width: 390, height: 844 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        expect(pageErrors).toEqual([]);
        const [view] = await listLocalCommandOperations(
          f.context,
          f.run,
          database,
        );
        const parsed = RuntimeLocalCommandResultSchema.parse(
          (view!.evidence as { output: unknown }).output,
        );
        expect(parsed).toMatchObject({
          exitCode: 0,
          reason: 'exited',
          sourceDirectoryModified: false,
        });
        const [count] = await database<
          { n: number }[]
        >`select count(*)::int as n from allrice_runtime_operation_events where operation_id=${created.snapshot.binding.attempt.operationId} and payload->'signal'->>'type'='operation.started'`;
        expect(count?.n).toBe(1);

        const crashSource =
          'console.log("crash fixture started");setInterval(()=>{},100);';
        await writeFile(join(root, 'test.mjs'), crashSource);
        const crashed = await f.create('p05-crash', {
          ...f.args,
          limits: { ...f.args.limits, timeoutMs: 1800 },
          files: [
            {
              path: 'test.mjs',
              sha256: `sha256:${createHash('sha256').update(crashSource).digest('hex')}`,
            },
          ],
        });
        await page.reload();
        await page
          .getByRole('button', { name: '批准这一次执行', exact: true })
          .click();
        await vi.waitFor(async () => {
          const views = await listLocalCommandOperations(
            f.context,
            f.run,
            database,
          );
          expect(
            views.find(
              (v) =>
                v.snapshot.binding.attempt.operationId ===
                crashed.snapshot.binding.attempt.operationId,
            )?.approval?.response,
          ).toMatchObject({ decision: 'approved' });
        });
        const crashJournalPath = join(temporary, 'crash-journal');
        const childConfig = {
          server: origin,
          deviceId: f.device.id,
          deviceName: 'crash fixture',
          grants: [
            {
              id: f.grant,
              label: 'fixture',
              rootPath: root,
              rootFingerprint: fingerprint,
            },
          ],
        };
        const childScript = `
          import {BridgeJournal} from ${JSON.stringify(new URL('../../../apps/rice-bridge/src/journal.ts', import.meta.url).href)};
          import {RuntimeBridgeOperationClient} from ${JSON.stringify(new URL('../../../apps/rice-bridge/src/operation-client.ts', import.meta.url).href)};
          import {LocalCommandRunner} from ${JSON.stringify(new URL('../../../apps/rice-bridge/src/local-command-runner.ts', import.meta.url).href)};
          const config=${JSON.stringify(childConfig)};
          const journal=await BridgeJournal.open({directory:${JSON.stringify(crashJournalPath)},server:config.server,deviceId:config.deviceId});
          await new RuntimeBridgeOperationClient({config,token:'synthetic-p05-device-token',journal,runner:new LocalCommandRunner(${JSON.stringify(runner.config)})}).pollOnce();
          await journal.close();`;
        child = spawn(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '--eval', childScript],
          {
            cwd: resolve('.'),
            env: { PATH: process.env.PATH },
            stdio: ['ignore', 'ignore', 'pipe'],
          },
        );
        let childError = '';
        child.stderr?.on('data', (bytes) => {
          if (childError.length < 2000) childError += String(bytes);
        });
        await vi.waitFor(
          async () => {
            if (child?.exitCode !== null)
              throw Error(`Synthetic Bridge child exited: ${childError}`);
            const [output] = await database<
              { n: number }[]
            >`select count(*)::int as n from allrice_runtime_operation_output where operation_id=${crashed.snapshot.binding.attempt.operationId}`;
            expect(output?.n).toBeGreaterThan(0);
          },
          { timeout: 10000 },
        );
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
        // The Bridge process is gone; observe the independent container deadline
        // BEFORE invoking recovery (which would itself stop a running orphan).
        await vi.waitFor(
          async () => {
            const state = await runner.api.json<{ State: { Status: string } }>(
              'GET',
              `/containers/allrice-${crashed.snapshot.binding.attempt.attemptId}/json`,
            );
            expect(state.State.Status).toBe('exited');
          },
          { timeout: 7000 },
        );
        recoveredJournal = await BridgeJournal.open({
          directory: crashJournalPath,
          server: origin,
          deviceId: f.device.id,
        });
        expect(await recoveredJournal.unknownLocalCommands()).toHaveLength(1);
        const recovering = new RuntimeBridgeOperationClient({
          config: childConfig,
          token: 'synthetic-p05-device-token',
          journal: recoveredJournal,
          runner,
        });
        expect(await recovering.pollOnce()).toBe(false);
        const views = await listLocalCommandOperations(
            f.context,
            f.run,
            database,
          ),
          recovered = views.find(
            (v) =>
              v.snapshot.binding.attempt.operationId ===
              crashed.snapshot.binding.attempt.operationId,
          )!;
        expect(recovered.snapshot.status).toBe('failed');
        expect(recovered.evidence).toMatchObject({
          output: {
            stopped: true,
            reason: 'timeout',
            sourceDirectoryModified: false,
          },
        });
        expect(await recoveredJournal.unknownLocalCommands()).toHaveLength(0);
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
        await recoveredJournal?.close();
        await browser.close();
        await journal.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(temporary, { recursive: true, force: true });
      }
    },
    60_000,
  );
  it('persists Ask; re-created production factory consumes exact approval atomically and starts once', async () => {
    const f = await fixture(),
      op = f.operation();
    expect((await op.factory().createOperation(op.input)).status).toBe(
      'waiting_user',
    );
    expect(await f.claim()).toBeNull();
    const req = await op.approve();
    expect(
      (await getRuntimeActionApproval(f.context, req.approvalId, database))
        .consumedAt,
    ).toBeNull();
    const claims = await Promise.all(
      Array.from({ length: 6 }, () => f.claim()),
    );
    const dispatched = claims.filter((item) => item !== null);
    expect(dispatched).toHaveLength(1);
    expect(
      (await getRuntimeActionApproval(f.context, req.approvalId, database))
        .consumedAt,
    ).not.toBeNull();
    const lease = dispatched[0]!;
    const start = {
      scope: f.task.scope,
      operationId: lease.snapshot.binding.attempt.operationId,
      attempt: lease.snapshot.binding.attempt,
      receiptId: randomUUID(),
      leaseToken: lease.leaseToken,
    };
    expect((await f.ledger().startOperation(start)).mayExecute).toBe(true);
    expect((await f.ledger().startOperation(start)).mayExecute).toBe(false);
  });
  it('skips a pending approval without blocking a later approved operation', async () => {
    const f = await fixture(),
      waiting = f.operation(),
      ready = f.operation();
    await waiting.factory().createOperation(waiting.input);
    await ready.factory().createOperation(ready.input);
    await ready.approve();
    expect((await f.claim())?.snapshot.binding.attempt.operationId).toBe(
      ready.input.snapshot.binding.attempt.operationId,
    );
    expect(
      (
        await f
          .ledger()
          .readOperation(
            f.task.scope,
            waiting.input.snapshot.binding.attempt.operationId,
          )
      ).status,
    ).toBe('waiting_user');
  });
  it('rotates more than 20 waiting candidates with a bounded next poll', async () => {
    const f = await fixture();
    for (let n = 0; n < 21; n++) {
      const op = f.operation();
      await op.factory().createOperation(op.input);
    }
    const ready = f.operation();
    await ready.factory().createOperation(ready.input);
    await ready.approve();
    expect(await f.claim()).toBeNull();
    expect((await f.claim())?.snapshot.binding.attempt.operationId).toBe(
      ready.input.snapshot.binding.attempt.operationId,
    );
  });
  it('does not convert missing policy or SQL errors into an empty queue', async () => {
    const f = await fixture('allow'),
      op = f.operation();
    await op.factory().createOperation(op.input);
    await database`delete from allrice_runtime_policy_controls where organization_id=${f.context.organizationId}`;
    await expect(f.claim()).rejects.toThrow(
      'runtime_policy_missing_or_invalid',
    );
  });
  it.each([
    'device',
    'grant',
    'capability',
    'target_metadata',
    'target_key',
    'target_capability',
    'heartbeat',
    'membership',
    'run',
    'policy',
  ])(
    'rechecks %s after approval; revoked or changed authority cannot dispatch',
    async (change) => {
      const f = await fixture(),
        op = f.operation();
      await op.factory().createOperation(op.input);
      const req = await op.approve();
      if (change === 'device')
        await database`update allrice_bridge_devices set revoked_at=clock_timestamp() where id=${f.device.id}`;
      if (change === 'grant')
        await database`update allrice_bridge_folder_grants set revoked_at=clock_timestamp() where id=${f.grant}`;
      if (change === 'capability')
        await database`update allrice_bridge_devices set capabilities=array['local.fs.list'] where id=${f.device.id}`;
      if (change === 'target_metadata')
        await database`update allrice_execution_targets set metadata='{}' where id=${f.target}`;
      if (change === 'target_key')
        await database`update allrice_execution_targets set target_key='bridge.wrong' where id=${f.target}`;
      if (change === 'target_capability')
        await database`update allrice_execution_targets set capabilities='["files.read"]' where id=${f.target}`;
      if (change === 'heartbeat')
        await database`update allrice_bridge_devices set last_seen_at=clock_timestamp()-interval '91 seconds' where id=${f.device.id}`;
      if (change === 'membership')
        await database`update allrice_memberships set active=false where id=${f.membership}`;
      if (change === 'run')
        await database`update allrice_runs set state='canceled' where id=${f.run}`;
      if (change === 'policy')
        await database`update allrice_policy_snapshots set issued_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' where id=${f.policy}`;
      expect(await f.claim()).toBeNull();
      const [approval] = await database<
        { runtime_consumed_at: Date | null }[]
      >`select runtime_consumed_at from allrice_approval_requests where id=${req.approvalId}`;
      expect(approval?.runtime_consumed_at).toBeNull();
    },
  );
  it.each(['work_copy', 'employee', 'session', 'generation', 'payload'])(
    'does not trust a server input that claims an unrelated %s',
    async (change) => {
      const f = await fixture('allow'),
        op = f.operation();
      const binding = op.input.snapshot.binding;
      if (change === 'work_copy') binding.execution.workCopy.id = randomUUID();
      if (change === 'employee')
        binding.task.frozenConfiguration.employeeVersionId = randomUUID();
      if (change === 'session') binding.task.chatSessionId = randomUUID();
      if (change === 'generation') binding.attempt.generation = 1;
      if (change === 'payload') binding.inputDigest = digest('wrong payload');
      await expect(op.factory().createOperation(op.input)).rejects.toThrow();
      const [count] = await database<
        { count: number }[]
      >`select count(*)::int as count from allrice_runtime_operations where run_id=${f.run}`;
      expect(count?.count).toBe(0);
    },
  );
  it('does not use mutable caller objects as the source after factory construction', async () => {
    const f = await fixture('allow'),
      op = f.operation(),
      factory = op.factory();
    if (op.input.bridgePayload.capability !== 'local.fs.write')
      throw Error('wrong fixture');
    op.input.bridgePayload.arguments.content = 'changed after capture';
    op.input.snapshot.binding.inputDigest = digest(op.input.bridgePayload);
    await expect(factory.createOperation(op.input)).rejects.toThrow(
      'unavailable',
    );
  });
  it('requires explicit write baseline, but permits a parsed directory root list', async () => {
    const f = await fixture('allow');
    const write = f.operation({
      capability: 'local.fs.write',
      arguments: { path: 'test.txt', content: 'missing baseline' },
    });
    await expect(write.factory().createOperation(write.input)).rejects.toThrow(
      'unavailable',
    );
    const list = f.operation({
      capability: 'local.fs.list',
      arguments: { path: '.', limit: 100 },
    });
    expect((await list.factory().createOperation(list.input)).status).toBe(
      'ready',
    );
    expect((await f.claim())?.bridgePayload).toEqual(list.input.bridgePayload);
  });
  it('resolves an actual employee Run, chat Session and current generation through all real foreign keys', async () => {
    const f = await fixture('ask', true),
      op = f.operation();
    expect((await op.factory().createOperation(op.input)).status).toBe(
      'waiting_user',
    );
    await op.approve();
    const claim = await f.claim();
    expect(claim?.snapshot.binding.task.chatSessionId).toBe(f.sessionId);
    expect(
      claim?.snapshot.binding.task.frozenConfiguration.employeeVersionId,
    ).toBe(f.versionId);
    expect(claim?.snapshot.binding.attempt.generation).toBe(3);
    expect(
      (
        await f.ledger().startOperation({
          scope: f.task.scope,
          operationId: op.input.snapshot.binding.attempt.operationId,
          leaseToken: claim!.leaseToken,
          attempt: claim!.snapshot.binding.attempt,
          receiptId: randomUUID(),
        })
      ).mayExecute,
    ).toBe(true);
  });
  it.each([
    'generation',
    'archive',
    'owner',
    'session_version',
    'runtime_run',
    'runtime_stopped',
    'run_employee',
  ])(
    'rejects actual chat %s changes between approval and dispatch',
    async (change) => {
      const f = await fixture('ask', true),
        op = f.operation();
      await op.factory().createOperation(op.input);
      await op.approve();
      if (change === 'generation')
        await database`update allrice_conversation_runtimes set thread_generation=4 where session_id=${f.sessionId}`;
      if (change === 'archive')
        await database`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${f.sessionId}`;
      if (change === 'owner') {
        const other = randomUUID();
        await database`insert into allrice_users(id,email,display_name,password_hash)values(${other},${`${other}@example.test`},'Other','not-login')`;
        await database`update allrice_chat_sessions set owner_id=${other} where id=${f.sessionId}`;
      }
      if (change === 'session_version') {
        const version = randomUUID();
        await database`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum)
          values(${version},${f.device.organizationId},${f.device.workspaceId},${f.employeeId},2,'Another version','synthetic','synthetic','[]',${digest('employee 2')})`;
        await database`update allrice_chat_sessions set employee_version_id=${version} where id=${f.sessionId}`;
      }
      if (change === 'runtime_run') {
        const anotherRun = randomUUID();
        await database`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
          values(${anotherRun},${f.device.organizationId},${f.device.workspaceId},${f.device.ownerId},'running','{}','{}')`;
        await database`update allrice_conversation_runtimes set active_run_id=${anotherRun} where session_id=${f.sessionId}`;
      }
      if (change === 'runtime_stopped')
        await database`update allrice_conversation_runtimes set state='idle',active_run_id=null,active_turn_id=null,worker_id=null where session_id=${f.sessionId}`;
      if (change === 'run_employee')
        await database`update allrice_runs set execution_spec='{}' where id=${f.run}`;
      expect(await f.claim()).toBeNull();
    },
  );
  it('checks device heartbeat after a real blocking resource lock, not the initiating timestamp', async () => {
    const f = await fixture('allow'),
      op = f.operation();
    await op.factory().createOperation(op.input);
    await database`update allrice_bridge_devices set last_seen_at=clock_timestamp()-interval '89.8 seconds' where id=${f.device.id}`;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = database.begin(async (tx) => {
      await tx`select id from allrice_bridge_devices where id=${f.device.id} for update`;
      locked();
      await hold;
      await tx`select pg_sleep(0.3)`;
    });
    await ready;
    const claim = f.claim();
    release();
    await blocker;
    expect(await claim).toBeNull();
  });
  it('ignores a replacement initial closure when immutable input already exists', async () => {
    const f = await fixture('allow'),
      op = f.operation();
    await op.factory().createOperation(op.input);
    const altered = structuredClone(op.input.snapshot.binding);
    const payload = BridgeCommandPayloadSchema.parse({
      capability: 'local.fs.write',
      arguments: {
        path: 'different.txt',
        content: 'replacement',
        expectedSha256: null,
      },
    });
    altered.inputDigest = digest(payload);
    const factory = createGovernedBridgeOperationLedger(f.device, {
      database,
      initialOperation: { binding: altered, payload },
    });
    const resolved = await database.begin((transaction) =>
      factory.policyOptions.resolveCurrentBinding({
        transaction,
        binding: altered,
      }),
    );
    expect(resolved.inputDigest).toBe(op.input.snapshot.binding.inputDigest);
    expect(resolved.inputDigest).not.toBe(altered.inputDigest);
  });
  it.each(['create', 'dispatch', 'start', 'heartbeat'] as const)(
    'rolls back %s when its final database write crosses the authority expiry',
    async (mode) => {
      const f = await fixture(),
        op = f.operation(),
        id = op.input.snapshot.binding.attempt.operationId;
      let approvalId: string | null = null;
      let lease: Awaited<ReturnType<typeof f.claim>> = null;
      if (mode !== 'create') {
        await op.factory().createOperation(op.input);
        approvalId = (await op.approve()).approvalId;
      }
      if (mode === 'start' || mode === 'heartbeat') lease = await f.claim();
      const [before] = await database<
        { count: number }[]
      >`select count(*)::int as count from allrice_runtime_operation_events where operation_id=${id}`;
      const eventKind = {
        create: 'operation.waiting',
        dispatch: 'operation.dispatched',
        start: 'operation.started',
        heartbeat: 'lease_update',
      }[mode];
      await database`insert into b1_test_write_delay(operation_id,event_kind)values(${id},${eventKind})`;
      if (mode === 'create')
        await database`update allrice_policy_snapshots set expires_at=clock_timestamp()+interval '0.5 second' where id=${f.policy}`;
      else
        await database`update allrice_approval_requests set runtime_expires_at=clock_timestamp()+interval '0.5 second' where id=${approvalId}`;
      const call =
        mode === 'create'
          ? op.factory().createOperation(op.input)
          : mode === 'dispatch'
            ? f.ledger().dispatch({
                scope: f.task.scope,
                operationId: id,
                leaseOwner: f.device.id,
                leaseMs: 30_000,
              })
            : mode === 'start'
              ? f.ledger().startOperation({
                  scope: f.task.scope,
                  operationId: id,
                  leaseToken: lease!.leaseToken,
                  attempt: lease!.snapshot.binding.attempt,
                  receiptId: randomUUID(),
                })
              : f.ledger().heartbeat({
                  scope: f.task.scope,
                  operationId: id,
                  leaseToken: lease!.leaseToken,
                  leaseMs: 60_000,
                });
      await expect(call).rejects.toThrow('unavailable');
      const [after] = await database<
        { count: number }[]
      >`select count(*)::int as count from allrice_runtime_operation_events where operation_id=${id}`;
      expect(after?.count).toBe(before?.count);
      const [row] = await database<
        {
          snapshot: { status: string };
          lease_expires_at: Date | null;
          lease_token_hash: string | null;
        }[]
      >`
        select snapshot,lease_expires_at,lease_token_hash from allrice_runtime_operations where id=${id}`;
      if (mode === 'create') {
        expect(row).toBeUndefined();
        expect(
          (await f.ledger().readBudget(f.task.scope, f.run)).budgets[0]
            ?.reserved,
        ).toBe(0);
      } else {
        expect(row?.snapshot.status).toBe(
          mode === 'dispatch' ? 'waiting_user' : 'dispatched',
        );
        if (mode === 'dispatch') {
          expect(row?.lease_token_hash).toBeNull();
          const [approval] = await database<
            { runtime_consumed_at: Date | null }[]
          >`select runtime_consumed_at from allrice_approval_requests where id=${approvalId}`;
          expect(approval?.runtime_consumed_at).toBeNull();
        } else
          expect(row?.lease_expires_at?.toISOString()).toBe(
            lease?.leaseExpiresAt,
          );
        const [receipts] = await database<
          { count: number }[]
        >`select count(*)::int as count from allrice_runtime_operation_receipts where operation_id=${id}`;
        expect(receipts?.count).toBe(0);
      }
    },
  );
  it('does not renew an old lease that expires while the final UPDATE is blocked', async () => {
    const f = await fixture('allow'),
      op = f.operation();
    await op.factory().createOperation(op.input);
    const lease = (await f.claim())!,
      id = lease.snapshot.binding.attempt.operationId;
    const [old] = await database<{ lease_expires_at: Date }[]>`
      update allrice_runtime_operations set lease_expires_at=clock_timestamp()+interval '0.5 second'
      where id=${id} returning lease_expires_at`;
    await database`insert into b1_test_write_delay(operation_id,event_kind)values(${id},'lease_update')`;
    await expect(
      f.ledger().heartbeat({
        scope: f.task.scope,
        operationId: id,
        leaseToken: lease.leaseToken,
        leaseMs: 30_000,
      }),
    ).rejects.toThrow('lease_lost');
    const [current] = await database<
      { lease_expires_at: Date }[]
    >`select lease_expires_at from allrice_runtime_operations where id=${id}`;
    expect(current?.lease_expires_at.toISOString()).toBe(
      old?.lease_expires_at.toISOString(),
    );
  });
});
