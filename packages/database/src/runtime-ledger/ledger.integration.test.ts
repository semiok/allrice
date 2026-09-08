import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

import {
  RuntimeOperationSnapshotSchema,
  replayRuntimeOperationEvents,
  type RuntimeOperationSignal,
  type RuntimeUsageObservation,
} from '@allrice/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRuntimeOperationLedger,
  runtimeLedgerInputDigest,
} from './ledger.ts';
import type {
  CreateRuntimeOperationInput,
  RuntimeLedgerAdmission,
  RuntimeLedgerLease,
} from './types.ts';
import { ensureRuntimeOperationRoot } from './root-service.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const digest = `sha256:${'a'.repeat(64)}`;
const source = {
  kind: 'cloud_runner' as const,
  sourceId: 'synthetic-authoritative-meter',
};
const migrations = new URL('../../migrations/', import.meta.url);
let admin: ReturnType<typeof postgres>;
let db: ReturnType<typeof postgres>;
let schema = '';
let url = '';
const allow: RuntimeLedgerAdmission = async () => {};
const ledger = () =>
  createRuntimeOperationLedger({ database: db, admission: allow });

async function fixture(capacity = 10) {
  const ids = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    userId: randomUUID(),
    runId: randomUUID(),
    targetId: randomUUID(),
  };
  await db`insert into allrice_users(id,email,display_name,password_hash) values(${ids.userId},${`${ids.userId}@example.test`},'P03-a fixture','not-a-login')`;
  await db`insert into allrice_organizations(id,slug,name) values(${ids.organizationId},${`p03a-${ids.organizationId}`},'P03-a fixture')`;
  await db`insert into allrice_workspaces(id,organization_id,slug,name) values(${ids.workspaceId},${ids.organizationId},'default','Default')`;
  await db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
    values(${ids.runId},${ids.organizationId},${ids.workspaceId},${ids.userId},'running',${db.json({})},${db.json({})})`;
  await db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities)
    values(${ids.targetId},${ids.organizationId},${ids.workspaceId},'test.cloud','cloud_sandbox','Test cloud','online',${db.json([])})`;
  const task = {
    scope: {
      organizationId: ids.organizationId,
      workspaceId: ids.workspaceId,
      projectId: null,
    },
    chatSessionId: null,
    runId: ids.runId,
    rootRunId: ids.runId,
    parentRunId: null,
    frozenConfiguration: { employeeVersionId: null, digest },
  };
  const root = {
    task,
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    budgets: [
      {
        metric: 'tool_calls' as const,
        unit: 'calls' as const,
        currency: null,
        capacity,
        source,
      },
    ],
  };
  await ledger().createRoot(root);
  const make = (amount = 1): CreateRuntimeOperationInput => ({
    snapshot: RuntimeOperationSnapshotSchema.parse({
      contractVersion: 1,
      binding: {
        task,
        attempt: {
          operationId: randomUUID(),
          attemptId: randomUUID(),
          attemptNumber: 1,
          generation: 0,
          fence: 1,
        },
        requestedBy: { type: 'user', id: ids.userId },
        policy: { snapshotId: randomUUID(), digest },
        execution: {
          targetId: ids.targetId,
          targetKind: 'cloud_sandbox',
          deviceId: null,
          grantId: randomUUID(),
          grantVersion: 1,
          scopeDigest: digest,
          workCopy: { id: randomUUID(), kind: 'cloud_copy' },
        },
        action: 'cloud.synthetic.test',
        inputDigest: digest,
        dataScope: [],
        baseline: [],
        command: null,
      },
      stepId: null,
      agentInstanceId: null,
      processId: null,
      cancelRequestId: null,
      idempotencyKey: randomUUID(),
      status: 'planned',
      result: null,
    }),
    reservations: [
      { metric: 'tool_calls', accountingId: randomUUID(), amount },
    ],
  });
  return { ids, task, root, scope: task.scope, make };
}

async function dispatch(input: CreateRuntimeOperationInput) {
  await ledger().createOperation(input);
  return ledger().dispatch({
    scope: input.snapshot.binding.task.scope,
    operationId: input.snapshot.binding.attempt.operationId,
    leaseOwner: randomUUID(),
    leaseMs: 60_000,
  });
}

