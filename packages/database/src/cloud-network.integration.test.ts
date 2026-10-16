import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RuntimePolicyError } from './runtime-policy.ts';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import type * as Client from './core/client.ts';
import { CloudRunnerBackend } from '../../../apps/worker/src/cloud-runner/backend.js';
import { runCloudCommandOperation } from '../../../apps/worker/src/cloud-runner/executor.js';
let db: ReturnType<typeof postgres>,
  admin: ReturnType<typeof postgres>,
  storageRoot: string;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => db,
}));
// Authority/lifecycle tests use a deterministic reputation port; the checker
// itself has separate real-DNS acceptance and refusal/cache regressions.
const admission = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./sandbox-network-admission.ts', () => ({
  assertAutomaticSandboxNetwork: admission,
}));
const schema = `cloud_network_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const network = {
  mode: 'controlled_https' as const,
  origins: ['https://registry.npmjs.org'],
};
const fixture = (
  options: Parameters<typeof createCloudExecutionFixture>[2] = {},
) =>
  createCloudExecutionFixture(db, storageRoot, {
    outboundCapability: true,
    sandboxNetwork: { ...network, version: 1, allowInputTransfer: true },
    ...options,
  });
suite(
  'controlled cloud network authority: isolated PostgreSQL, no external execution',
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
      vi.stubEnv('ALLRICE_SANDBOX_NETWORK_ENABLED', '1');
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
      storageRoot = await mkdtemp(join(tmpdir(), 'allrice-network-test-'));
    }, 60000);
    afterAll(async () => {
      await db?.end();
      if (admin) {
        if (!/^cloud_network_[a-f0-9]{32}$/.test(schema))
          throw Error('test schema');
        await admin.unsafe(`drop schema ${schema} cascade`);
        await admin.end();
      }
      if (storageRoot?.includes('/allrice-network-test-'))
        await rm(storageRoot, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });
    it('freezes an exact external transfer and rechecks grant revocation on dispatch', async () => {
      const f = await fixture(),
        c = await f.create('network', { ...f.args, network });
      expect(c.payload.network).toEqual(network);
      expect(c.snapshot.binding.dataScope.map((s) => s.destination)).toEqual([
        'cloud_execution',
        'external_service',
      ]);
      expect(c.snapshot.binding.dataScope[1]).toMatchObject({
        externalNetwork: network,
        authorizationId: f.grant.id,
        content: c.snapshot.binding.baseline[0],
      });
      await f.approve(c);
      await db`update allrice_cloud_execution_grants set revoked_at=clock_timestamp() where id=${f.grant.id}`;
      await expect(
        c.ledger.dispatch({
          scope: c.snapshot.binding.task.scope,
          operationId: c.snapshot.binding.attempt.operationId,
          leaseOwner: f.worker,
          leaseMs: 15000,
        }),
      ).rejects.toThrow('cloud_grant_unavailable');
    });
    it('does not turn a read grant into an external transfer grant or borrow other owners grants', async () => {
      const f = await fixture({
        sandboxNetwork: { ...network, version: 1, allowInputTransfer: false },
      });
      await expect(
        f.create('transfer', { ...f.args, network }),
      ).rejects.toThrow('sandbox_network_transfer_not_authorized');
      const c = await f.create('no-input', { ...f.args, inputs: [], network });
      expect(c.snapshot.binding.dataScope).toEqual([]);
      const other = await fixture({ sandboxNetwork: undefined });
      const automatic = await other.create('automatic-no-settings', {
        ...other.args,
        network,
      });
      expect(automatic.payload.network).toEqual(network);
      expect(automatic.snapshot.binding.dataScope[1]).toMatchObject({
        destination: 'external_service',
        externalNetwork: network,
      });
      admission.mockRejectedValueOnce(
        new RuntimePolicyError('sandbox_network_destination_blocked'),
      );
      await expect(
        other.create('blocked', { ...other.args, network }),
      ).rejects.toThrow('sandbox_network_destination_blocked');
      await expect(
        f.create('other-file', {
          ...f.args,
          network,
          inputs: [{ ...f.args.inputs[0], objectId: other.object.id }],
        }),
      ).rejects.toThrow();
    });
    it('requires frozen outbound capability and exact allowed origins; disabling feature fences existing approval', async () => {
      const denied = await fixture({ outboundCapability: false });
      await expect(
        denied.create('no-capability', { ...denied.args, network }),
      ).rejects.toThrow('sandbox_network_not_authorized');
      const f = await fixture();
      await expect(
        f.create('other-origin', {
          ...f.args,
          network: { ...network, origins: ['https://example.com'] },
        }),
      ).rejects.toThrow('sandbox_network_not_authorized');
      const c = await f.create('shutdown', { ...f.args, network });
      await f.approve(c);
      vi.stubEnv('ALLRICE_SANDBOX_NETWORK_ENABLED', '0');
      try {
        await expect(
          c.ledger.dispatch({
            scope: c.snapshot.binding.task.scope,
            operationId: c.snapshot.binding.attempt.operationId,
            leaseOwner: f.worker,
            leaseMs: 15000,
          }),
        ).rejects.toThrow('sandbox_network_not_authorized');
        const offline = await f.create('still-offline');
        expect(offline.payload.network).toBe('none');
        expect(offline.snapshot.binding.dataScope).toHaveLength(1);
      } finally {
        vi.stubEnv('ALLRICE_SANDBOX_NETWORK_ENABLED', '1');
      }
    });
    it('preserves uncertain external effects, cleans the stopped attempt, and never settles or replays it', async () => {
      const f = await fixture(),
        c = await f.create('interrupted-network', {
          ...f.args,
          inputs: [],
          network,
        });
      await f.approve(c);
      const backend = new CloudRunnerBackend();
      const execute = vi.spyOn(backend, 'execute').mockResolvedValue({
        containerId: 'a'.repeat(64),
        exitCode: 137,
        stopped: true,
        reason: 'canceled',
        output: '',
        artifacts: [],
        elapsedMs: 37246,
        imageDigest: c.payload.imageDigest,
        errorCode: 'SANDBOX_NETWORK_REVOKED',
        network: { sentBytes: 120, receivedBytes: 1000, openedConnections: 1 },
      });
      const cleanup = vi.spyOn(backend, 'cleanup').mockResolvedValue();
      const options = { storage: f.storage, database: db, backend };
      const first = await runCloudCommandOperation(c, options);
      expect(first).toMatchObject({
        status: 'unknown',
        stopped: true,
        cleanupConfirmed: true,
        externalOutcomeUnknown: true,
        errorCode: 'SANDBOX_NETWORK_REVOKED',
      });
      const id = c.snapshot.binding.attempt.operationId;
      const [attempt] =
        await db`select cleanup_confirmed_at from allrice_cloud_execution_attempts where operation_id=${id}`;
      expect(attempt!.cleanup_confirmed_at).toBeTruthy();
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(await runCloudCommandOperation(c, options)).toMatchObject(first);
      expect(execute).toHaveBeenCalledTimes(1);
      const [usage] =
        await db`select observation,settled_amount from allrice_runtime_reservations where operation_id=${id} and metric='tool_calls'`;
      expect(usage).toMatchObject({ observation: null, settled_amount: null });
    });
    it('shares concurrent lease checks but rechecks a revoked grant after the exchange completes', async () => {
      const f = await fixture(),
        c = await f.create('network-heartbeats', {
          ...f.args,
          inputs: [],
          network,
        });
      await f.approve(c);
      const heartbeat = vi.spyOn(c.ledger, 'heartbeat');
      const backend = new CloudRunnerBackend();
      vi.spyOn(backend, 'cleanup').mockResolvedValue();
      vi.spyOn(backend, 'execute').mockImplementation(
        async (command, _files, options) => {
          expect(
            await Promise.all(
              Array.from({ length: 12 }, () => options.maintainLease()),
            ),
          ).toEqual(Array(12).fill(true));
          expect(heartbeat).toHaveBeenCalledTimes(1);
          await db`update allrice_cloud_execution_grants set revoked_at=clock_timestamp() where id=${f.grant.id}`;
          expect(await options.maintainLease()).toBe(false);
          expect(heartbeat).toHaveBeenCalledTimes(2);
          return {
            containerId: 'b'.repeat(64),
            exitCode: 137,
            stopped: true,
            reason: 'canceled',
            output: '',
            artifacts: [],
            elapsedMs: 20,
            imageDigest: command.imageDigest,
            network: {
              sentBytes: 120,
              receivedBytes: 1000,
              openedConnections: 1,
            },
          };
        },
      );
      expect(
        await runCloudCommandOperation(c, {
          storage: f.storage,
          database: db,
          backend,
        }),
      ).toMatchObject({ status: 'unknown', cleanupConfirmed: true });
    });
  },
);
