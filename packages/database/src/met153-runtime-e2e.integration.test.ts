import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DatabaseClient from './core/client.ts';
import type {
  RequestContext,
  RuntimeActionBinding,
  RuntimeActionApprovalResponse,
} from '@allrice/contracts';
import {
  assertQuotaAvailable,
  admitModelExecution,
  ModelGovernanceError,
} from './providers/model-governance.ts';
import {
  getEffectiveRuntimeLimit,
  computeRootSuspendedTiming,
} from './runtime-timing.ts';
import { heartbeatJob, maintainQueue } from './execution/queue.ts';
import {
  decideRuntimeActionApproval,
  requestRuntimeActionApproval,
  runtimePolicyDigest,
  setRuntimePolicyControls,
} from './runtime-policy.ts';

const d = (value: unknown) =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

const run = process.env.ALLRICE_RUN_DB_INTEGRATION === '1';
const suite = run ? describe.sequential : describe.skip;

let admin: ReturnType<typeof postgres>;
let database: ReturnType<typeof postgres>;

vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof DatabaseClient>()),
  getDatabase: () => database,
}));

const schema = `met153_e2e_test_${randomUUID().replaceAll('-', '')}`;

async function setupDatabase() {
  if (!process.env.ALLRICE_TEST_DATABASE_URL) {
    throw new Error('ALLRICE_TEST_DATABASE_URL required');
  }
  admin = postgres(process.env.ALLRICE_TEST_DATABASE_URL, {
    max: 2,
    onnotice: () => {},
  });
  await admin.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(20260907, 1)`;
    await transaction`create extension if not exists vector with schema public`;
    await transaction`create extension if not exists pg_trgm with schema public`;
  });
  await admin.unsafe(`create schema "${schema}"`);
  const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL);
  url.searchParams.set('options', `-csearch_path=${schema},public`);
  database = postgres(url.toString(), { max: 5, onnotice: () => {} });

  const migrationsDir = new URL('../migrations/', import.meta.url);
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = await readFile(new URL(file, migrationsDir), 'utf8');
    await database.unsafe(sql);
  }
}

suite('MET-153 PR-1 E2E Database Integration', () => {
  beforeAll(async () => {
    await setupDatabase();
  });

  afterAll(async () => {
    if (database) await database.end();
    if (admin) {
      await admin.unsafe(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
  });

  it('[P1] allows saving max_runtime_ms = 0 (unlimited) and 30 minutes in allrice_model_resource_limits and model policies', async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    await database`
      insert into allrice_organizations (id, name, slug)
      values (${orgId}, 'Test Org', ${'org-' + randomUUID().slice(0, 8)})
    `;
    await database`
      insert into allrice_users (id, email, display_name, password_hash)
      values (${userId}, ${'u-' + randomUUID().slice(0, 8) + '@example.com'}, 'Test User', 'test-hash')
    `;

    // 1. Insert 30 minutes (1800000)
    await database`
      insert into allrice_model_resource_limits (
        id, organization_id, scope_type, scope_id,
        monthly_run_limit, monthly_token_limit, concurrent_run_limit, max_runtime_ms
      ) values (
        ${randomUUID()}, ${orgId}, 'tenant', ${orgId},
        10000, 10000000, 10, 1800000
      )
    `;

    // 2. Update to 0 ("不限制" - unlimited) -> must NOT trigger check constraint violation!
    await database`
      update allrice_model_resource_limits
      set max_runtime_ms = 0
      where organization_id = ${orgId} and scope_type = 'tenant'
    `;

    const [row] = await database<{ max_runtime_ms: number }[]>`
      select max_runtime_ms from allrice_model_resource_limits
      where organization_id = ${orgId} and scope_type = 'tenant'
    `;
    expect(row?.max_runtime_ms).toBe(0);

    // 3. Employee model policies also allow timeout_ms = 0 and 3600000
    const employeeId = randomUUID();
    const workspaceId = randomUUID();
    const connectionId = '52000000-0000-4000-8000-000000000001';
    const catalogEntryId = '53000000-0000-4000-8000-000000000001';

    await database`
      insert into allrice_workspaces (id, organization_id, name, slug)
      values (${workspaceId}, ${orgId}, 'Workspace 1', ${'ws-' + randomUUID().slice(0, 8)})
    `;
    await database`
      insert into allrice_employees (id, organization_id, workspace_id, employee_key, name)
      values (${employeeId}, ${orgId}, ${workspaceId}, 'rice-test', 'Rice Test')
    `;

    await database`
      insert into allrice_employee_model_policies (
        employee_id, organization_id, workspace_id, connection_id,
        model_catalog_entry_id, reasoning_effort, fallback_policy,
        timeout_ms, updated_by
      ) values (
        ${employeeId}, ${orgId}, ${workspaceId}, ${connectionId},
        ${catalogEntryId}, 'low', 'disabled',
        0, ${userId}
      )
    `;

    const [policyRow] = await database<{ timeout_ms: number }[]>`
      select timeout_ms from allrice_employee_model_policies
      where employee_id = ${employeeId}
    `;
    expect(policyRow?.timeout_ms).toBe(0);
  });

  it('[P1] harmonizes tenant quota limit with effective task timeout and admission check', async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const employeeId = randomUUID();

    await database`
      insert into allrice_organizations (id, name, slug)
      values (${orgId}, 'Harmonize Org', ${'org-' + randomUUID().slice(0, 8)})
    `;
    await database`
      insert into allrice_users (id, email, display_name, password_hash)
      values (${userId}, ${'u-' + randomUUID().slice(0, 8) + '@example.com'}, 'User', 'test-hash')
    `;
    await database`
      insert into allrice_workspaces (id, organization_id, name, slug)
      values (${workspaceId}, ${orgId}, 'Harmonize WS', ${'ws-' + randomUUID().slice(0, 8)})
    `;

    // Case A: Tenant sets 30 minutes in allrice_model_resource_limits
    await database`
      insert into allrice_model_resource_limits (
        id, organization_id, scope_type, scope_id,
        monthly_run_limit, monthly_token_limit, concurrent_run_limit, max_runtime_ms
      ) values (
        ${randomUUID()}, ${orgId}, 'tenant', ${orgId},
        10000, 10000000, 10, 1800000
      )
    `;

    // Base policy is 1 hour (3600000), but tenant limit is 30 min (1800000)
    const effectiveTimeout = await getEffectiveRuntimeLimit(
      {
        organizationId: orgId,
        userId,
        employeeId,
        baseTimeoutMs: 3_600_000,
      },
      database,
    );
    expect(effectiveTimeout).toBe(1_800_000); // 30 minutes生效

    // Admission with the resolved effective runtime (1800000) passes!
    // (Previously, requestedRuntimeMs remained 3600000 and was rejected by 1800000 limit)
    const connectionId = '52000000-0000-4000-8000-000000000001';
    await expect(
      admitModelExecution({
        organizationId: orgId,
        workspaceId,
        userId,
        employeeId,
        connectionId,
        requestedTokens: 1000,
        requestedRuntimeMs: effectiveTimeout,
      }),
    ).resolves.toBeDefined();

    // Case B: Tenant sets 0 ("不限制")
    await database`
      update allrice_model_resource_limits
      set max_runtime_ms = 0
      where organization_id = ${orgId} and scope_type = 'tenant'
    `;

    const unlimitedEffective = await getEffectiveRuntimeLimit(
      {
        organizationId: orgId,
        userId,
        employeeId,
        baseTimeoutMs: 3_600_000,
      },
      database,
    );
    expect(unlimitedEffective).toBe(0); // 0 (unlimited)生效

    // Admission with 0 passes!
    await expect(
      admitModelExecution({
        organizationId: orgId,
        workspaceId,
        userId,
        employeeId,
        connectionId,
        requestedTokens: 1000,
        requestedRuntimeMs: unlimitedEffective,
      }),
    ).resolves.toBeDefined();
  });

  it('[P1] Codex subscription mode observes monthly call count without blocking', () => {
    const quota = {
      organizationId: randomUUID(),
      monthlyRunLimit: 10,
      usedRuns: 10, // Maxed out
      monthlyTokenLimit: 1_000_000,
      usedTokens: 100,
      monthlyCostLimitCents: 1000,
      usedCostCents: 0,
      unknownCostRuns: 0,
      usageComplete: true,
      cacheUsageKnown: true,
      periodStart: new Date().toISOString(),
    };

    // Subscription mode: must NOT throw MODEL_RUN_QUOTA_EXCEEDED
    expect(() =>
      assertQuotaAvailable(quota, 'subscription', 1000),
    ).not.toThrow();

    // Metered mode: MUST throw MODEL_RUN_QUOTA_EXCEEDED
    expect(() => assertQuotaAvailable(quota, 'token_metered', 1000)).toThrow(
      new ModelGovernanceError('MODEL_RUN_QUOTA_EXCEEDED'),
    );
  });

  it('[P1] Point 1: heartbeatJob and maintainQueue protect waiting tasks across deadline, and decideRuntimeActionApproval extends root and job timeouts', async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const runId = randomUUID();
    const jobId = randomUUID();
    const workerId = randomUUID();
    const leaseToken = randomUUID();
    const membershipId = randomUUID();
    const policyId = randomUUID();
    const targetId = randomUUID();
    const deviceId = randomUUID();
    const grantId = randomUUID();

    const pastCreatedAt = new Date(Date.now() - 30_000);
    const pastInitialDeadline = new Date(Date.now() - 10_000);
    const leaseExpiresAt = new Date(Date.now() + 60_000);

    const context: RequestContext = {
      requestId: randomUUID(),
      sessionId: randomUUID(),
      actor: { type: 'user', id: userId },
      organizationId: orgId,
      workspaceId,
      memberships: [],
      authenticatedAt: new Date().toISOString(),
    };

    const policyPayload = {
      memberships: [
        {
          id: membershipId,
          userId,
          organizationId: orgId,
          workspaceId,
          role: 'admin' as const,
          active: true,
        },
      ],
      grants: [{ resourceType: 'job', action: 'job:execute', workspaceId }],
    };

    await database`
      insert into allrice_organizations (id, name, slug)
      values (${orgId}, 'Wait Org', ${'org-' + randomUUID().slice(0, 8)})
    `;
    await database`
      insert into allrice_users (id, email, display_name, password_hash)
      values (${userId}, ${'u-' + randomUUID().slice(0, 8) + '@example.com'}, 'User', 'test-hash')
    `;
    await database`
      insert into allrice_workspaces (id, organization_id, name, slug)
      values (${workspaceId}, ${orgId}, 'Wait WS', ${'ws-' + randomUUID().slice(0, 8)})
    `;
    await database`
      insert into allrice_memberships (id, organization_id, workspace_id, user_id, role)
      values (${membershipId}, ${orgId}, ${workspaceId}, ${userId}, 'admin')
    `;
    await database`
      insert into allrice_policy_snapshots (id, organization_id, subject_id, version, payload, expires_at)
      values (${policyId}, ${orgId}, ${userId}, 1, ${database.json(policyPayload)}, now() + interval '1 hour')
    `;
    await database`
      insert into allrice_runs (id, organization_id, workspace_id, owner_id, state, policy_snapshot_id, execution_spec, created_at)
      values (${runId}, ${orgId}, ${workspaceId}, ${userId}, 'running', ${policyId}, '{}'::jsonb, ${pastCreatedAt})
    `;
    await database`
      insert into allrice_execution_targets (id, organization_id, workspace_id, target_key, kind, label, state, capabilities, concurrency_limit, timeout_seconds)
      values (${targetId}, ${orgId}, ${workspaceId}, 'bridge.test', 'rice_bridge', 'P04 target', 'online', '[]'::jsonb, 1, 60)
    `;
    await database`
      insert into allrice_bridge_devices (id, organization_id, workspace_id, owner_id, name, platform, protocol_version, capabilities, token_hash)
      values (${deviceId}, ${orgId}, ${workspaceId}, ${userId}, 'P04 device', 'macos-x64', 2, array['local.fs.write'], ${d(deviceId).slice(7)})
    `;
    await database`
      insert into allrice_bridge_folder_grants (id, organization_id, workspace_id, owner_id, device_id, label, root_fingerprint)
      values (${grantId}, ${orgId}, ${workspaceId}, ${userId}, ${deviceId}, 'P04 temp root', ${'a'.repeat(64)})
    `;

    const taskPayload = JSON.stringify({
      contractVersion: 1,
      runId,
      rootRunId: runId,
      scope: { organizationId: orgId, workspaceId },
    });

    await database`
      insert into allrice_runtime_roots (root_run_id, organization_id, workspace_id, task, deadline_at, initial_deadline_at, created_at)
      values (${runId}, ${orgId}, ${workspaceId}, ${taskPayload}::jsonb, ${pastInitialDeadline}, ${pastInitialDeadline}, ${pastCreatedAt})
    `;
    await database`
      insert into allrice_runtime_run_links (run_id, root_run_id, parent_run_id, organization_id, workspace_id, task)
      values (${runId}, ${runId}, null, ${orgId}, ${workspaceId}, ${taskPayload}::jsonb)
    `;
    await database`
      insert into allrice_jobs (
        id, organization_id, workspace_id, owner_id, run_id, status,
        idempotency_key, timeout_at, initial_timeout_at, payload,
        worker_id, lease_token, claimed_at, heartbeat_at, lease_expires_at, created_at
      ) values (
        ${jobId}, ${orgId}, ${workspaceId}, ${userId}, ${runId}, 'running',
        'job-wait-real-1', ${pastInitialDeadline}, ${pastInitialDeadline},
        '{"schemaVersion":1,"type":"allrice.employee.run","input":{}}'::jsonb,
        ${workerId}, ${leaseToken}, ${pastCreatedAt}, ${pastCreatedAt}, ${leaseExpiresAt}, ${pastCreatedAt}
      )
    `;

    const binding: RuntimeActionBinding = {
      task: {
        scope: { organizationId: orgId, workspaceId, projectId: null },
        chatSessionId: null,
        runId,
        rootRunId: runId,
        parentRunId: null,
        frozenConfiguration: {
          employeeVersionId: null,
          digest: runtimePolicyDigest({}),
        },
      },
      attempt: {
        operationId: randomUUID(),
        attemptId: randomUUID(),
        attemptNumber: 1,
        generation: 0,
        fence: 1,
      },
      requestedBy: { type: 'user', id: userId },
      policy: {
        snapshotId: policyId,
        digest: runtimePolicyDigest(policyPayload),
      },
      execution: {
        targetId,
        targetKind: 'rice_bridge',
        deviceId,
        grantId,
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

    await setRuntimePolicyControls(
      context,
      {
        version: 1,
        enabled: true,
        mode: 'execute',
        rules: [{ action: binding.action, effect: 'ask' }],
      },
      null,
      database,
    );

    // Call official requestRuntimeActionApproval
    const approvalRequest = await requestRuntimeActionApproval(
      {
        context,
        resolveCurrentBinding: async () => structuredClone(binding),
      },
      binding,
      600_000,
      database,
    );
    expect(approvalRequest.approvalId).toBeDefined();

    // Set approval requested_at to pastCreatedAt (30s ago) so suspended wait is ~30s
    await database`
      update allrice_approval_requests
      set requested_at = ${pastCreatedAt}
      where id = ${approvalRequest.approvalId}
    `;

    // 1. Worker heartbeat while job.timeout_at is 10s in the PAST!
    // Must NOT throw or fail with JOB_TIMEOUT because there is an active pending approval!
    const heartbeatResult = await heartbeatJob(
      workerId,
      jobId,
      leaseToken,
      30_000,
    );
    expect(heartbeatResult).toEqual({ active: true, canceled: false });

    // 2. maintainQueue: MUST NOT timeout this job!
    const maintainResult = await maintainQueue(100);
    expect(maintainResult.timeout).toBe(0);

    const [jobRunning] = await database<{ status: string }[]>`
      select status from allrice_jobs where id = ${jobId}
    `;
    expect(jobRunning?.status).toBe('running');

    // 3. User calls REAL decideRuntimeActionApproval
    const approvalResponse: RuntimeActionApprovalResponse = {
      contractVersion: 1,
      direction: 'response',
      kind: 'action_approval',
      requestId: approvalRequest.requestId,
      version: approvalRequest.version,
      requestDigest: approvalRequest.requestDigest,
      task: approvalRequest.task,
      responseId: randomUUID(),
      respondedBy: userId,
      respondedAt: new Date().toISOString(),
      approvalId: approvalRequest.approvalId,
      decision: 'approved',
    };

    const accepted = await decideRuntimeActionApproval(
      context,
      approvalRequest.approvalId,
      approvalResponse,
      database,
    );
    expect(accepted.decision).toBe('approved');

    // 4. Verify that deadline_at and timeout_at were AUTOMATICALLY extended into the future!
    const [updatedRoot] = await database<{ deadline_at: Date }[]>`
      select deadline_at from allrice_runtime_roots where root_run_id = ${runId}
    `;
    const [updatedJob] = await database<{ timeout_at: Date }[]>`
      select timeout_at from allrice_jobs where id = ${jobId}
    `;

    expect(updatedRoot?.deadline_at.getTime()).toBeGreaterThan(Date.now());
    expect(updatedJob?.timeout_at.getTime()).toBeGreaterThan(Date.now());

    // 5. Subsequent heartbeatJob succeeds cleanly
    const postHeartbeat = await heartbeatJob(
      workerId,
      jobId,
      leaseToken,
      30_000,
    );
    expect(postHeartbeat).toEqual({ active: true, canceled: false });
  });

  it('[P1] Point 2: historical device waiting intervals are preserved after device recovery and deducted for both assistant and non-assistant tasks', async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const rootRunId = randomUUID();
    const operationId = randomUUID();
    const targetId = randomUUID();
    const deviceId = randomUUID();

    const t0 = new Date('2026-09-22T10:00:00.000Z');
    const tWait30m = new Date('2026-09-22T10:30:00.000Z');
    const tNow40m = new Date('2026-09-22T10:40:00.000Z');

    await database`
      insert into allrice_organizations (id, name, slug)
      values (${orgId}, 'Device Org', ${'org-' + randomUUID().slice(0, 8)})
    `;
    await database`
      insert into allrice_users (id, email, display_name, password_hash)
      values (${userId}, ${'u-' + randomUUID().slice(0, 8) + '@example.com'}, 'User', 'test-hash')
    `;
    await database`
      insert into allrice_workspaces (id, organization_id, name, slug)
      values (${workspaceId}, ${orgId}, 'Device WS', ${'ws-' + randomUUID().slice(0, 8)})
    `;
    await database`
      insert into allrice_runs (id, organization_id, workspace_id, owner_id, state, created_at)
      values (${rootRunId}, ${orgId}, ${workspaceId}, ${userId}, 'running', ${t0})
    `;
    await database`
      insert into allrice_execution_targets (id, organization_id, workspace_id, target_key, kind, label, state, capabilities, concurrency_limit, timeout_seconds)
      values (${targetId}, ${orgId}, ${workspaceId}, 'bridge.test', 'rice_bridge', 'Target', 'online', '[]'::jsonb, 1, 60)
    `;
    await database`
      insert into allrice_bridge_devices (id, organization_id, workspace_id, owner_id, name, platform, protocol_version, capabilities, token_hash)
      values (${deviceId}, ${orgId}, ${workspaceId}, ${userId}, 'Device', 'macos-x64', 2, array['local.fs.write'], ${d(deviceId).slice(7)})
    `;

    const rootTask = {
      contractVersion: 1,
      runId: rootRunId,
      rootRunId,
      scope: { organizationId: orgId, workspaceId },
    };
    await database`
      insert into allrice_runtime_roots (root_run_id, organization_id, workspace_id, task, deadline_at, initial_deadline_at, created_at)
      values (${rootRunId}, ${orgId}, ${workspaceId}, ${database.json(rootTask)}, ${new Date(t0.getTime() + 3_600_000)}, ${new Date(t0.getTime() + 3_600_000)}, ${t0})
    `;

    const binding = {
      task: rootTask,
      attempt: {
        operationId,
        attemptId: randomUUID(),
        attemptNumber: 1,
        generation: 0,
        fence: 1,
      },
      execution: {
        targetId,
        targetKind: 'rice_bridge',
        deviceId,
        grantId: randomUUID(),
        grantVersion: 1,
        scopeDigest: `sha256:${'a'.repeat(64)}`,
        workCopy: { id: randomUUID(), kind: 'in_place' },
      },
      action: 'local.fs.write',
      inputDigest: d({ path: 'test.txt' }),
      dataScope: [],
      baseline: [],
      command: null,
    };

    const idempotencyKey = randomUUID();
    const initialSnapshot = {
      schemaVersion: 1,
      binding,
      status: 'waiting_device',
      fence: 1,
      idempotencyKey,
      attempt: 1,
      generation: 0,
      processId: null,
      cancelRequestId: null,
      uncertainAt: null,
      result: null,
    };

    // 1. Operation is created in waiting_device state at 10:00
    await database`
      insert into allrice_runtime_operations (
        id, organization_id, workspace_id, run_id, root_run_id, target_id, device_id,
        attempt_id, attempt_number, generation, fence, idempotency_key,
        initial_snapshot, snapshot, bridge_payload, created_at, updated_at
      ) values (
        ${operationId}, ${orgId}, ${workspaceId}, ${rootRunId}, ${rootRunId}, ${targetId}, ${deviceId},
        ${binding.attempt.attemptId}, 1, 0, 1, ${idempotencyKey},
        ${database.json(initialSnapshot)}, ${database.json(initialSnapshot)}, '{}'::jsonb,
        ${t0}, ${t0}
      )
    `;

    // Event 0: operation.waiting with reason: 'device' at 10:00
    await database`
      insert into allrice_runtime_operation_events (id, operation_id, sequence, payload, created_at)
      values (
        ${randomUUID()}, ${operationId}, 0,
        ${database.json({
          family: 'allrice.runtime.operation',
          contractVersion: 1,
          eventId: randomUUID(),
          signal: { type: 'operation.waiting', reason: 'device' },
          occurredAt: t0.toISOString(),
        })},
        ${t0}
      )
    `;

    // Before recovery (at 10:30): device wait is 30 minutes, isSuspended is true
    const timingBefore = await computeRootSuspendedTiming(
      {
        rootRunId,
        rootCreatedAt: t0,
        now: tWait30m,
      },
      database,
    );
    expect(timingBefore.isSuspended).toBe(true);
    expect(timingBefore.suspensionReason).toBe('waiting_device');
    expect(timingBefore.suspendedWaitMs).toBe(30 * 60 * 1000);
    expect(timingBefore.effectiveRuntimeMs).toBe(0);

    // 2. Device recovers at 10:30!
    // Event 1: operation.ready at 10:30
    await database`
      insert into allrice_runtime_operation_events (id, operation_id, sequence, payload, created_at)
      values (
        ${randomUUID()}, ${operationId}, 1,
        ${database.json({
          family: 'allrice.runtime.operation',
          contractVersion: 1,
          eventId: randomUUID(),
          signal: { type: 'operation.ready' },
          occurredAt: tWait30m.toISOString(),
        })},
        ${tWait30m}
      )
    `;
    // Event 2: operation.dispatched at 10:30
    await database`
      insert into allrice_runtime_operation_events (id, operation_id, sequence, payload, created_at)
      values (
        ${randomUUID()}, ${operationId}, 2,
        ${database.json({
          family: 'allrice.runtime.operation',
          contractVersion: 1,
          eventId: randomUUID(),
          signal: { type: 'operation.dispatched' },
          occurredAt: tWait30m.toISOString(),
        })},
        ${tWait30m}
      )
    `;
    // Operation status updated to 'dispatched'
    await database`
      update allrice_runtime_operations
      set snapshot = jsonb_set(snapshot, '{status}', '"dispatched"'), updated_at = ${tWait30m}
      where id = ${operationId}
    `;

    // 3. After recovery (at 10:40):
    // Device is running, BUT the 30-minute historical wait MUST NOT BE LOST!
    const timingAfter = await computeRootSuspendedTiming(
      {
        rootRunId,
        rootCreatedAt: t0,
        now: tNow40m,
      },
      database,
    );

    expect(timingAfter.isSuspended).toBe(false);
    expect(timingAfter.suspensionReason).toBeNull();
    // Historical 30 minutes wait is PRESERVED! (In previous broken code, this became 0!)
    expect(timingAfter.suspendedWaitMs).toBe(30 * 60 * 1000);
    expect(timingAfter.wallClockElapsedMs).toBe(40 * 60 * 1000);
    // Effective runtime is 40m wall clock - 30m device wait = 10 minutes!
    expect(timingAfter.effectiveRuntimeMs).toBe(10 * 60 * 1000);
  });

  it('[P1] Point 3: parent assistant active execution is NOT deducted when child is waiting for approval', async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const rootRunId = randomUUID();
    const childRunId = randomUUID();
    const jobId = randomUUID();
    const t0 = new Date('2026-09-22T10:00:00.000Z');
    const t10 = new Date('2026-09-22T10:10:00.000Z');
    const t30 = new Date('2026-09-22T10:30:00.000Z');

    await database`
      insert into allrice_organizations (id, name, slug)
      values (${orgId}, 'Parent Child Org', ${'org-' + randomUUID().slice(0, 8)})
    `;
    await database`
      insert into allrice_users (id, email, display_name, password_hash)
      values (${userId}, ${'u-' + randomUUID().slice(0, 8) + '@example.com'}, 'User', 'test-hash')
    `;
    await database`
      insert into allrice_workspaces (id, organization_id, name, slug)
      values (${workspaceId}, ${orgId}, 'Parent Child WS', ${'ws-' + randomUUID().slice(0, 8)})
    `;
    await database`
      insert into allrice_runs (id, organization_id, workspace_id, owner_id, state, created_at)
      values (${rootRunId}, ${orgId}, ${workspaceId}, ${userId}, 'running', ${t0})
    `;
    await database`
      insert into allrice_runs (id, organization_id, workspace_id, owner_id, state, created_at)
      values (${childRunId}, ${orgId}, ${workspaceId}, ${userId}, 'running', ${t10})
    `;

    const rootTask = {
      contractVersion: 1,
      runId: rootRunId,
      rootRunId,
      scope: { organizationId: orgId, workspaceId },
    };
    await database`
      insert into allrice_runtime_roots (root_run_id, organization_id, workspace_id, task, deadline_at, initial_deadline_at, created_at)
      values (${rootRunId}, ${orgId}, ${workspaceId}, ${database.json(rootTask)}, ${new Date(t0.getTime() + 3_600_000)}, ${new Date(t0.getTime() + 3_600_000)}, ${t0})
    `;
    await database`
      insert into allrice_runtime_run_links (run_id, root_run_id, parent_run_id, organization_id, workspace_id, task)
      values (${rootRunId}, ${rootRunId}, null, ${orgId}, ${workspaceId}, ${database.json(rootTask)})
    `;
    await database`
      insert into allrice_runtime_run_links (run_id, root_run_id, parent_run_id, organization_id, workspace_id, task)
      values (${childRunId}, ${rootRunId}, ${rootRunId}, ${orgId}, ${workspaceId}, ${database.json({ ...rootTask, runId: childRunId, parentRunId: rootRunId })})
    `;

    await database`
      insert into allrice_jobs (
        id, organization_id, workspace_id, owner_id, run_id, status,
        idempotency_key, created_at, timeout_at, initial_timeout_at, payload
      ) values (
        ${jobId}, ${orgId}, ${workspaceId}, ${userId}, ${rootRunId}, 'queued',
        ${'job-p3-' + randomUUID().slice(0, 8)}, ${t0}, ${new Date(t0.getTime() + 3_600_000)}, ${new Date(t0.getTime() + 3_600_000)},
        '{"schemaVersion":1,"type":"allrice.employee.run","input":{}}'::jsonb
      )
    `;

    // Parent assistant instance: actively running from 10:00 to 10:30 (stopped_at: null)
    await database`
      insert into allrice_assistant_roots (
        root_run_id, configuration, worker_job_id, worker_id, worker_lease_digest, generation
      ) values (
        ${rootRunId}, '{}'::jsonb, ${jobId}, ${randomUUID()}, 'sha256:0000000000000000000000000000000000000000000000000000000000000000', 1
      )
    `;
    await database`
      insert into allrice_assistant_instances (
        run_id, root_run_id, parent_run_id, native_session_id, delegation_id, creation_digest,
        label, depth, allowed_tools, artifact_namespace, status,
        created_at, stopped_at
      ) values (
        ${rootRunId}, ${rootRunId}, null, 'native-parent', ${rootRunId}, 'digest-parent',
        'Parent Rice', 0, '[]'::jsonb, ${'ns-p-' + randomUUID()}, 'running',
        ${t0}, null
      )
    `;

    // Child assistant instance: created at 10:10
    await database`
      insert into allrice_assistant_instances (
        run_id, root_run_id, parent_run_id, native_session_id, delegation_id, creation_digest,
        label, depth, allowed_tools, artifact_namespace, status,
        created_at, stopped_at
      ) values (
        ${childRunId}, ${rootRunId}, ${rootRunId}, 'native-child', ${randomUUID()}, 'digest-child',
        'Child Branch', 1, '[]'::jsonb, ${'ns-c-' + randomUUID()}, 'running',
        ${t10}, null
      )
    `;

    // Child requests approval at 10:10 and is decided at 10:30 (20m wait)
    const childApprovalId = randomUUID();
    const bindingDigest = `sha256:${'b'.repeat(64)}`;
    await database`
      insert into allrice_approval_requests (
        id, organization_id, workspace_id, run_id, actor_id,
        resource_type, resource_id, action, input_digest,
        status, requested_at, decided_by, decided_at, runtime_expires_at,
        runtime_request, runtime_binding_digest, runtime_control_version
      ) values (
        ${childApprovalId}, ${orgId}, ${workspaceId}, ${childRunId}, ${userId},
        'runtime_operation', ${randomUUID()}, 'cloud:deploy',
        ${bindingDigest},
        'approved', ${t10}, ${userId}, ${t30}, ${new Date('2026-09-22T11:00:00.000Z')},
        '{"action":"cloud:deploy"}'::jsonb, ${bindingDigest}, 1
      )
    `;

    // At 10:30:
    // Child had a 20-minute approval wait [10:10 - 10:30]
    // BUT Parent was actively running during [10:00 - 10:30]!
    // The parent was NOT paused!
    // Therefore, overall task suspendedWaitMs is 0 (NOT 20 or 40 minutes)!
    const timing = await computeRootSuspendedTiming(
      {
        rootRunId,
        rootCreatedAt: t0,
        now: t30,
      },
      database,
    );

    expect(timing.suspendedWaitMs).toBe(0);
    expect(timing.effectiveRuntimeMs).toBe(30 * 60 * 1000);
  });

  it('[P1] Point 4: session model snapshot vs tenant quota harmonization prevents false MODEL_RUNTIME_LIMIT_EXCEEDED in worker', async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const employeeId = randomUUID();
    const connectionId = '52000000-0000-4000-8000-000000000001';

    await database`
      insert into allrice_organizations (id, name, slug)
      values (${orgId}, 'Snapshot Org', ${'org-' + randomUUID().slice(0, 8)})
    `;
    await database`
      insert into allrice_users (id, email, display_name, password_hash)
      values (${userId}, ${'u-' + randomUUID().slice(0, 8) + '@example.com'}, 'User', 'test-hash')
    `;
    await database`
      insert into allrice_workspaces (id, organization_id, name, slug)
      values (${workspaceId}, ${orgId}, 'Snapshot WS', ${'ws-' + randomUUID().slice(0, 8)})
    `;

    // Tenant admin changes limit to 30 minutes (1,800,000 ms)
    await database`
      insert into allrice_model_resource_limits (
        id, organization_id, scope_type, scope_id,
        monthly_run_limit, monthly_token_limit, concurrent_run_limit, max_runtime_ms
      ) values (
        ${randomUUID()}, ${orgId}, 'tenant', ${orgId},
        10000, 10000000, 10, 1800000
      )
    `;

    // Existing session has an older frozen model snapshot of 1 hour (3,600,000 ms)
    const sessionFrozenTimeout = 3_600_000;

    // New run resolves effective runtime limit against the tenant's new limit:
    const effectiveTimeout = await getEffectiveRuntimeLimit(
      {
        organizationId: orgId,
        userId,
        employeeId,
        baseTimeoutMs: sessionFrozenTimeout,
      },
      database,
    );
    expect(effectiveTimeout).toBe(1_800_000);

    // If worker used the old session model snapshot (3,600,000 ms), admission throws MODEL_RUNTIME_LIMIT_EXCEEDED:
    await expect(
      admitModelExecution({
        organizationId: orgId,
        workspaceId,
        userId,
        employeeId,
        connectionId,
        requestedTokens: 1000,
        requestedRuntimeMs: sessionFrozenTimeout, // 1 hour -> exceeds 30m limit!
      }),
    ).rejects.toThrow('MODEL_RUNTIME_LIMIT_EXCEEDED');

    // But with the unified effective policy runtime (1,800,000 ms), admission SUCCEEDS:
    await expect(
      admitModelExecution({
        organizationId: orgId,
        workspaceId,
        userId,
        employeeId,
        connectionId,
        requestedTokens: 1000,
        requestedRuntimeMs: effectiveTimeout, // 30 min -> admitted!
      }),
    ).resolves.toBeDefined();
  });

  it('[P1] parallel branches: active branch work subtracts from waiting time and prevents false extension', async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const rootRunId = randomUUID();
    const branchBRunId = randomUUID();
    const jobId = randomUUID();
    const rootCreatedAt = new Date('2026-09-22T10:00:00.000Z');

    await database`
      insert into allrice_organizations (id, name, slug)
      values (${orgId}, 'Branch Org', ${'org-' + randomUUID().slice(0, 8)})
    `;
    await database`
      insert into allrice_users (id, email, display_name, password_hash)
      values (${userId}, ${'u-' + randomUUID().slice(0, 8) + '@example.com'}, 'User', 'test-hash')
    `;
    await database`
      insert into allrice_workspaces (id, organization_id, name, slug)
      values (${workspaceId}, ${orgId}, 'Branch WS', ${'ws-' + randomUUID().slice(0, 8)})
    `;
    await database`
      insert into allrice_runs (id, organization_id, workspace_id, owner_id, state)
      values (${rootRunId}, ${orgId}, ${workspaceId}, ${userId}, 'running')
    `;
    await database`
      insert into allrice_runs (id, organization_id, workspace_id, owner_id, state)
      values (${branchBRunId}, ${orgId}, ${workspaceId}, ${userId}, 'succeeded')
    `;
    const rootTask = JSON.stringify({
      contractVersion: 1,
      runId: rootRunId,
      rootRunId,
      scope: { organizationId: orgId, workspaceId },
    });

    await database`
      insert into allrice_runtime_roots (root_run_id, organization_id, workspace_id, task, deadline_at, initial_deadline_at, created_at)
      values (${rootRunId}, ${orgId}, ${workspaceId}, ${rootTask}::jsonb, ${rootCreatedAt}, ${rootCreatedAt}, ${rootCreatedAt})
    `;
    const deadline = new Date(rootCreatedAt.getTime() + 3_600_000);
    await database`
      insert into allrice_jobs (
        id, organization_id, workspace_id, owner_id, run_id, status,
        idempotency_key, created_at, timeout_at, initial_timeout_at, payload
      ) values (
        ${jobId}, ${orgId}, ${workspaceId}, ${userId}, ${rootRunId}, 'queued',
        ${'job-' + randomUUID().slice(0, 8)}, ${rootCreatedAt}, ${deadline}, ${deadline},
        '{"schemaVersion":1,"type":"allrice.employee.run","input":{}}'::jsonb
      )
    `;
    await database`
      insert into allrice_runtime_run_links (run_id, root_run_id, parent_run_id, organization_id, workspace_id, task)
      values (${rootRunId}, ${rootRunId}, null, ${orgId}, ${workspaceId}, '{"contractVersion":1}'::jsonb)
    `;
    await database`
      insert into allrice_runtime_run_links (run_id, root_run_id, parent_run_id, organization_id, workspace_id, task)
      values (${branchBRunId}, ${rootRunId}, ${rootRunId}, ${orgId}, ${workspaceId}, '{"contractVersion":1}'::jsonb)
    `;

    // Branch A requests approval at 10:10, decided at 10:30 (20 min wait)
    const approvalAId = randomUUID();
    const bindingDigestA = `sha256:${'a'.repeat(64)}`;
    await database`
      insert into allrice_approval_requests (
        id, organization_id, workspace_id, run_id, actor_id,
        resource_type, resource_id, action, input_digest,
        status, requested_at, decided_by, decided_at, runtime_expires_at,
        runtime_request, runtime_binding_digest, runtime_control_version
      ) values (
        ${approvalAId}, ${orgId}, ${workspaceId}, ${rootRunId}, ${userId},
        'runtime_operation', ${randomUUID()}, 'cloud:deploy',
        ${bindingDigestA},
        'approved', ${new Date('2026-09-22T10:10:00.000Z')},
        ${userId},
        ${new Date('2026-09-22T10:30:00.000Z')},
        ${new Date('2026-09-22T11:00:00.000Z')},
        '{"action":"cloud:deploy"}'::jsonb, ${bindingDigestA}, 1
      )
    `;

    // But Branch B was actively running between 10:00 and 10:20!
    // (So during 10:10 to 10:20, Branch B was working! Nothing was suspended until 10:20!)
    await database`
      insert into allrice_assistant_roots (
        root_run_id, configuration, worker_job_id, worker_id, worker_lease_digest, generation
      ) values (
        ${rootRunId}, '{}'::jsonb,
        ${jobId},
        ${randomUUID()},
        'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        1
      )
    `;
    await database`
      insert into allrice_assistant_instances (
        run_id, root_run_id, parent_run_id, native_session_id, delegation_id, creation_digest,
        label, depth, allowed_tools, artifact_namespace, status,
        created_at, stopped_at
      ) values (
        ${rootRunId}, ${rootRunId}, null, 'native-root', ${rootRunId}, 'digest-root',
        'Rice', 0, '[]'::jsonb, ${'ns-root-' + randomUUID()}, 'running',
        ${rootCreatedAt}, null
      )
    `;
    await database`
      insert into allrice_assistant_instances (
        run_id, root_run_id, parent_run_id, native_session_id, delegation_id, creation_digest,
        label, depth, allowed_tools, artifact_namespace, status,
        created_at, stopped_at
      ) values (
        ${branchBRunId}, ${rootRunId}, ${rootRunId}, 'native-b', ${randomUUID()}, 'digest-b',
        'Branch B', 1, '[]'::jsonb, ${'ns-b-' + randomUUID()}, 'completed',
        ${new Date('2026-09-22T10:00:00.000Z')},
        ${new Date('2026-09-22T10:20:00.000Z')}
      )
    `;

    const timing = await computeRootSuspendedTiming(
      {
        rootRunId,
        rootCreatedAt,
        now: new Date('2026-09-22T10:30:00.000Z'),
      },
      database,
    );

    // Total wait of A was 20 min [10:10 - 10:30]
    // Branch B was active during [10:00 - 10:20]
    // Overlap: [10:10 - 10:20] was NOT suspended because Branch B was executing!
    // Suspended interval is strictly [10:20 - 10:30] = 10 minutes!
    expect(timing.suspendedWaitMs).toBe(10 * 60 * 1000); // 10 minutes, NOT 20 minutes!
  });
});
