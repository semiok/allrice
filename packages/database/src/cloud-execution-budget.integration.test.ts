import {
  resolveSandboxExecutionPolicy,
  type SandboxExecutionBudgetState,
} from '@allrice/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import type * as Client from './core/client.ts';
let db: ReturnType<typeof postgres>,
  admin: ReturnType<typeof postgres>,
  storageRoot: string;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => db,
}));
const schema = `cloud_budget_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const fixture = (
  options: Parameters<typeof createCloudExecutionFixture>[2] = {},
) =>
  createCloudExecutionFixture(db, storageRoot, {
    sandboxExecutionPolicy: resolveSandboxExecutionPolicy([]),
    ...options,
  });
const execution = { version: 1 as const, kind: 'compute' as const };
const start = async () => {
  const f = await fixture(),
    c = await f.create('budget', { ...f.args, execution });
  await f.approve(c);
  const scope = c.snapshot.binding.task.scope,
    attempt = c.snapshot.binding.attempt;
  const lease = await c.ledger.dispatch({
    scope,
    operationId: attempt.operationId,
    leaseOwner: f.worker,
    leaseMs: 15000,
  });
  const receipt = {
    scope,
    operationId: attempt.operationId,
    attempt,
    leaseToken: lease.leaseToken,
  };
  await c.ledger.startOperation({ ...receipt, receiptId: randomUUID() });
  return {
    f,
    c,
    receipt,
    exchange: (
      renewal?: Parameters<
        typeof c.ledger.exchangeSandboxExecutionBudget
      >[0]['renewal'],
    ) => c.ledger.exchangeSandboxExecutionBudget({ ...receipt, renewal }),
  };
};
suite(
  'renewable sandbox execution: isolated PostgreSQL, no external execution',
  () => {
    beforeAll(async () => {
      const source = process.env.ALLRICE_TEST_DATABASE_URL;
      if (!source) throw Error('dedicated test DB required');
      const url = new URL(source);
      if (!(
        url.hostname === '127.0.0.1' &&
        ((url.port === '5432' &&
          url.username === 'a123' &&
          ['/allrice_b1', '/allrice_b2'].includes(url.pathname)) ||
          (url.port === '54329' &&
            url.username === 'allrice' &&
            url.pathname === '/allrice'))
      ))
        throw Error('disposable database required');
      vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '1');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      vi.stubEnv('ALLRICE_SANDBOX_EXECUTION_V1_ENABLED', '1');
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
      admin = postgres(source, { max: 2, onnotice: () => {} });
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(20260907,1)`;
        await tx`create extension if not exists vector with schema public`;
        await tx`create extension if not exists pg_trgm with schema public`;
      });
      await admin.unsafe(`create schema ${schema}`);
      url.searchParams.set('options', `-csearch_path=${schema},public`);
      db = postgres(url.toString(), { max: 5, onnotice: () => {} });
      const directory = new URL('../migrations/', import.meta.url);
      for (const file of (await readdir(directory))
        .filter((f) => f.endsWith('.sql'))
        .sort())
        await db.unsafe(await readFile(new URL(file, directory), 'utf8'));
      storageRoot = await mkdtemp(join(tmpdir(), 'allrice-budget-test-'));
    }, 60000);
    afterAll(async () => {
      await db?.end();
      if (admin) {
        if (!/^cloud_budget_[a-f0-9]{32}$/.test(schema))
          throw Error('test schema');
        await admin.unsafe(`drop schema ${schema} cascade`);
        await admin.end();
      }
      if (storageRoot?.includes('/allrice-budget-test-'))
        await rm(storageRoot, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });
    it('binds the server-frozen cap and excludes waiting from the start clock', async () => {
      const { f, c, receipt, exchange } = await start();
      expect(c.payload.executionBudget?.policy.maxExecutionMs).toBe(600000);
      const [queued] =
        await db`select execution_budget from allrice_runtime_operations where id=${receipt.operationId}`;
      expect(queued!.execution_budget).toBeNull();
      const states = await Promise.all([exchange(), exchange()]);
      expect(states[0]).toEqual(states[1]);
      expect(states[0]!.deadlineAt - states[0]!.startedAt).toBe(60000);
      expect(states[0]!.hardDeadlineAt).toBe(Date.parse(c.deadlineAt));
      expect(states[0]!.hardDeadlineAt - states[0]!.startedAt).toBeLessThan(
        600000,
      );
      expect(await exchange()).toEqual(states[0]);
      // A different new Run policy never rewrites the existing operation clock.
      await fixture({
        sandboxExecutionPolicy: resolveSandboxExecutionPolicy([
          {
            scope: 'tenant',
            scopeId: randomUUID(),
            source: 'tenant_override',
            maxExecutionMs: 1800000,
          },
        ]),
      });
      expect(await exchange()).toEqual(states[0]);
      await expect(
        c.ledger.exchangeSandboxExecutionBudget({
          ...receipt,
          leaseToken: randomUUID(),
        }),
      ).rejects.toThrow('lease_lost');
      await expect(
        c.ledger.exchangeSandboxExecutionBudget({
          ...receipt,
          attempt: { ...receipt.attempt, attemptId: randomUUID() },
        }),
      ).rejects.toThrow('lease_lost');
      await expect(
        c.ledger.exchangeSandboxExecutionBudget({
          ...receipt,
          scope: { ...receipt.scope, workspaceId: randomUUID() },
        }),
      ).rejects.toThrow();
      expect(
        (
          await db`select id from allrice_runtime_operations where root_run_id=${f.run}`
        ).length,
      ).toBe(1);
    });
    it('does not replace an explicit renewable budget with the ordinary deployment timeout', async () => {
      const timeout = process.env.ALLRICE_CLOUD_COMMAND_TIMEOUT_MS;
      vi.stubEnv('ALLRICE_CLOUD_COMMAND_TIMEOUT_MS', '500');
      try {
        const { c, exchange } = await start();
        expect(c.payload.arguments.limits.timeoutMs).toBe(500);
        expect(c.payload.executionBudget?.policy.maxExecutionMs).toBe(600000);
        const state = await exchange();
        expect(state!.deadlineAt - state!.startedAt).toBe(60000);
      } finally {
        vi.stubEnv('ALLRICE_CLOUD_COMMAND_TIMEOUT_MS', timeout);
      }
    });
    it('serializes retries without extending twice and rejects revoked or expired authority', async () => {
      const { f, receipt, c, exchange } = await start();
      const initial = await exchange();
      // Advance only this disposable fixture clock; the authority clock remains PostgreSQL.
      const state: SandboxExecutionBudgetState = {
        ...initial,
        startedAt: initial.startedAt - 50000,
        lastProgressAt: initial.lastProgressAt - 50000,
        deadlineAt: initial.deadlineAt - 50000,
        hardDeadlineAt: initial.hardDeadlineAt - 50000,
      };
      await db`update allrice_runtime_operations set execution_budget=${db.json(state)} where id=${receipt.operationId}`;
      const renewal = {
        requestId: randomUUID(),
        sequence: 1,
        progress: { cpuNanos: 1000000, readBytes: 0, writtenBytes: 0 },
      };
      const results = await Promise.all([exchange(renewal), exchange(renewal)]);
      expect(results[0]).toEqual(results[1]);
      expect(results[0]!.renewals).toHaveLength(1);
      expect(results[0]!.startedAt).toBe(state.startedAt);
      expect(results[0]!.deadlineAt).toBe(state.deadlineAt + 60000);
      await expect(
        exchange({
          ...renewal,
          progress: { ...renewal.progress, readBytes: 1 },
        }),
      ).rejects.toThrow('CONFLICT');
      await expect(
        exchange({ ...renewal, requestId: randomUUID(), sequence: 2 }),
      ).rejects.toThrow('EARLY');
      await db`update allrice_cloud_execution_grants set revoked_at=clock_timestamp() where id=${f.grant.id}`;
      await expect(exchange()).rejects.toThrow('cloud_grant_unavailable');
      const [saved] =
        await db`select execution_budget from allrice_runtime_operations where id=${receipt.operationId}`;
      expect(saved!.execution_budget).toEqual(results[0]);
      const other = await start();
      await other.exchange();
      await db`update allrice_runtime_operations set lease_expires_at=clock_timestamp()-interval '1 second' where id=${other.receipt.operationId}`;
      await expect(other.exchange()).rejects.toThrow('lease_lost');
      expect(c.snapshot.binding.command?.budgetDigest).toBeTruthy();
    });
    it('never revives an expired budget or renews canceled work', async () => {
      const expired = await start(),
        state = await expired.exchange();
      await db`update allrice_runtime_operations set execution_budget=${db.json(
        {
          ...state,
          startedAt: state.startedAt - 61000,
          lastProgressAt: state.lastProgressAt - 61000,
          deadlineAt: state.deadlineAt - 61000,
          hardDeadlineAt: state.hardDeadlineAt - 61000,
        },
      )} where id=${expired.receipt.operationId}`;
      await expect(expired.exchange()).rejects.toThrow(
        'SANDBOX_EXECUTION_DEADLINE',
      );
      const canceled = await start();
      await canceled.exchange();
      await canceled.c.ledger.cancelRoot(
        canceled.receipt.scope,
        canceled.f.run,
        randomUUID(),
      );
      await expect(canceled.exchange()).rejects.toThrow();
      const [row] =
        await db`select snapshot,execution_budget from allrice_runtime_operations where id=${canceled.receipt.operationId}`;
      expect(row!.snapshot.status).toBe('cancel_requested');
      expect(row!.execution_budget.sequence).toBe(0);
    });
    it('refuses legacy upgrades and a disabled feature, including already approved work', async () => {
      const old = await createCloudExecutionFixture(db, storageRoot);
      await expect(
        old.create('unsupported', { ...old.args, execution }),
      ).rejects.toThrow('sandbox_execution_upgrade_required');
      const f = await fixture(),
        c = await f.create('before-disable', { ...f.args, execution });
      await f.approve(c);
      vi.stubEnv('ALLRICE_SANDBOX_EXECUTION_V1_ENABLED', '0');
      try {
        await expect(
          f.create('disabled', { ...f.args, execution }),
        ).rejects.toThrow('sandbox_execution_not_enabled');
        await expect(
          c.ledger.dispatch({
            scope: c.snapshot.binding.task.scope,
            operationId: c.snapshot.binding.attempt.operationId,
            leaseOwner: f.worker,
            leaseMs: 15000,
          }),
        ).rejects.toThrow('sandbox_execution_not_enabled');
        const legacy = await old.create('offline-original');
        expect(legacy.payload.executionBudget).toBeUndefined();
      } finally {
        vi.stubEnv('ALLRICE_SANDBOX_EXECUTION_V1_ENABLED', '1');
      }
    });
  },
);
