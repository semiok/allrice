import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPlatformQualityNativeFixture } from './platform-quality-native.fixture.ts';
import { updatePlatformQualitySchedule } from './platform-quality-automation.ts';
import { lockPlatformQualityNativeAdmission } from './platform-quality-native.ts';
import { initializeNativeRecurringPartition } from './native-schedule-recurring-product.ts';
import {
  NativeRecurringControlSchema,
  type NativeRecurringControl,
} from './native-schedule-recurring-state.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

function signal<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function backendPid(tx: TransactionSql) {
  const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() pid`;
  return row!.pid;
}

async function blockedBy(
  observer: TransactionSql,
  waitingPid: number,
  blockerPid: number,
) {
  // Observe the exact two backends, rather than infer blocking from a sleep.
  await expect
    .poll(
      async () => {
        const [row] = await observer<
          { blocked: boolean }[]
        >`select ${blockerPid}::integer=any(pg_blocking_pids(${waitingPid}::integer)) blocked`;
        return row!.blocked;
      },
      { timeout: 2000, interval: 10 },
    )
    .toBe(true);
}

async function completeBoth(work: readonly Promise<unknown>[]) {
  // Do not drop the fixture while the other backend is still rolling back.
  const results = await Promise.allSettled(work);
  for (const result of results)
    if (result.status === 'rejected') throw result.reason;
}

suite('quality native owner locks — isolated two-backend PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof createPlatformQualityNativeFixture>>;
  let control: NativeRecurringControl, deploymentId: string, targetId: string;

  beforeAll(async () => {
    f = await createPlatformQualityNativeFixture();
    const reference = {
      artifactId: `sha256:${'b'.repeat(64)}`,
      profileId: 'allrice-recurring-control-v1',
      storageId: 'quality-owner-lock-sql-fixture',
      stateRoot: await realpath(f.storageRoot),
    };
    vi.stubEnv('ALLRICE_NATIVE_RECURRING_REFERENCE', JSON.stringify(reference));
    await initializeNativeRecurringPartition(reference);
    const view = await updatePlatformQualitySchedule(f.admin, {
      expectedRevision: 0,
      enabled: true,
      time: '09:00',
    });
    const [stored] = await f.db<
      { snapshot: { control: unknown } }[]
    >`select snapshot from allrice_native_recurring_controls where automation_id=${view.schedule!.id}`;
    control = NativeRecurringControlSchema.parse(stored!.snapshot.control);
    expect(control.dispatch).toEqual({ consumer: 'platform-quality-v1' });
    const [deployment] = await f.db<{ id: string }[]>`
      select pa.id from allrice_platform_quality_deployments d
      join allrice_employee_assignments a on a.id=d.assignment_id
      join allrice_platform_employee_tenant_assignments pa on pa.tenant_employee_id=a.employee_id
        and pa.organization_id=d.organization_id and pa.workspace_id=d.workspace_id
      where d.owner_id=${control.ownerId} and d.workspace_id=${control.workspaceId}`;
    expect(deployment).toBeDefined();
    deploymentId = deployment!.id;

    // This disabled SQL-only target/grant never authorizes a runner or model.
    // The regression concerns the real owner FK, not a synthetic lock-table.
    targetId = randomUUID();
    await f.db`insert into allrice_execution_targets
      (id,organization_id,workspace_id,target_key,kind,label,state,capabilities)
      values(${targetId},${control.organizationId},${control.workspaceId},
        ${`quality-owner-fk-${randomUUID()}`},'cloud_sandbox','Owner FK lock fixture','offline','[]')`;
  }, 120_000);

  afterAll(async () => {
    try {
      await f?.close();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it('the original preparation pa lock can insert an owner FK while native admission waits for pa', async () => {
    const preparationReady = signal<number>(),
      nativeStarted = signal<number>();
    const grantId = randomUUID();
    const preparation = f.db
      .begin(async (tx) => {
        await tx`set local lock_timeout='5s'`;
        await tx`set local statement_timeout='10s'`;
        const pid = await backendPid(tx);
        // Exact existing ensureQualityEmployee boundary: its deployment row is
        // locked before synchronizeTenantEmployeeAccess prepares new grants.
        await tx`select id from allrice_platform_employee_tenant_assignments where id=${deploymentId} for update`;
        preparationReady.resolve(pid);
        const nativePid = await nativeStarted.promise;
        expect(nativePid).not.toBe(pid);
        await blockedBy(tx, nativePid, pid);

        // Actual allrice_cloud_execution_grants.owner_id FK takes KEY SHARE.
        // With the former native owner FOR UPDATE this completes the lock
        // cycle: preparation waits for user, native waits for this pa row.
        // The test must finish both transactions successfully, so that former
        // mode produces a real deadlock/lock-budget failure, not a false pass.
        await tx`insert into allrice_cloud_execution_grants
          (id,organization_id,workspace_id,owner_id,target_id,version,profile,enabled)
          values(${grantId},${control.organizationId},${control.workspaceId},
            ${control.ownerId},${targetId},1,'{}',false)`;
      })
      .catch((error: unknown) => {
        preparationReady.reject(error);
        nativeStarted.reject(error);
        throw error;
      });
    const native = (async () => {
      await preparationReady.promise;
      return f.db.begin(async (tx) => {
        await tx`set local lock_timeout='5s'`;
        await tx`set local statement_timeout='10s'`;
        nativeStarted.resolve(await backendPid(tx));
        expect(
          await lockPlatformQualityNativeAdmission(tx, control),
        ).toMatchObject({
          allowed: true,
          currentRevision: control.revision,
        });
      });
    })().catch((error: unknown) => {
      nativeStarted.reject(error);
      throw error;
    });
    await completeBoth([preparation, native]);
    const [grant] = await f.db`
      select owner_id,enabled from allrice_cloud_execution_grants where id=${grantId}`;
    expect(grant).toMatchObject({ owner_id: control.ownerId, enabled: false });
  }, 15_000);

  it.each(['status', 'email'] as const)(
    'a concurrent owner %s permission change waits for native admission and is observed by its next transaction',
    async (field) => {
      const [before] = await f.db<{ status: string; email: string }[]>`
        select status,email from allrice_users where id=${control.ownerId}`;
      const nativeReady = signal<number>(),
        updateStarted = signal<number>();
      const changedEmail = `revoked-native-quality-${randomUUID()}@example.test`;
      const native = f.db
        .begin(async (tx) => {
          await tx`set local lock_timeout='5s'`;
          await tx`set local statement_timeout='10s'`;
          expect(
            await lockPlatformQualityNativeAdmission(tx, control),
          ).toMatchObject({
            allowed: true,
          });
          const pid = await backendPid(tx);
          nativeReady.resolve(pid);
          const updaterPid = await updateStarted.promise;
          expect(updaterPid).not.toBe(pid);
          // Proves the real UPDATE is waiting before admission may commit.
          // Removing the owner lock makes this assertion fail.
          await blockedBy(tx, updaterPid, pid);
          const [stillCurrent] = await tx`
            select status,email from allrice_users where id=${control.ownerId}`;
          expect(stillCurrent).toMatchObject(before!);
        })
        .catch((error: unknown) => {
          nativeReady.reject(error);
          updateStarted.reject(error);
          throw error;
        });
      const update = (async () => {
        await nativeReady.promise;
        return f.db.begin(async (tx) => {
          await tx`set local lock_timeout='5s'`;
          await tx`set local statement_timeout='10s'`;
          updateStarted.resolve(await backendPid(tx));
          if (field === 'status')
            await tx`update allrice_users set status='disabled' where id=${control.ownerId}`;
          else
            await tx`update allrice_users set email=${changedEmail} where id=${control.ownerId}`;
        });
      })().catch((error: unknown) => {
        updateStarted.reject(error);
        throw error;
      });
      try {
        await completeBoth([native, update]);
        const [changed] = await f.db`
          select status,email from allrice_users where id=${control.ownerId}`;
        expect(changed?.[field]).toBe(
          field === 'status' ? 'disabled' : changedEmail,
        );
        expect(
          await f.db.begin((tx) =>
            lockPlatformQualityNativeAdmission(tx, control),
          ),
        ).toMatchObject({ allowed: false });
      } finally {
        await f.db`update allrice_users set status=${before!.status},email=${before!.email} where id=${control.ownerId}`;
      }
      expect(
        await f.db.begin((tx) =>
          lockPlatformQualityNativeAdmission(tx, control),
        ),
      ).toMatchObject({ allowed: true });
    },
    15_000,
  );
});