function receipt(lease: RuntimeLedgerLease, signal: RuntimeOperationSignal) {
  return {
    scope: lease.snapshot.binding.task.scope,
    operationId: lease.snapshot.binding.attempt.operationId,
    leaseToken: lease.leaseToken,
    receiptId: randomUUID(),
    attempt: lease.snapshot.binding.attempt,
    signal,
  };
}
function outcome(
  status: 'succeeded' | 'failed' = 'succeeded',
): RuntimeOperationSignal {
  return {
    type: 'operation.outcome',
    result: {
      status,
      effects: 'none',
      evidence: {
        id: randomUUID(),
        recordedAt: new Date().toISOString(),
        digest,
      },
    },
  };
}
function observation(
  input: CreateRuntimeOperationInput,
  amount = 1,
): RuntimeUsageObservation {
  const at = new Date().toISOString();
  return {
    contractVersion: 1,
    observationId: randomUUID(),
    accountingId: input.reservations[0]!.accountingId,
    task: input.snapshot.binding.task,
    source,
    accountingBoundary: {
      kind: 'operation',
      attempt: input.snapshot.binding.attempt,
    },
    aggregation: 'self_only',
    metric: 'tool_calls',
    unit: 'calls',
    currency: null,
    mode: 'cumulative',
    quality: 'measured',
    amount,
    state: 'settled',
    window: { id: randomUUID(), startedAt: at, endedAt: at },
    observedAt: at,
  };
}

