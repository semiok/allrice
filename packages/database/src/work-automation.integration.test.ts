import type * as DatabaseClient from './core/client.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import { getWorkAutomation, updateWorkAutomation } from './work-automation.ts';
import { setRuntimePolicyControls } from './runtime-policy.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
let storageRoot: string;
let fixtureDb: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof DatabaseClient>()),
  getDatabase: () => fixtureDb.db,
}));
suite('MET-159 member work settings and actual cloud admission', () => {
  beforeAll(async () => {
    fixtureDb = await createAssistantFixtureDatabase();
    storageRoot = await mkdtemp(join(tmpdir(), 'allrice-auto-work-'));
    vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
  }, 60000);
  afterAll(async () => {
    await fixtureDb?.close();
    await rm(storageRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  async function fresh() {
    const f = await createCloudExecutionFixture(fixtureDb.db, storageRoot);
    // Existing cloud approval fixtures explicitly choose manual mode. Remove
    // that synthetic preference to exercise the actual missing-row default.
    await fixtureDb.db`delete from allrice_member_work_automation where organization_id=${f.org}`;
    await fixtureDb.db`update allrice_memberships set role='member' where organization_id=${f.org}`;
    return f;
  }
  it('defaults ON for ordinary members, persists without admin, isolates users and rejects stale writes', async () => {
    const f = await fresh(),
      other = await fresh(),
      db = fixtureDb.db;
    expect(await getWorkAutomation(f.context, f.workspace, db)).toMatchObject({
      revision: 0,
      editable: true,
      settings: { cloud: true, computer: true, assistants: true },
    });
    const attempts = await Promise.allSettled(
      ['cloud', 'computer'].map((capability) =>
        updateWorkAutomation(
          f.context,
          f.workspace,
          { expectedRevision: 0, capability, enabled: false },
          db,
        ),
      ),
    );
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((a) => a.status === 'rejected')).toHaveLength(1);
    expect((await getWorkAutomation(f.context, f.workspace, db)).revision).toBe(
      1,
    );
    expect(
      (await getWorkAutomation(other.context, other.workspace, db)).revision,
    ).toBe(0);
    await expect(
      getWorkAutomation(f.context, other.workspace, db),
    ).rejects.toThrow('authorization_denied');
    await expect(
      updateWorkAutomation(
        f.context,
        f.workspace,
        {
          expectedRevision: 1,
          capability: 'cloud',
          enabled: true,
          userId: other.user,
        },
        db,
      ),
    ).rejects.toThrow();
    await db`update allrice_memberships set role='viewer' where organization_id=${f.org}`;
    expect((await getWorkAutomation(f.context, f.workspace, db)).editable).toBe(
      false,
    );
    await expect(
      updateWorkAutomation(
        f.context,
        f.workspace,
        { expectedRevision: 1, capability: 'cloud', enabled: true },
        db,
      ),
    ).rejects.toThrow('authorization_denied');
    await db`update allrice_memberships set active=false where organization_id=${f.org}`;
    await expect(getWorkAutomation(f.context, f.workspace, db)).rejects.toThrow(
      'authorization_denied',
    );
  });
  it('dispatches without a human approval by default, records the choice, and does not replay', async () => {
    const f = await fresh(),
      db = fixtureDb.db,
      c = await f.create();
    expect(c.snapshot.status).toBe('ready');
    const operationId = c.snapshot.binding.attempt.operationId;
    const [record] =
      await db`select member_automation from allrice_runtime_operations where id=${operationId}`;
    expect(record!.member_automation).toMatchObject({
      revision: 0,
      settings: { cloud: true },
    });
    expect(
      await db`select id from allrice_approval_requests where resource_id=${operationId}`,
    ).toHaveLength(0);
    expect(
      await db`select id from allrice_audit_events where resource_id=${operationId} and action='runtime.confirmation.recorded'`,
    ).toHaveLength(1);
    await expect(
      db`update allrice_runtime_operations set member_automation=null where id=${operationId}`,
    ).rejects.toThrow('immutable');
    await updateWorkAutomation(
      f.context,
      f.workspace,
      { expectedRevision: 0, capability: 'cloud', enabled: false },
      db,
    );
    const dispatch = {
      scope: c.snapshot.binding.task.scope,
      operationId,
      leaseOwner: f.worker,
      leaseMs: 15000,
    };
    const lease = await c.ledger.dispatch(dispatch);
    expect(lease.snapshot.status).toBe('dispatched');
    await expect(c.ledger.dispatch(dispatch)).rejects.toThrow();
    expect((await f.create()).snapshot.binding.attempt.operationId).toBe(
      operationId,
    );
    const manual = await f.create('manual-new');
    expect(manual.snapshot.status).toBe('waiting_user');
  });
  it('does not retroactively approve pending actions when automatic work is enabled', async () => {
    const f = await fresh(),
      db = fixtureDb.db;
    await updateWorkAutomation(
      f.context,
      f.workspace,
      { expectedRevision: 0, capability: 'cloud', enabled: false },
      db,
    );
    const c = await f.create();
    expect(c.snapshot.status).toBe('waiting_user');
    await updateWorkAutomation(
      f.context,
      f.workspace,
      { expectedRevision: 1, capability: 'cloud', enabled: true },
      db,
    );
    const dispatch = {
      scope: c.snapshot.binding.task.scope,
      operationId: c.snapshot.binding.attempt.operationId,
      leaseOwner: f.worker,
      leaseMs: 15000,
    };
    await expect(c.ledger.dispatch(dispatch)).rejects.toThrow();
    expect((await f.create()).snapshot.status).toBe('waiting_user');
    expect((await f.create('new-auto')).snapshot.status).toBe('ready');
    await f.approve(c);
    expect((await c.ledger.dispatch(dispatch)).snapshot.status).toBe(
      'dispatched',
    );
  });
  it('retains current grant and employee boundaries even with all switches on', async () => {
    const f = await fresh(),
      db = fixtureDb.db,
      c = await f.create();
    await db`update allrice_cloud_execution_grants set revoked_at=clock_timestamp() where id=${f.grant.id}`;
    await expect(
      c.ledger.dispatch({
        scope: c.snapshot.binding.task.scope,
        operationId: c.snapshot.binding.attempt.operationId,
        leaseOwner: f.worker,
        leaseMs: 15000,
      }),
    ).rejects.toThrow('cloud_grant_unavailable');
    const g = await fresh();
    await db`update allrice_memberships set role='admin' where organization_id=${g.org}`;
    await setRuntimePolicyControls(
      g.context,
      {
        version: 2,
        enabled: true,
        mode: 'execute',
        rules: [{ action: 'cloud.process.execute', effect: 'deny' }],
      },
      1,
      db,
    );
    await expect(g.create(randomUUID())).rejects.toThrow('tenant_deny');
  });
});
