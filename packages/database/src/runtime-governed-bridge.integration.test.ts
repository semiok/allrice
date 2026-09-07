import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

import {
  BridgeCommandPayloadSchema,
  BridgeDeviceSchema,
  RuntimeOperationSnapshotSchema,
  type BridgeCommandPayload,
  type RequestContext,
  type RuntimeActionBinding,
} from '@allrice/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

async function fixture(effect: 'allow' | 'ask' | 'deny' = 'ask') {
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
  const executionSpec = { employeeVersionId: null };
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
    chatSessionId: null,
    frozenConfiguration: {
      employeeVersionId: null,
      digest: digest(executionSpec),
    },
  };
  const ledger = () =>
    createGovernedBridgeOperationLedger(device, { database });
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
        generation: 0,
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
  };
}

suite('B1 production Bridge authority assembly / real PostgreSQL', () => {
  beforeAll(async () => {
    if (!process.env.ALLRICE_TEST_DATABASE_URL)
      throw Error('ALLRICE_TEST_DATABASE_URL required');
    admin = postgres(process.env.ALLRICE_TEST_DATABASE_URL, {
      max: 2,
      onnotice: () => {},
    });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended('allrice-test-public-extensions',0))`;
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
});