integration('P03-a shared operation ledger — real isolated PostgreSQL', () => {
  beforeAll(async () => {
    const base = process.env.ALLRICE_TEST_DATABASE_URL;
    if (!base)
      throw new Error(
        'ALLRICE_TEST_DATABASE_URL required; no production DATABASE_URL fallback',
      );
    const parsed = new URL(base);
    parsed.search = '';
    admin = postgres(parsed.toString(), { max: 1, onnotice: () => {} });
    // Extensions are database-global, never owned by a disposable parallel suite.
    await admin.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(20260907, 1)`;
      await transaction`create extension if not exists vector with schema public`;
      await transaction`create extension if not exists pg_trgm with schema public`;
    });
    schema = `p03a_${randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`create schema "${schema}"`);
    parsed.searchParams.set('options', `-csearch_path=${schema},public`);
    url = parsed.toString();
    db = postgres(url, { max: 10, onnotice: () => {} });
    const files = (await readdir(migrations))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    await db.begin(async (tx) => {
      for (const file of files)
        await tx.unsafe(await readFile(new URL(file, migrations), 'utf8'));
    });
    await db`create table p03a_test_approvals (operation_id uuid primary key, approved boolean not null, consumed boolean not null default false)`;
  }, 120_000);
  afterAll(async () => {
    await db?.end({ timeout: 5 });
    // Only our validated, randomly named schema is removed; never tenant data.
    if (admin && /^p03a_[a-f0-9]{32}$/.test(schema))
      await admin.unsafe(`drop schema "${schema}" cascade`);
    await admin?.end({ timeout: 5 });
  });

  it('requires an explicit admission adapter instead of default allow', () => {
    expect(() =>
      createRuntimeOperationLedger({
        database: db,
        admission: undefined as unknown as RuntimeLedgerAdmission,
      }),
    ).toThrow('unavailable');
  });

  it('stores immutable root configuration and rejects changing an existing root budget', async () => {
    const f = await fixture();
    await ledger().createRoot(f.root);
    await expect(
      ledger().createRoot({
        ...f.root,
        budgets: [{ ...f.root.budgets[0]!, capacity: 100 }],
      }),
    ).rejects.toThrow('idempotency_conflict');
    expect(
      (await ledger().readBudget(f.scope, f.ids.runId)).budgets[0]!.capacity,
    ).toBe(10);
  });

  it('reuses a root across adapters without expanding its original deadline or budget', async () => {
    const f = await fixture(3);
    const budgets = await ensureRuntimeOperationRoot(
      ledger(),
      f.task,
      new Date(Date.now() + 7200000).toISOString(),
      db,
    );
    expect(budgets).toEqual(f.root.budgets);
    expect(
      (await ledger().readBudget(f.scope, f.ids.runId)).budgets[0]!.capacity,
    ).toBe(3);
    await expect(
      ensureRuntimeOperationRoot(
        ledger(),
        { ...f.task, scope: { ...f.scope, workspaceId: randomUUID() } },
        f.root.deadlineAt,
        db,
      ),
    ).rejects.toThrow();
  });

  it('atomically rolls back dispatch when private recovery journal persistence fails', async () => {
    const f = await fixture(),
      operation = f.make();
    await ledger().createOperation(operation);
    const journaled = createRuntimeOperationLedger({
      database: db,
      admission: allow,
      persistLease: async ({ transaction, lease }) => {
        await transaction`insert into p03a_test_approvals(operation_id,approved) values(${lease.snapshot.binding.attempt.operationId},true)`;
        throw Error('synthetic journal failure');
      },
    });
    await expect(
      journaled.dispatch({
        scope: f.scope,
        operationId: operation.snapshot.binding.attempt.operationId,
        leaseOwner: randomUUID(),
        leaseMs: 15000,
      }),
    ).rejects.toThrow('synthetic journal failure');
    const [stored] =
      await db`select lease_token_hash,snapshot->>'status' as status from allrice_runtime_operations where id=${operation.snapshot.binding.attempt.operationId}`;
    expect(stored!.lease_token_hash).toBeNull();
    expect(stored!.status).toBe('ready');
    expect(
      await db`select * from p03a_test_approvals where operation_id=${operation.snapshot.binding.attempt.operationId}`,
    ).toHaveLength(0);
    expect(
      await ledger().dispatch({
        scope: f.scope,
        operationId: operation.snapshot.binding.attempt.operationId,
        leaseOwner: randomUUID(),
        leaseMs: 15000,
      }),
    ).toHaveProperty('leaseToken');
  });

  it('enforces immutable operation bindings and one leased attempt at the database boundary', async () => {
    const f = await fixture();
    const input = f.make();
    const lease = await dispatch(input);
    const id = input.snapshot.binding.attempt.operationId;
    await expect(
      db`update allrice_runtime_operations set initial_snapshot=${db.json({ tampered: true })} where id=${id}`,
    ).rejects.toThrow('immutable');
    await expect(
      db`update allrice_runtime_operations set bridge_payload=${db.json({ tampered: true })} where id=${id}`,
    ).rejects.toThrow('immutable');
    await expect(
      db`update allrice_runtime_operations set lease_token_hash=${'b'.repeat(64)} where id=${id}`,
    ).rejects.toThrow('immutable');
    const snapshot = structuredClone(lease.snapshot);
    snapshot.binding.inputDigest = `sha256:${'b'.repeat(64)}`;
    await expect(
      db`update allrice_runtime_operations set snapshot=${db.json(snapshot)} where id=${id}`,
    ).rejects.toThrow('immutable');
    expect((await ledger().readOperationInput(f.scope, id)).snapshot).toEqual(
      lease.snapshot,
    );
  });

  it('serializes simultaneous reservations at the root with no oversubscription', async () => {
    const f = await fixture(3);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => ledger().createOperation(f.make())),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(9);
    expect(
      (await ledger().readBudget(f.scope, f.ids.runId)).budgets[0]!.reserved,
    ).toBe(3);
  });

  it('deduplicates concurrent create without reserving twice, rejects changed request', async () => {
    const f = await fixture();
    const input = f.make();
    const result = await Promise.all(
      Array.from({ length: 8 }, () => ledger().createOperation(input)),
    );
    expect(result.every((r) => r.status === 'ready')).toBe(true);
    expect(
      (await ledger().readBudget(f.scope, f.ids.runId)).budgets[0]!.reserved,
    ).toBe(1);
    await expect(
      ledger().createOperation({
        ...input,
        reservations: [{ ...input.reservations[0]!, amount: 2 }],
      }),
    ).rejects.toThrow('idempotency_conflict');
  });

  it('keeps Ask pending and atomically consumes approval with one winning dispatch', async () => {
    const f = await fixture();
    const input = f.make();
    const id = input.snapshot.binding.attempt.operationId;
    await db`insert into p03a_test_approvals(operation_id,approved) values(${id},false)`;
    const guarded = createRuntimeOperationLedger({
      database: db,
      admission: async ({ transaction: tx, binding, phase }) => {
        const [approval] = await tx<
          { approved: boolean; consumed: boolean }[]
        >`select approved,consumed from p03a_test_approvals where operation_id=${binding.attempt.operationId} for update`;
        if (!approval?.approved) return { status: 'waiting_user' };
        if (phase === 'dispatch') {
          if (approval.consumed) throw new Error('already consumed');
          await tx`update p03a_test_approvals set consumed=true where operation_id=${binding.attempt.operationId}`;
        }
      },
    });
    expect((await guarded.createOperation(input)).status).toBe('waiting_user');
    const claim = {
      scope: f.scope,
      operationId: id,
      leaseOwner: randomUUID(),
      leaseMs: 60_000,
    };
    await expect(guarded.dispatch(claim)).rejects.toThrow('unavailable');
    await db`update p03a_test_approvals set approved=true where operation_id=${id}`;
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => guarded.dispatch(claim)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [approval] = await db<
      { consumed: boolean }[]
    >`select consumed from p03a_test_approvals where operation_id=${id}`;
    expect(approval!.consumed).toBe(true);
  });

  it('rolls back admission writes on failure and never leaks a lease or consumed approval', async () => {
    const f = await fixture();
    const input = f.make();
    const id = input.snapshot.binding.attempt.operationId;
    await ledger().createOperation(input);
    await db`insert into p03a_test_approvals(operation_id,approved) values(${id},true)`;
    const guarded = createRuntimeOperationLedger({
      database: db,
      admission: async ({ transaction: tx }) => {
        await tx`update p03a_test_approvals set consumed=true where operation_id=${id}`;
        throw new Error('synthetic policy revocation');
      },
    });
    await expect(
      guarded.dispatch({
        scope: f.scope,
        operationId: id,
        leaseOwner: randomUUID(),
        leaseMs: 60_000,
      }),
    ).rejects.toThrow('revocation');
    const [approval] = await db<
      { consumed: boolean }[]
    >`select consumed from p03a_test_approvals where operation_id=${id}`;
    expect(approval!.consumed).toBe(false);
    expect((await ledger().readOperation(f.scope, id)).status).toBe('ready');
  });

  it('authorizes execution preflight only once; repeated/lost ACK cannot rerun', async () => {
    const f = await fixture();
    const input = f.make();
    const lease = await dispatch(input);
    const start = { ...receipt(lease, { type: 'operation.transport_ack' }) };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ledger().startOperation(start)),
    );
    expect(results.filter((r) => r.mayExecute)).toHaveLength(1);
    expect(results.every((r) => r.snapshot.status === 'running')).toBe(true);
  });

  it('rechecks current policy at start after dispatch and does not consume again', async () => {
    const f = await fixture();
    const lease = await dispatch(f.make());
    const phases: string[] = [];
    const guarded = createRuntimeOperationLedger({
      database: db,
      admission: async ({ phase }) => {
        phases.push(phase);
        throw new Error('revoked');
      },
    });
    await expect(
      guarded.startOperation(
        receipt(lease, { type: 'operation.transport_ack' }),
      ),
    ).rejects.toThrow('revoked');
    expect(phases).toEqual(['heartbeat']);
    expect(
      (
        await ledger().readOperation(
          f.scope,
          lease.snapshot.binding.attempt.operationId,
        )
      ).status,
    ).toBe('dispatched');
  });

  it('deduplicates results and stores conflicting receipt content without replaying effects', async () => {
    const f = await fixture();
    const lease = await dispatch(f.make());
    const result = receipt(lease, outcome());
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => ledger().recordReceipt(result)),
    );
    expect(outcomes.filter((r) => r.disposition === 'applied')).toHaveLength(1);
    expect(outcomes.filter((r) => r.disposition === 'duplicate')).toHaveLength(
      9,
    );
    await expect(
      ledger().recordReceipt({ ...result, signal: outcome('failed') }),
    ).rejects.toThrow('receipt_conflict');
    const conflictingReceipt = receipt(lease, outcome('failed'));
    const conflict = await ledger().recordReceipt(conflictingReceipt);
    expect(conflict.disposition).toBe('conflict');
    expect((await ledger().recordReceipt(conflictingReceipt)).disposition).toBe(
      'conflict',
    );
    expect(conflict.snapshot.status).toBe('succeeded');
    expect(
      await ledger().readReceipts(
        f.scope,
        lease.snapshot.binding.attempt.operationId,
      ),
    ).toHaveLength(2);
  });

  it('persists state and ordered events across connection/worker reconstruction', async () => {
    const f = await fixture();
    const input = f.make();
    const lease = await dispatch(input);
    await ledger().recordReceipt(
      receipt(lease, { type: 'operation.started', processId: randomUUID() }),
    );
    const independent = postgres(url, { max: 2, onnotice: () => {} });
    try {
      const restarted = createRuntimeOperationLedger({
        database: independent,
        admission: allow,
      });
      const snapshot = await restarted.readOperation(
        f.scope,
        lease.snapshot.binding.attempt.operationId,
      );
      const events = await restarted.readEvents(
        f.scope,
        lease.snapshot.binding.attempt.operationId,
      );
      const replay = replayRuntimeOperationEvents(input.snapshot, events);
      expect(replay.blocked).toBeNull();
      expect(replay.snapshot).toEqual(snapshot);
      expect(snapshot.status).toBe('running');
      expect(events.map((e) => e.sequence)).toEqual([0, 1, 2]);
    } finally {
      await independent.end({ timeout: 5 });
    }
  });

  it('keeps expired lease unknown, holds budget, refuses retry/heartbeat/new preflight', async () => {
    const f = await fixture(1);
    const input = f.make();
    const lease = await dispatch(input);
    const id = lease.snapshot.binding.attempt.operationId;
    await db`update allrice_runtime_operations set lease_expires_at=clock_timestamp()-interval '1 second' where id=${id}`;
    expect((await ledger().expireLeases(f.scope, f.ids.runId))[0]!.status).toBe(
      'unknown',
    );
    await expect(
      ledger().dispatch({
        scope: f.scope,
        operationId: id,
        leaseOwner: randomUUID(),
        leaseMs: 60_000,
      }),
    ).rejects.toThrow('invalid_state');
    await expect(
      ledger().heartbeat({
        scope: f.scope,
        operationId: id,
        leaseToken: lease.leaseToken,
        leaseMs: 60_000,
      }),
    ).rejects.toThrow('lease_lost');
    await expect(
      ledger().startOperation(
        receipt(lease, { type: 'operation.transport_ack' }),
      ),
    ).rejects.toThrow('lease_lost');
    await expect(ledger().createOperation(f.make())).rejects.toThrow(
      'budget_exhausted',
    );
    await expect(
      ledger().settleUsage({
        scope: f.scope,
        operationId: id,
        leaseToken: lease.leaseToken,
        observation: observation(input),
      }),
    ).rejects.toThrow('invalid_state');
    expect(
      (await ledger().readBudget(f.scope, f.ids.runId)).budgets[0]!.reserved,
    ).toBe(1);
    expect(
      (await ledger().recordReceipt(receipt(lease, outcome()))).snapshot.status,
    ).toBe('succeeded');
  });

  it('isolates stale attempts/fences and retains evidence without advancing the current operation', async () => {
    const f = await fixture();
    const lease = await dispatch(f.make());
    const request = receipt(lease, outcome());
    const staleReceipt = {
      ...request,
      attempt: {
        ...request.attempt,
        attemptId: randomUUID(),
        attemptNumber: 2,
        fence: 2,
      },
    };
    const stale = await ledger().recordReceipt(staleReceipt);
    expect(stale.disposition).toBe('stale');
    expect(stale.snapshot.status).toBe('dispatched');
    const repeatedStale = await ledger().recordReceipt(staleReceipt);
    expect(repeatedStale.disposition).toBe('stale');
    await expect(
      ledger().recordReceipt({
        ...request,
        receiptId: randomUUID(),
        leaseToken: randomUUID(),
      }),
    ).rejects.toThrow('lease_lost');
    expect(
      await ledger().readReceipts(f.scope, request.operationId),
    ).toHaveLength(1);
  });

  it('serializes root cancel against result and preserves truthful successful completion', async () => {
    const f = await fixture();
    const lease = await dispatch(f.make());
    const requestId = randomUUID();
    await Promise.all([
      ledger().cancelRoot(f.scope, f.ids.runId, requestId),
      ledger().recordReceipt(receipt(lease, outcome())),
    ]);
    const snapshot = await ledger().readOperation(
      f.scope,
      lease.snapshot.binding.attempt.operationId,
    );
    expect(snapshot.status).toBe('succeeded');
    expect(
      (await ledger().readBudget(f.scope, f.ids.runId)).cancelRequestId,
    ).toBe(requestId);
    await expect(ledger().createOperation(f.make())).rejects.toThrow(
      'root_canceled',
    );
  });

  it('cancel intent does not mean stopped and unknown preserves it until confirmed evidence', async () => {
    const f = await fixture();
    const lease = await dispatch(f.make());
    const id = lease.snapshot.binding.attempt.operationId;
    await ledger().recordReceipt(
      receipt(lease, {
        type: 'operation.uncertain',
        reason: 'receipt_missing',
      }),
    );
    const cancel = await ledger().cancelRoot(
      f.scope,
      f.ids.runId,
      randomUUID(),
    );
    expect(cancel.operations[0]!.status).toBe('unknown');
    expect(cancel.operations[0]!.cancelRequestId).toBe(cancel.requestId);
    await expect(
      ledger().startOperation(
        receipt(lease, { type: 'operation.transport_ack' }),
      ),
    ).rejects.toThrow('root_canceled');
    const stop = await ledger().recordReceipt(
      receipt(lease, {
        type: 'operation.stopped',
        effects: 'partial',
        evidence: {
          id: randomUUID(),
          recordedAt: new Date().toISOString(),
          digest,
        },
      }),
    );
    expect(stop.snapshot.status).toBe('partial');
    expect((await ledger().readOperation(f.scope, id)).result?.effects).toBe(
      'partial',
    );
  });

  it('does not append late operation evidence to an already terminal legacy RunEvent stream', async () => {
    const f = await fixture();
    const lease = await dispatch(f.make());
    await db`update allrice_runs set state='succeeded',completed_at=clock_timestamp() where id=${f.ids.runId}`;
    expect(
      (await ledger().recordReceipt(receipt(lease, outcome()))).snapshot.status,
    ).toBe('succeeded');
    const [events] = await db<
      { count: string }[]
    >`select count(*) from allrice_run_events where run_id=${f.ids.runId}`;
    expect(Number(events!.count)).toBe(0);
  });

  it('settles a single measured cumulative total exactly once with fresh shared connection', async () => {
    const f = await fixture();
    const input = f.make(5);
    const lease = await dispatch(input);
    await ledger().recordReceipt(receipt(lease, outcome()));
    const request = {
      scope: f.scope,
      operationId: lease.snapshot.binding.attempt.operationId,
      leaseToken: lease.leaseToken,
      observation: observation(input, 2),
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ledger().settleUsage(request)),
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    const budgets = await ledger().readBudget(f.scope, f.ids.runId);
    expect(budgets.budgets[0]).toMatchObject({ reserved: 0, spent: 2 });
    await expect(
      ledger().settleUsage({
        ...request,
        observation: {
          ...request.observation,
          observationId: randomUUID(),
          amount: 3,
        },
      }),
    ).rejects.toThrow('receipt_conflict');
  });

  it('rejects unknown/estimated/overlapping/wrong-source usage; never treats missing cost as zero', async () => {
    const f = await fixture();
    const input = f.make(4);
    const lease = await dispatch(input);
    await ledger().recordReceipt(receipt(lease, outcome()));
    const base = observation(input);
    const invalid: RuntimeUsageObservation[] = [
      { ...base, quality: 'unknown', amount: null },
      { ...base, quality: 'estimated' },
      { ...base, source: { kind: 'estimator', sourceId: 'wrong-meter' } },
      { ...base, mode: 'delta' },
      {
        ...base,
        accountingBoundary: { kind: 'root_run', runId: f.ids.runId },
        aggregation: 'includes_descendants',
      },
    ];
    for (const item of invalid)
      await expect(
        ledger().settleUsage({
          scope: f.scope,
          operationId: lease.snapshot.binding.attempt.operationId,
          leaseToken: lease.leaseToken,
          observation: item,
        }),
      ).rejects.toThrow('invalid_usage');
    expect(
      (await ledger().readBudget(f.scope, f.ids.runId)).budgets[0],
    ).toMatchObject({ reserved: 4, spent: 0 });
  });

  it('records real overspend and durably requests cancellation for remaining operations', async () => {
    const f = await fixture(3);
    const input = f.make();
    const first = await dispatch(input);
    const second = await dispatch(f.make());
    await ledger().recordReceipt(receipt(first, outcome()));
    await ledger().settleUsage({
      scope: f.scope,
      operationId: first.snapshot.binding.attempt.operationId,
      leaseToken: first.leaseToken,
      observation: observation(input, 4),
    });
    const budget = await ledger().readBudget(f.scope, f.ids.runId);
    expect(budget.cancelReason).toBe('budget_exhausted');
    expect(budget.budgets[0]).toMatchObject({ reserved: 1, spent: 4 });
    expect(
      (
        await ledger().readOperation(
          f.scope,
          second.snapshot.binding.attempt.operationId,
        )
      ).status,
    ).toBe('cancel_requested');
  });

  it('enforces persistent root deadline and requests cancellation rather than claiming OS stop', async () => {
    const f = await fixture();
    const lease = await dispatch(f.make());
    const id = lease.snapshot.binding.attempt.operationId;
    await db`update allrice_runtime_roots set deadline_at=clock_timestamp()-interval '1 second' where root_run_id=${f.ids.runId}`;
    await db`update allrice_runtime_operations set lease_expires_at=clock_timestamp()-interval '1 second' where id=${id}`;
    await ledger().expireLeases(f.scope, f.ids.runId);
    expect((await ledger().readBudget(f.scope, f.ids.runId)).cancelReason).toBe(
      'deadline',
    );
    const snapshot = await ledger().readOperation(f.scope, id);
    expect(snapshot.status).toBe('unknown');
    expect(snapshot.cancelRequestId).not.toBeNull();
  });

  it('isolates organizations, projects, targets, and run ownership references', async () => {
    const f = await fixture();
    const other = await fixture();
    const input = f.make();
    await ledger().createOperation(input);
    const id = input.snapshot.binding.attempt.operationId;
    await expect(ledger().readOperation(other.scope, id)).rejects.toThrow(
      'scope_mismatch',
    );
    await expect(
      ledger().readOperation({ ...f.scope, projectId: randomUUID() }, id),
    ).rejects.toThrow('scope_mismatch');
    const wrongTarget = f.make();
    wrongTarget.snapshot.binding.execution.targetId = other.ids.targetId;
    await expect(ledger().createOperation(wrongTarget)).rejects.toThrow(
      'scope_mismatch',
    );
    const wrongRun = f.make();
    wrongRun.snapshot.binding.task = {
      ...wrongRun.snapshot.binding.task,
      runId: other.ids.runId,
      parentRunId: f.ids.runId,
    };
    await expect(ledger().createOperation(wrongRun)).rejects.toThrow(
      'scope_mismatch',
    );
  });

  it('shares one root budget and cancellation across admitted child Runs without a Bridge', async () => {
    const f = await fixture(2);
    const child = await fixture();
    const childRun = randomUUID();
    await db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state) values(${childRun},${f.ids.organizationId},${f.ids.workspaceId},${f.ids.userId},'running')`;
    const first = f.make();
    await dispatch(first);
    const second = f.make();
    second.snapshot.binding.task = {
      ...f.task,
      runId: childRun,
      parentRunId: f.ids.runId,
    };
    await dispatch(second);
    await expect(ledger().createOperation(f.make())).rejects.toThrow(
      'budget_exhausted',
    );
    const cancellation = await ledger().cancelRoot(
      f.scope,
      f.ids.runId,
      randomUUID(),
    );
    expect(cancellation.operations).toHaveLength(2);
    expect(
      cancellation.operations.every((op) => op.status === 'cancel_requested'),
    ).toBe(true);
    const inconsistent = f.make();
    inconsistent.snapshot.binding.task = {
      ...f.task,
      runId: childRun,
      parentRunId: child.ids.runId,
    };
    await expect(ledger().createOperation(inconsistent)).rejects.toThrow();
  });

  it('rejects newly synthesized attempts and altered Bridge input fingerprints before admission', async () => {
    const f = await fixture();
    const input = f.make();
    input.snapshot.binding.attempt.attemptNumber = 2;
    input.snapshot.binding.attempt.fence = 2;
    await expect(ledger().createOperation(input)).rejects.toThrow(
      'invalid_state',
    );
    expect(runtimeLedgerInputDigest({ b: 2, a: 1 })).toBe(
      runtimeLedgerInputDigest({ a: 1, b: 2 }),
    );
    const changed = f.make();
    changed.bridgePayload = {
      capability: 'local.fs.list',
      arguments: { path: '.', limit: 100 },
    };
    await expect(ledger().createOperation(changed)).rejects.toThrow();
  });

  it('binds a Bridge payload exactly and claims a queued device operation only once', async () => {
    const f = await fixture();
    const input = f.make();
    const deviceId = randomUUID();
    await db`update allrice_execution_targets set kind='rice_bridge' where id=${f.ids.targetId}`;
    input.bridgePayload = {
      capability: 'local.fs.list',
      arguments: { path: '.', limit: 100 },
    };
    input.snapshot.binding.execution = {
      ...input.snapshot.binding.execution,
      targetKind: 'rice_bridge',
      deviceId,
      workCopy: { id: randomUUID(), kind: 'in_place' },
    };
    input.snapshot.binding.action = 'local.fs.list';
    input.snapshot.binding.inputDigest = runtimeLedgerInputDigest(
      input.bridgePayload,
    );
    const changed = structuredClone(input);
    changed.bridgePayload!.arguments.path = 'another';
    await expect(ledger().createOperation(changed)).rejects.toThrow(
      'scope_mismatch',
    );
    await ledger().createOperation(input);
    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        ledger().claimNextBridgeOperation({
          scope: f.scope,
          deviceId,
          leaseMs: 60_000,
        }),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.bridgePayload).toEqual(input.bridgePayload);
    expect(
      (
        await ledger().readOperationInput(
          f.scope,
          input.snapshot.binding.attempt.operationId,
        )
      ).bridgePayload,
    ).toEqual(input.bridgePayload);
  });

  it('reports unsettled usage explicitly rather than presenting it as a measured zero', async () => {
    const f = await fixture();
    await ledger().createOperation(f.make());
    expect(
      (await ledger().readBudget(f.scope, f.ids.runId)).budgets[0],
    ).toMatchObject({
      spent: 0,
      unresolvedReservations: 1,
      usageComplete: false,
    });
  });

  it('does not start an admitted child after its root Run has terminated', async () => {
    const f = await fixture();
    const lease = await dispatch(f.make());
    await db`update allrice_runs set state='canceled' where id=${f.ids.runId}`;
    await expect(
      ledger().startOperation(
        receipt(lease, { type: 'operation.transport_ack' }),
      ),
    ).rejects.toThrow('unavailable');
    await expect(
      ledger().heartbeat({
        scope: f.scope,
        operationId: lease.snapshot.binding.attempt.operationId,
        leaseToken: lease.leaseToken,
        leaseMs: 60_000,
      }),
    ).rejects.toThrow('unavailable');
  });

  it.each(['create', 'dispatch', 'start', 'heartbeat'] as const)(
    'rechecks elapsed authority after a delayed %s admission callback',
    async (mode) => {
      const f = await fixture();
      const input = f.make();
      let lease: RuntimeLedgerLease | undefined;
      if (mode !== 'create') await ledger().createOperation(input);
      if (mode === 'start' || mode === 'heartbeat')
        lease = await ledger().dispatch({
          scope: f.scope,
          operationId: input.snapshot.binding.attempt.operationId,
          leaseOwner: randomUUID(),
          leaseMs: 60_000,
        });
      const guarded = createRuntimeOperationLedger({
        database: db,
        admission: async ({ transaction }) => {
          await transaction`select pg_sleep(0.6)`;
        },
      });
      if (mode === 'create' || mode === 'dispatch')
        await db`update allrice_runtime_roots set deadline_at=clock_timestamp()+interval '0.5 second' where root_run_id=${f.ids.runId}`;
      else
        await db`update allrice_runtime_operations set lease_expires_at=clock_timestamp()+interval '0.5 second' where id=${input.snapshot.binding.attempt.operationId}`;
      const call =
        mode === 'create'
          ? guarded.createOperation(input)
          : mode === 'dispatch'
            ? guarded.dispatch({
                scope: f.scope,
                operationId: input.snapshot.binding.attempt.operationId,
                leaseOwner: randomUUID(),
                leaseMs: 60_000,
              })
            : mode === 'start'
              ? guarded.startOperation(
                  receipt(lease!, { type: 'operation.transport_ack' }),
                )
              : guarded.heartbeat({
                  scope: f.scope,
                  operationId: input.snapshot.binding.attempt.operationId,
                  leaseToken: lease!.leaseToken,
                  leaseMs: 60_000,
                });
      await expect(call).rejects.toThrow(
        mode === 'create' || mode === 'dispatch'
          ? 'deadline_exceeded'
          : 'lease_lost',
      );
      if (mode !== 'create')
        expect(
          (
            await ledger().readOperation(
              f.scope,
              input.snapshot.binding.attempt.operationId,
            )
          ).status,
        ).toBe(mode === 'dispatch' ? 'ready' : 'dispatched');
    },
  );
});
