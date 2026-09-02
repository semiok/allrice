import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

import type { ExecutionContext } from '@allrice/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase, getDatabase } from './core/client.ts';
import {
  createManagedBrowserTask,
  startManagedBrowserTask,
} from './p1-runtime.ts';
import { completeJob, failJob, maintainQueue } from './queue.ts';

const runIntegration = process.env.ALLRICE_RUN_DB_INTEGRATION === '1';
const describeDatabase = runIntegration ? describe.sequential : describe.skip;

type Scenario = {
  context: ExecutionContext;
  lease: { attempt: number; leaseToken: string };
  ids: {
    organizationId: string;
    workspaceId: string;
    userId: string;
    runId: string;
    jobId: string;
    workerId: string;
    targetId: string;
  };
};

const migrationsDirectory = new URL('../migrations/', import.meta.url);
const originalDatabaseUrl = process.env.DATABASE_URL;
let adminSql: ReturnType<typeof postgres> | undefined;
let schemaName = '';

function databaseUrlWithSearchPath(databaseUrl: string, schema: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-csearch_path=${schema},public`);
  return url.toString();
}

async function seedScenario(
  input: {
    concurrencyLimit?: number;
    timeoutSeconds?: number;
    maxAttempts?: number;
  } = {},
): Promise<Scenario> {
  const sql = getDatabase();
  const ids = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    userId: randomUUID(),
    runId: randomUUID(),
    jobId: randomUUID(),
    workerId: randomUUID(),
    targetId: randomUUID(),
  };
  const policyId = randomUUID();
  const membershipId = randomUUID();
  const leaseToken = randomUUID();
  const slug = `test-${ids.organizationId.slice(0, 8)}`;
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + 60 * 60 * 1_000);
  const timeoutAt = new Date(now.getTime() + 2 * 60 * 60 * 1_000);
  const policyExpiresAt = new Date(now.getTime() + 3 * 60 * 60 * 1_000);
  const membership = {
    id: membershipId,
    userId: ids.userId,
    organizationId: ids.organizationId,
    workspaceId: ids.workspaceId,
    role: 'member' as const,
    active: true,
  };

  await sql.begin(async (transaction) => {
    await transaction`
      insert into allrice_users (id, email, display_name, password_hash)
      values (
        ${ids.userId}, ${`${slug}@example.test`}, 'MET-98 Test', 'not-a-login'
      )
    `;
    await transaction`
      insert into allrice_organizations (id, slug, name)
      values (${ids.organizationId}, ${slug}, 'MET-98 Test')
    `;
    await transaction`
      insert into allrice_workspaces (id, organization_id, slug, name)
      values (${ids.workspaceId}, ${ids.organizationId}, 'default', 'Default')
    `;
    await transaction`
      insert into allrice_memberships (
        id, organization_id, workspace_id, user_id, role
      ) values (
        ${membershipId}, ${ids.organizationId}, ${ids.workspaceId},
        ${ids.userId}, 'member'
      )
    `;
    await transaction`
      insert into allrice_policy_snapshots (
        id, organization_id, subject_id, version, payload, issued_at, expires_at
      ) values (
        ${policyId}, ${ids.organizationId}, ${ids.userId}, 1,
        ${transaction.json({ memberships: [membership], grants: [] })},
        ${now}, ${policyExpiresAt}
      )
    `;
    await transaction`
      insert into allrice_runs (
        id, organization_id, workspace_id, owner_id, state,
        policy_snapshot_id, execution_spec, input, started_at
      ) values (
        ${ids.runId}, ${ids.organizationId}, ${ids.workspaceId}, ${ids.userId},
        'running', ${policyId}, ${transaction.json({})},
        ${transaction.json({ prompt: 'browser lifecycle test' })}, ${now}
      )
    `;
    await transaction`
      insert into allrice_jobs (
        id, organization_id, workspace_id, owner_id, run_id, status,
        idempotency_key, attempt, max_attempts, timeout_at, payload,
        worker_id, lease_token, claimed_at, heartbeat_at, lease_expires_at
      ) values (
        ${ids.jobId}, ${ids.organizationId}, ${ids.workspaceId}, ${ids.userId},
        ${ids.runId}, 'running', ${`job:${ids.jobId}`}, 1,
        ${input.maxAttempts ?? 3}, ${timeoutAt},
        ${transaction.json({ kind: 'met98.browser.lifecycle.test' })},
        ${ids.workerId}, ${leaseToken}, ${now}, ${now}, ${leaseExpiresAt}
      )
    `;
    await transaction`
      insert into allrice_execution_targets (
        id, organization_id, workspace_id, target_key, kind, label, state,
        capabilities, concurrency_limit, timeout_seconds, last_heartbeat_at
      ) values (
        ${ids.targetId}, ${ids.organizationId}, ${ids.workspaceId},
        'cloud.default', 'cloud_sandbox', 'Test Chromium', 'online',
        ${transaction.json(['browser.navigate', 'artifacts.write'])},
        ${input.concurrencyLimit ?? 1}, ${input.timeoutSeconds ?? 900}, ${now}
      )
    `;
  });

  const context = {
    executionId: randomUUID(),
    runId: ids.runId,
    jobId: ids.jobId,
    worker: { type: 'worker' as const, id: ids.workerId },
    delegatedBy: { type: 'user' as const, id: ids.userId },
    organizationId: ids.organizationId,
    workspaceId: ids.workspaceId,
    policySnapshot: {
      id: policyId,
      organizationId: ids.organizationId,
      subjectId: ids.userId,
      version: 1,
      issuedAt: now.toISOString(),
      expiresAt: policyExpiresAt.toISOString(),
      memberships: [membership],
      grants: [],
    },
    startedAt: now.toISOString(),
  } satisfies ExecutionContext;

  return {
    context,
    lease: { attempt: 1, leaseToken },
    ids,
  };
}

function taskInput(
  scenario: Scenario,
  toolCallId: string,
  startUrl = 'https://example.com',
) {
  return {
    runId: scenario.ids.runId,
    targetId: scenario.ids.targetId,
    startUrl,
    allowedDomains: [new URL(startUrl).hostname],
    steps: [],
    toolCallId,
  };
}

async function taskState(taskId: string) {
  const sql = getDatabase();
  const rows = await sql<
    { status: string; error_code: string | null; job_attempt: number }[]
  >`
    select status, error_code, job_attempt
    from allrice_managed_browser_tasks
    where id = ${taskId}
  `;
  return rows[0];
}

describeDatabase(
  'MET-98 managed browser durable lifecycle (PostgreSQL)',
  () => {
    beforeAll(async () => {
      const baseDatabaseUrl =
        process.env.ALLRICE_TEST_DATABASE_URL ??
        originalDatabaseUrl ??
        'postgres://allrice:allrice@localhost:5432/allrice_dev';
      const baseUrl = new URL(baseDatabaseUrl);
      baseUrl.search = '';
      schemaName = `met98_browser_${randomUUID().replaceAll('-', '')}`;
      adminSql = postgres(baseUrl.toString(), { max: 1, onnotice: () => {} });
      await adminSql.unsafe(`create schema "${schemaName}"`);

      const scopedDatabaseUrl = databaseUrlWithSearchPath(
        baseUrl.toString(),
        schemaName,
      );
      const migrationSql = postgres(scopedDatabaseUrl, {
        max: 1,
        onnotice: () => {},
      });
      try {
        const files = (await readdir(migrationsDirectory))
          .filter((file) => file.endsWith('.sql'))
          .sort();
        await migrationSql.begin(async (transaction) => {
          for (const file of files) {
            await transaction.unsafe(
              await readFile(new URL(file, migrationsDirectory), 'utf8'),
            );
          }
        });
      } finally {
        await migrationSql.end({ timeout: 5 });
      }
      process.env.DATABASE_URL = scopedDatabaseUrl;
    }, 120_000);

    afterAll(async () => {
      await closeDatabase();
      if (adminSql && schemaName) {
        await adminSql.unsafe(`drop schema if exists "${schemaName}" cascade`);
        await adminSql.end({ timeout: 5 });
      }
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }, 30_000);

    it('binds idempotent tool calls to the exact active worker lease', async () => {
      const scenario = await seedScenario();
      const input = taskInput(scenario, 'tool-call-1');
      const first = await createManagedBrowserTask(
        scenario.context,
        input,
        scenario.lease,
      );
      const replay = await createManagedBrowserTask(
        scenario.context,
        input,
        scenario.lease,
      );
      expect(replay.id).toBe(first.id);

      await expect(
        createManagedBrowserTask(scenario.context, input, {
          ...scenario.lease,
          leaseToken: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        createManagedBrowserTask(
          scenario.context,
          taskInput(scenario, 'tool-call-1', 'https://example.org'),
          scenario.lease,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        startManagedBrowserTask({
          context: {
            ...scenario.context,
            worker: { type: 'worker', id: randomUUID() },
          },
          taskId: first.id,
          lease: scenario.lease,
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('serializes target capacity and fails the excess task closed', async () => {
      const scenario = await seedScenario({ concurrencyLimit: 1 });
      const tasks = await Promise.all([
        createManagedBrowserTask(
          scenario.context,
          taskInput(scenario, 'capacity-1'),
          scenario.lease,
        ),
        createManagedBrowserTask(
          scenario.context,
          taskInput(scenario, 'capacity-2'),
          scenario.lease,
        ),
      ]);
      const starts = await Promise.allSettled(
        tasks.map((task) =>
          startManagedBrowserTask({
            context: scenario.context,
            taskId: task.id,
            lease: scenario.lease,
          }),
        ),
      );
      expect(
        starts.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        starts.find((result) => result.status === 'rejected'),
      ).toMatchObject({ reason: { code: 'BROWSER_TARGET_BUSY' } });
      const states = await Promise.all(tasks.map((task) => taskState(task.id)));
      expect(states.map((state) => state?.status).sort()).toEqual([
        'failed',
        'running',
      ]);
      expect(
        states.find((state) => state?.status === 'failed')?.error_code,
      ).toBe('BROWSER_TARGET_BUSY');
    });

    it('enforces the target hard deadline from task creation time', async () => {
      const scenario = await seedScenario({ timeoutSeconds: 1 });
      const task = await createManagedBrowserTask(
        scenario.context,
        taskInput(scenario, 'deadline'),
        scenario.lease,
      );
      const sql = getDatabase();
      await sql`
      update allrice_managed_browser_tasks
      set created_at = now() - interval '2 seconds'
      where id = ${task.id}
    `;
      await expect(
        startManagedBrowserTask({
          context: scenario.context,
          taskId: task.id,
          lease: scenario.lease,
        }),
      ).rejects.toMatchObject({ code: 'BROWSER_TARGET_TIMEOUT' });
      expect(await taskState(task.id)).toMatchObject({
        status: 'failed',
        error_code: 'BROWSER_TARGET_TIMEOUT',
      });
    });

    it('closes active tasks from the failed job attempt before retrying', async () => {
      const scenario = await seedScenario({ maxAttempts: 3 });
      const task = await createManagedBrowserTask(
        scenario.context,
        taskInput(scenario, 'retry'),
        scenario.lease,
      );
      await startManagedBrowserTask({
        context: scenario.context,
        taskId: task.id,
        lease: scenario.lease,
      });
      await failJob({
        workerId: scenario.ids.workerId,
        jobId: scenario.ids.jobId,
        leaseToken: scenario.lease.leaseToken,
        code: 'TRANSIENT_TEST_FAILURE',
        message: 'retry lifecycle test',
        retryable: true,
        retryBaseMs: 1,
      });
      expect(await taskState(task.id)).toMatchObject({
        status: 'failed',
        error_code: 'BROWSER_JOB_ATTEMPT_RETRY',
        job_attempt: 1,
      });
    });

    it('lets parent cancellation settle an active browser task as canceled', async () => {
      const scenario = await seedScenario();
      const task = await createManagedBrowserTask(
        scenario.context,
        taskInput(scenario, 'parent-cancel'),
        scenario.lease,
      );
      await startManagedBrowserTask({
        context: scenario.context,
        taskId: task.id,
        lease: scenario.lease,
      });
      const sql = getDatabase();
      await sql`
      update allrice_jobs
      set cancel_requested_at = now(), cancel_reason = 'integration_test'
      where id = ${scenario.ids.jobId}
    `;
      await completeJob({
        workerId: scenario.ids.workerId,
        jobId: scenario.ids.jobId,
        leaseToken: scenario.lease.leaseToken,
        result: { answer: 'must not win cancellation' },
      });
      expect(await taskState(task.id)).toMatchObject({
        status: 'canceled',
        error_code: 'BROWSER_PARENT_RUN_CANCELED',
      });
    });

    it('recovers an expired worker lease and only closes its exact attempt', async () => {
      const scenario = await seedScenario({ maxAttempts: 3 });
      const task = await createManagedBrowserTask(
        scenario.context,
        taskInput(scenario, 'lease-lost'),
        scenario.lease,
      );
      await startManagedBrowserTask({
        context: scenario.context,
        taskId: task.id,
        lease: scenario.lease,
      });
      const sql = getDatabase();
      const futureAttemptRows = await sql<{ id: string }[]>`
      insert into allrice_managed_browser_tasks (
        organization_id, workspace_id, run_id, job_id, job_attempt,
        tool_call_id, target_id, start_url, allowed_domains, steps
      ) values (
        ${scenario.ids.organizationId}, ${scenario.ids.workspaceId},
        ${scenario.ids.runId}, ${scenario.ids.jobId}, 2, 'future-attempt',
        ${scenario.ids.targetId}, 'https://example.com',
        ${sql.json(['example.com'])}, ${sql.json([])}
      ) returning id
    `;
      await sql`
      update allrice_jobs
      set lease_expires_at = now() - interval '1 second'
      where id = ${scenario.ids.jobId}
    `;
      const counts = await maintainQueue(100);
      expect(counts.recover_lease).toBeGreaterThanOrEqual(1);
      expect(await taskState(task.id)).toMatchObject({
        status: 'failed',
        error_code: 'BROWSER_WORKER_LEASE_LOST',
        job_attempt: 1,
      });
      expect(await taskState(futureAttemptRows[0]!.id)).toMatchObject({
        status: 'queued',
        error_code: null,
        job_attempt: 2,
      });
    });
  },
);
