import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveSandboxExecutionPolicy } from '@allrice/contracts';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import { createCloudProjectResolutionOperation } from './cloud-execution.ts';
import { publishProjectResolutionDiagnostics } from './project-resolution-diagnostics.ts';
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
const args = {
  action: 'resolve',
  manager: 'pnpm',
  packages: [{ name: 'is-number', version: '7.0.0' }],
};
const fixture = (
  extra: Parameters<typeof createCloudExecutionFixture>[2] = {},
) =>
  createCloudExecutionFixture(db, storageRoot, {
    projectResolution: true,
    sandboxExecutionPolicy: resolveSandboxExecutionPolicy([]),
    outboundCapability: true,
    sandboxNetwork: {
      version: 1,
      mode: 'controlled_https',
      origins: ['https://registry.npmjs.org'],
      allowInputTransfer: false,
    },
    ...extra,
  });
suite(
  'managed resolution authority: isolated DB, no external execution',
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
      vi.stubEnv('ALLRICE_SANDBOX_NETWORK_ENABLED', '1');
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

    const create = async (
      f: Awaited<ReturnType<typeof fixture>>,
      callId = 'resolve',
    ) =>
      createCloudProjectResolutionOperation(
        { context: f.execution, callId, arguments: args },
        db,
      );
    it('freezes the canonical request and ten-minute install budget without file transfer', async () => {
      const f = await fixture(),
        c = await create(f);
      expect(c.payload.origin).toMatchObject({
        toolName: 'workspace.project',
        request: args,
      });
      expect(c.payload.arguments.inputs).toEqual([]);
      expect(c.payload.executionBudget).toMatchObject({
        kind: 'install',
        initialBudgetMs: 120000,
        policy: { maxExecutionMs: 600000 },
      });
      expect(c.snapshot.binding.dataScope).toEqual([]);
      expect((await create(f)).snapshot.binding.attempt.operationId).toBe(
        c.snapshot.binding.attempt.operationId,
      );
      await expect(
        createCloudProjectResolutionOperation(
          {
            context: f.execution,
            callId: 'resolve',
            arguments: {
              ...args,
              packages: [{ name: 'is-number', version: '6.0.0' }],
            },
          },
          db,
        ),
      ).rejects.toThrow();
    });
    it('requires both the project tool and cloud/network authority frozen into this Run', async () => {
      for (const options of [
        { projectResolution: false },
        { outboundCapability: false },
        { sandboxNetwork: undefined },
      ]) {
        const f = await fixture(options);
        await expect(create(f)).rejects.toThrow();
        expect(
          await db`select id from allrice_runtime_operations where root_run_id=${f.run}`,
        ).toHaveLength(0);
      }
    });
    it('cannot widen origins or continue after the scoped cloud grant is revoked', async () => {
      const f = await fixture(),
        c = await create(f);
      await f.approve(c);
      await db`update allrice_cloud_execution_grants set enabled=false where id=${f.grant.id}`;
      await expect(
        c.ledger.dispatch({
          scope: c.snapshot.binding.task.scope,
          operationId: c.snapshot.binding.attempt.operationId,
          leaseOwner: f.worker,
          leaseMs: 15000,
        }),
      ).rejects.toThrow();
      await expect(create(f)).rejects.toThrow();
    });
    it('honors the actual local-only message at creation and again before dispatch/replay', async () => {
      const change = async (f: Awaited<ReturnType<typeof fixture>>) => {
        await db`update allrice_messages set content=${db.json({ text: '只在本地运行，禁止上传资料。', citations: [] })}
          where id=(select user_message_id from allrice_employee_runs where run_id=${f.run})`;
      };
      const f = await fixture();
      await change(f);
      await expect(create(f)).rejects.toThrow(
        'project_resolution_requires_cloud',
      );
      expect(
        await db`select id from allrice_runtime_operations where root_run_id=${f.run}`,
      ).toHaveLength(0);
      const g = await fixture(),
        c = await create(g);
      await g.approve(c);
      await change(g);
      await expect(
        c.ledger.dispatch({
          scope: c.snapshot.binding.task.scope,
          operationId: c.snapshot.binding.attempt.operationId,
          leaseOwner: g.worker,
          leaseMs: 15000,
        }),
      ).rejects.toThrow('project_resolution_requires_cloud');
      await expect(create(g)).rejects.toThrow(
        'project_resolution_requires_cloud',
      );
    });
    it('rejects forged success even after a real admission and persists a confirmed nonzero receipt', async () => {
      const f = await fixture(),
        c = await create(f);
      await f.approve(c);
      const scope = c.snapshot.binding.task.scope,
        attempt = c.snapshot.binding.attempt;
      const lease = await c.ledger.dispatch({
        scope,
        operationId: attempt.operationId,
        leaseOwner: f.worker,
        leaseMs: 15000,
      });
      const base = {
        scope,
        operationId: attempt.operationId,
        attempt,
        leaseToken: lease.leaseToken,
      };
      await c.ledger.startOperation({ ...base, receiptId: randomUUID() });
      const resolution = {
        version: 1,
        manager: 'pnpm',
        status: 'failed',
        phase: 'resolve',
        exitCode: 1,
        errorCode: 'PROJECT_RESOLUTION_PACKAGE_FAILED',
        diagnostics: 'No matching version',
      };
      const summary = {
        stopped: true,
        reason: 'failed',
        exitCode: 1,
        artifacts: [],
        resolution,
      };
      await db`update allrice_cloud_execution_attempts set outcome=${db.json({ ...summary, output: '', elapsedMs: 1, containerId: 'synthetic-no-container' })} where operation_id=${attempt.operationId}`;
      const evidence = {
        id: randomUUID(),
        recordedAt: new Date().toISOString(),
        digest: 'sha256:' + 'a'.repeat(64),
      };
      await expect(
        c.ledger.recordReceipt({
          ...base,
          receiptId: randomUUID(),
          signal: {
            type: 'operation.outcome',
            result: { status: 'succeeded', effects: 'none', evidence },
          },
          evidence: summary,
        }),
      ).rejects.toThrow('cloud_resolution_receipt_changed');
      await expect(
        c.ledger.recordReceipt({
          ...base,
          receiptId: randomUUID(),
          signal: {
            type: 'operation.outcome',
            result: { status: 'failed', effects: 'none', evidence },
          },
          evidence: { ...summary, exitCode: 0 },
        }),
      ).rejects.toThrow('cloud_resolution_receipt_changed');
      await c.ledger.recordReceipt({
        ...base,
        receiptId: randomUUID(),
        signal: {
          type: 'operation.outcome',
          result: { status: 'failed', effects: 'none', evidence },
        },
        evidence: summary,
      });
      expect(
        (await c.ledger.readOperation(scope, attempt.operationId)).status,
      ).toBe('failed');
      const publish = () =>
        publishProjectResolutionDiagnostics(
          {
            context: f.execution,
            sessionId: f.session,
            operationId: attempt.operationId,
          },
          f.storage,
          db,
        );
      await expect(publish()).rejects.toThrow(
        'cloud_resolution_diagnostics_unavailable',
      );
      await db`update allrice_cloud_execution_attempts set cleanup_confirmed_at=clock_timestamp() where operation_id=${attempt.operationId}`;
      const diagnostic = await publish();
      expect(diagnostic.fileName).toBe('依赖准备失败诊断.json');
      expect((await publish()).objectId).toBe(diagnostic.objectId);
      const foreign = await fixture();
      await expect(
        publishProjectResolutionDiagnostics(
          {
            context: foreign.execution,
            sessionId: foreign.session,
            operationId: attempt.operationId,
          },
          foreign.storage,
          db,
        ),
      ).rejects.toThrow('cloud_resolution_diagnostics_unavailable');
      await db`update allrice_cloud_execution_grants set enabled=false where id=${f.grant.id}`;
      await expect(publish()).rejects.toThrow();
    });
  },
);
