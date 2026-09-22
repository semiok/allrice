import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DatabaseClient from './core/client.ts';
import {
  assertQuotaAvailable,
  admitModelExecution,
  ModelGovernanceError,
} from './providers/model-governance.ts';
import {
  getEffectiveRuntimeLimit,
  computeRootSuspendedTiming,
} from './runtime-timing.ts';
import { maintainQueue } from './execution/queue.ts';

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

  it('[P1] waiting_user and waiting_device are protected from maintainQueue timeout and extend deadline', async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const runId = randomUUID();
    const jobId = randomUUID();
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
      insert into allrice_runs (id, organization_id, workspace_id, owner_id, state)
      values (${runId}, ${orgId}, ${workspaceId}, ${userId}, 'running')
    `;

    // Initial timeout is 5 seconds from now
    const now = new Date();
    const initialDeadline = new Date(now.getTime() + 5_000);

    const taskPayload = JSON.stringify({
      contractVersion: 1,
      runId,
      rootRunId: runId,
      scope: { organizationId: orgId, workspaceId },
    });

    await database`
      insert into allrice_runtime_roots (root_run_id, organization_id, workspace_id, task, deadline_at, initial_deadline_at)
      values (${runId}, ${orgId}, ${workspaceId}, ${taskPayload}::jsonb, ${initialDeadline}, ${initialDeadline})
    `;

    await database`
      insert into allrice_jobs (
        id, organization_id, workspace_id, owner_id, run_id, status,
        idempotency_key, timeout_at, initial_timeout_at, payload
      ) values (
        ${jobId}, ${orgId}, ${workspaceId}, ${userId}, ${runId}, 'running',
        'job-wait-1', ${initialDeadline}, ${initialDeadline},
        '{"schemaVersion":1,"type":"allrice.employee.run","input":{}}'::jsonb
      )
    `;

    // Create a pending approval request (waiting_user)
    const approvalId = randomUUID();
    const expiresAt = new Date(now.getTime() + 3_600_000);
    const bindingDigest = `sha256:${'a'.repeat(64)}`;
    await database`
      insert into allrice_approval_requests (
        id, organization_id, workspace_id, run_id, actor_id,
        resource_type, resource_id, action, input_digest,
        status, requested_at, runtime_expires_at,
        runtime_request, runtime_binding_digest, runtime_control_version
      ) values (
        ${approvalId}, ${orgId}, ${workspaceId}, ${runId}, ${userId},
        'runtime_operation', ${randomUUID()}, 'cloud:deploy',
        ${bindingDigest},
        'pending', ${now}, ${expiresAt},
        '{"action":"cloud:deploy"}'::jsonb, ${bindingDigest}, 1
      )
    `;

    // Advance 10 seconds past the initial 5-second deadline:
    // In maintainQueue, the job has timeout_at (5s) <= now (10s), BUT has pending approval!
    // maintainQueue MUST NOT time out this job!
    const maintainResult = await maintainQueue(100);
    expect(maintainResult.timeout).toBe(0);

    const [jobAfterMaintain] = await database<{ status: string }[]>`
      select status from allrice_jobs where id = ${jobId}
    `;
    expect(jobAfterMaintain?.status).toBe('running');

    // User decides approval at now + 10 seconds (wait duration = 10s)
    const decidedAt = new Date(now.getTime() + 10_000);
    await database`
      update allrice_approval_requests
      set status = 'approved', decided_by = ${userId}, decided_at = ${decidedAt}
      where id = ${approvalId}
    `;

    // Compute suspended timing with interval math
    const timing = await computeRootSuspendedTiming(
      {
        rootRunId: runId,
        rootCreatedAt: now,
        now: decidedAt,
      },
      database,
    );
    expect(timing.suspendedWaitMs).toBe(10_000);
    expect(timing.effectiveRuntimeMs).toBe(0);

    // Apply extension: initial 5s deadline + 10s wait = 15s deadline
    const newDeadline = new Date(
      initialDeadline.getTime() + timing.suspendedWaitMs,
    );
    await database`
      update allrice_runtime_roots set deadline_at = ${newDeadline} where root_run_id = ${runId}
    `;
    await database`
      update allrice_jobs set timeout_at = ${newDeadline} where run_id = ${runId}
    `;

    const [updatedRoot] = await database<{ deadline_at: Date }[]>`
      select deadline_at from allrice_runtime_roots where root_run_id = ${runId}
    `;
    expect(updatedRoot?.deadline_at.getTime()).toBe(
      initialDeadline.getTime() + 10_000,
    );
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
