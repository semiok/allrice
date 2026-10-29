import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import type * as Client from './core/client.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
type Fixture = Awaited<ReturnType<typeof createCloudExecutionFixture>>;
let isolated: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => isolated.db,
}));

// Hold the policy row first, as recordManagedCloudEnvironment does. Wait for
// admission to actually block on that row before updating its execution target.
// A target-first admission creates a real PostgreSQL deadlock at this point.
async function duringHealthRefresh<T>(
  f: Fixture,
  action: () => Promise<T>,
  state: 'online' | 'revoked' = 'online',
) {
  const db = isolated.db;
  let pending:
    | Promise<{ value: T; error?: never } | { error: unknown; value?: never }>
    | undefined;
  try {
    await db.begin(async (tx) => {
      await tx`set local statement_timeout='10s'`;
      const [health] = await tx<{ pid: number }[]>`select pg_backend_pid() pid`;
      await tx`select version from allrice_runtime_policy_controls
        where organization_id=${f.org} and workspace_id=${f.workspace} for update`;
      pending = action().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await expect
        .poll(
          async () => {
            const [row] = await db<{ blocked: boolean }[]>`
              select exists(select 1 from pg_stat_activity
                where datname=current_database()
                and ${health!.pid}=any(pg_blocking_pids(pid))) blocked`;
            return row!.blocked;
          },
          { timeout: 5000, interval: 10 },
        )
        .toBe(true);
      await tx`update allrice_execution_targets
        set state=${state},last_heartbeat_at=clock_timestamp()
        where id=${f.target} and organization_id=${f.org} and workspace_id=${f.workspace}`;
    });
    const result = await pending!;
    if ('error' in result) throw result.error;
    return result.value;
  } finally {
    // Always finish our own admission after the health transaction rolls back
    // or commits, including the regression's pre-fix deadlock failure.
    await pending;
  }
}

suite('cloud policy and health refresh lock ordering', () => {
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
    isolated = await createRuntimeFixtureDatabase();
  }, 60000);
  afterAll(async () => {
    await isolated?.close();
    vi.unstubAllEnvs();
  });

  it.each(['create', 'dispatch', 'start', 'heartbeat'] as const)(
    '%s proceeds after a concurrent target health refresh',
    async (phase) => {
      const f = await createCloudExecutionFixture(
        isolated.db,
        isolated.storageRoot,
      );
      if (phase === 'create') {
        const created = await duringHealthRefresh(f, () => f.create());
        expect(created!.snapshot.status).toBe('waiting_user');
        return;
      }
      const created = await f.create();
      await f.approve(created);
      const scope = created.snapshot.binding.task.scope;
      const operationId = created.snapshot.binding.attempt.operationId;
      const dispatch = () =>
        created.ledger.dispatch({
          scope,
          operationId,
          leaseOwner: f.worker,
          leaseMs: 60000,
        });
      if (phase === 'dispatch') {
        expect((await duringHealthRefresh(f, dispatch))!.snapshot.status).toBe(
          'dispatched',
        );
        return;
      }
      const lease = await dispatch();
      const identity = { scope, operationId, leaseToken: lease.leaseToken };
      const start = () =>
        created.ledger.startOperation({
          ...identity,
          attempt: lease.snapshot.binding.attempt,
          receiptId: randomUUID(),
        });
      if (phase === 'start') await duringHealthRefresh(f, start);
      else {
        await start();
        await duringHealthRefresh(f, () =>
          created.ledger.heartbeat({ ...identity, leaseMs: 60000 }),
        );
      }
      expect(
        (await created.ledger.readOperation(scope, operationId)).status,
      ).toBe('running');
    },
    15000,
  );

  it('rejects authority withdrawn while a heartbeat waits, without extending its lease', async () => {
    const f = await createCloudExecutionFixture(
      isolated.db,
      isolated.storageRoot,
    );
    const created = await f.create();
    await f.approve(created);
    const scope = created.snapshot.binding.task.scope;
    const operationId = created.snapshot.binding.attempt.operationId;
    const lease = await created.ledger.dispatch({
      scope,
      operationId,
      leaseOwner: f.worker,
      leaseMs: 60000,
    });
    await expect(
      duringHealthRefresh(
        f,
        () =>
          created.ledger.heartbeat({
            scope,
            operationId,
            leaseToken: lease.leaseToken,
            leaseMs: 60000,
          }),
        'revoked',
      ),
    ).rejects.toThrow('target_unavailable');
    const [row] = await isolated.db<{ lease_expires_at: Date }[]>`
      select lease_expires_at from allrice_runtime_operations where id=${operationId}`;
    expect(row!.lease_expires_at.toISOString()).toBe(lease.leaseExpiresAt);
  }, 15000);
});
