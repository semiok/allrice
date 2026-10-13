import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EmployeeInstanceProfileSchema } from '@allrice/contracts';
import * as client from '../core/client.ts';
import * as queue from '../execution/queue.ts';
import { updateEmployeeRelease } from './employee-quality.ts';
import * as folderTriggers from '../folder-triggers.ts';
import {
  createAutomation,
  claimDueAutomations,
} from '../execution/automation.ts';
import { createAssistantFixtureDatabase } from '../assistant-runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import { assertWorkbenchSession } from '../artifact-review.ts';
import { createAssistantAuthorityFixture } from '../assistant-authority.fixture.ts';
import { createAssistantLocalCommandFixture } from '../local-command-assistant.fixture.ts';
import { resolveTaskRuntimePolicy } from '../task-runtime-policy.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
  revokeSession,
} from '../identity.ts';
import {
  changeAdminTenantEmployee,
  listAdminTenantEmployees,
} from '../tenant-employees.ts';
import {
  createAssignedChatSession,
  createChatSession,
  getEmployeeWorkspace,
  listChatSessions,
  sendChatMessage,
} from '../workspace/service.ts';
import {
  publishPlatformEmployee,
  savePlatformEmployeeDraft,
  disablePlatformEmployee,
  assignPublishedPlatformEmployeeToWorkspace,
} from './platform-employees.ts';
import {
  assertEmployeeInstanceAdmission,
  createEmployeeInstance,
  ensureGeneralEmployeeInstance,
  getEmployeeInstance,
  listEmployeeInstances,
  lockEmployeeInstanceAdmissionIdentity,
  prepareEmployeeInstanceSnapshot,
  updateEmployeeInstance,
  changeEmployeeInstanceLifecycle,
  getEmployeeInstanceForHistory,
  getEmployeeInstanceHistory,
  listHistoricalEmployeeInstances,
} from './employee-instances.ts';
import {
  manageEmployeeAssignments,
  updateEmployeeStatus,
} from './employeehub.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET179 employee instances (isolated PostgreSQL; no model)', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (fixture) await fixture.close();
  });
  async function principal(
    organizationSlug = `instance-${randomUUID()}`,
    role: 'member' | 'admin' = 'member',
  ) {
    const p = await ensureBootstrapPortalPrincipal(
      {
        organizationSlug,
        organizationName: 'Synthetic instance company',
        workspaceSlug: 'default',
        workspaceName: 'Synthetic workspace',
        email: `${randomUUID()}@example.test`,
        displayName: 'Synthetic member',
        role,
      },
      fixture.db,
    );
    const login = await createSession(p.user.id);
    const context = await authenticateSession(login.token, {
      organizationId: p.organizationId,
      workspaceId: p.workspaceId,
    });
    if (!context) throw Error('fixture_login');
    return { ...p, login, context };
  }
  async function setup() {
    const slug = `instance-${randomUUID()}`;
    const admin = await principal(undefined, 'admin'),
      a = await principal(slug),
      b = await principal(slug);
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', admin.user.email);
    const source = await createEmployeeAdministrationFixture(fixture.db);
    await source.preview();
    expect((await source.publish()).valid).toBe(true);
    const entry = async () =>
      (
        await listAdminTenantEmployees(
          admin.context,
          a.organizationId,
          a.workspaceId,
        )
      ).employees.find((e) => e.employeeId === source.employeeId)!;
    const change = async (action: 'assign' | 'withdraw') => {
      const e = await entry();
      return changeAdminTenantEmployee(admin.context, a.organizationId, {
        workspaceId: a.workspaceId,
        employeeId: source.employeeId,
        action,
        revisionId:
          action === 'assign' ? e.revisionId : e.deployment!.revisionId,
        expectedVersion: e.deployment?.version ?? null,
      });
    };
    await change('assign');
    const assignment = (await getEmployeeWorkspace(a.context, a.workspaceId))
      .employees[0]!;
    const bAssignment = (await getEmployeeWorkspace(b.context, b.workspaceId))
      .employees[0]!;
    const input = (name: string) => ({
      workspaceId: a.workspaceId,
      assignmentId: assignment.id,
      requestId: randomUUID(),
      profile: { name },
    });
    const custom = (name: string) =>
      createEmployeeInstance(a.context, input(name));
    const session = (id: string) =>
      createChatSession(a.context, {
        workspaceId: a.workspaceId,
        employeeInstanceId: id,
        title: 'Instance task',
      });
    return {
      admin,
      a,
      b,
      source,
      assignment,
      bAssignment,
      change,
      input,
      custom,
      session,
    };
  }
  it('creates distinct private instances on one assignment, with exact immutable template provenance', async () => {
    const f = await setup(),
      first = await f.custom('Weekly'),
      second = await f.custom('Monthly');
    expect(first.id).not.toBe(second.id);
    expect(first.assignmentId).toBe(second.assignmentId);
    expect(first.source).toMatchObject({
      kind: 'platform',
      templateId: f.source.employeeId,
      templateRevisionId: f.source.revisionId,
    });
    expect(first.creationSource).toEqual(first.source);
    const a = await listEmployeeInstances(f.a.context, f.a.workspaceId),
      b = await listEmployeeInstances(f.b.context, f.b.workspaceId);
    expect(a.map((i) => i.id).sort()).toEqual(
      [f.assignment.id, first.id, second.id].sort(),
    );
    expect(b.map((i) => i.id)).toEqual([f.bAssignment.id]);
    expect(
      await fixture.db`select id from allrice_employee_assignments where user_id=${f.a.user.id}`,
    ).toHaveLength(1);
    await expect(
      getEmployeeInstance(f.b.context, first.id),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      createEmployeeInstance(f.b.context, f.input('Forbidden')),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      createEmployeeInstance(f.admin.context, f.input('Wrong company')),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });
  it('archives only the selected instance and restores a source profile into a new immutable revision', async () => {
    const f = await setup(),
      i = await f.custom('Original'),
      other = await f.custom('Other');
    const original =
      await fixture.db`select * from allrice_employee_instance_revisions where instance_id=${i.id}`;
    await updateEmployeeInstance(f.a.context, i.id, {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 1,
      profile: { name: 'Changed' },
    });
    const s = await f.session(i.id),
      sent = await sendChatMessage(f.a.context, f.a.workspaceId, s.id, {
        text: 'Synthetic pending task',
        clientMessageId: randomUUID(),
      });
    const frozen =
      await fixture.db`select execution_snapshot,prompt_snapshot from allrice_employee_runs where run_id=${sent.run.id}`;
    const archive = {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 2,
      operation: 'archive',
    };
    const archived = await changeEmployeeInstanceLifecycle(
      f.a.context,
      i.id,
      archive,
    );
    expect(archived).toMatchObject({
      revision: 3,
      profile: { name: 'Changed' },
      archivedAt: expect.any(String),
    });
    expect(
      await changeEmployeeInstanceLifecycle(f.a.context, i.id, archive),
    ).toEqual(archived);
    await expect(getEmployeeInstance(f.a.context, i.id)).rejects.toMatchObject({
      code: 'instance_archived',
    });
    await expect(f.session(i.id)).rejects.toThrow();
    expect(
      (await listEmployeeInstances(f.a.context, f.a.workspaceId)).map(
        (x) => x.id,
      ),
    ).not.toContain(i.id);
    expect(
      (
        await listHistoricalEmployeeInstances(f.a.context, f.a.workspaceId)
      ).instances.map((x) => x.id),
    ).toContain(i.id);
    expect((await getEmployeeInstance(f.a.context, other.id)).id).toBe(
      other.id,
    );
    await expect(
      getEmployeeInstanceForHistory(f.b.context, i.id),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      changeEmployeeInstanceLifecycle(f.b.context, i.id, {
        ...archive,
        expectedRevision: 3,
        operation: 'restore',
        sourceRevision: 1,
      }),
    ).rejects.toThrow();
    const restored = await changeEmployeeInstanceLifecycle(f.a.context, i.id, {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 3,
      operation: 'restore',
      sourceRevision: 1,
    });
    expect(restored).toMatchObject({
      id: i.id,
      revision: 4,
      profile: i.profile,
      archivedAt: null,
      creationSource: i.creationSource,
    });
    const history = await getEmployeeInstanceHistory(f.a.context, i.id);
    expect(
      history.revisions.map((r) => [
        r.revision,
        r.operation,
        r.restoredFromRevision,
      ]),
    ).toEqual([
      [4, 'restore', 1],
      [3, 'archive', null],
      [2, 'update', null],
      [1, 'create', null],
    ]);
    expect(
      (await getEmployeeInstanceHistory(f.a.context, i.id, 3)).revisions.map(
        (r) => r.revision,
      ),
    ).toEqual([2, 1]);
    await expect(
      changeEmployeeInstanceLifecycle(f.a.context, i.id, {
        ...archive,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'instance_conflict' });
    await expect(
      changeEmployeeInstanceLifecycle(f.a.context, i.id, {
        ...archive,
        expectedRevision: 4,
      }),
    ).rejects.toMatchObject({ code: 'instance_conflict' });
    await expect(
      fixture.db`update allrice_employee_instance_revisions set profile='{}'::jsonb where instance_id=${i.id} and revision=1`,
    ).rejects.toThrow('employee_instance_revision_immutable');
    expect(
      await fixture.db`select * from allrice_employee_instance_revisions where instance_id=${i.id} and revision=1`,
    ).toEqual(original);
    expect(
      await fixture.db`select execution_snapshot,prompt_snapshot from allrice_employee_runs where run_id=${sent.run.id}`,
    ).toEqual(frozen);
    expect(
      (
        await fixture.db`select cancel_requested_at from allrice_jobs where run_id=${sent.run.id}`
      )[0]!.cancel_requested_at,
    ).not.toBeNull();
    const next = await sendChatMessage(f.a.context, f.a.workspaceId, s.id, {
      text: 'New task after restore',
      clientMessageId: randomUUID(),
      deliveryMode: 'follow_up',
    });
    expect(
      (
        await fixture.db`select cancel_requested_at from allrice_jobs where run_id=${next.run.id}`
      )[0]!.cancel_requested_at,
    ).toBeNull();
  });
  it('keeps withdrawn instances discoverable without reviving archived instances on reassignment', async () => {
    const f = await setup(),
      i = await f.custom('Historical');
    await changeEmployeeInstanceLifecycle(f.a.context, i.id, {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 1,
      operation: 'archive',
    });
    await f.change('withdraw');
    expect((await getEmployeeInstanceForHistory(f.a.context, i.id)).id).toBe(
      i.id,
    );
    expect(
      (
        await listHistoricalEmployeeInstances(f.a.context, f.a.workspaceId)
      ).instances.map((x) => x.id),
    ).toContain(i.id);
    await expect(
      changeEmployeeInstanceLifecycle(f.a.context, i.id, {
        workspaceId: f.a.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 2,
        operation: 'restore',
        sourceRevision: 1,
      }),
    ).rejects.toThrow();
    await f.change('assign');
    expect(
      (await getEmployeeInstanceForHistory(f.a.context, i.id)).archivedAt,
    ).not.toBeNull();
    expect(
      (await listEmployeeInstances(f.a.context, f.a.workspaceId)).map(
        (x) => x.id,
      ),
    ).not.toContain(i.id);
  });
  it('upgrades Rice through its established tenant alias without allowing the alias to rename the platform identity', async () => {
    const source = await createEmployeeAdministrationFixture(fixture.db);
    const [rice] =
      await fixture.db`select id from allrice_platform_employees where employee_key='rice'`;
    const employeeId = rice!.id as string;
    const definition = { ...source.definition, key: 'rice' };
    await savePlatformEmployeeDraft(employeeId, { definition });
    await source.preview(employeeId);
    expect((await source.publish(employeeId)).valid).toBe(true);
    const assigned = async () => fixture.db`
      select e.id, e.employee_key, e.name from allrice_employees e
      join allrice_platform_employee_tenant_assignments d on d.tenant_employee_id=e.id
      where d.employee_id=${employeeId} and d.workspace_id=${source.workspaceId}`;
    const before = await assigned();
    expect(before).toHaveLength(1);
    expect(before[0]!.employee_key).toBe('default-assistant');
    await savePlatformEmployeeDraft(employeeId, {
      definition: { ...definition, name: 'Updated Rice' },
    });
    await source.preview(employeeId);
    expect((await source.publish(employeeId)).valid).toBe(true);
    expect(await assigned()).toEqual([{ ...before[0], name: 'Updated Rice' }]);
    await expect(
      savePlatformEmployeeDraft(employeeId, {
        definition: { ...definition, key: 'default-assistant' },
      }),
    ).rejects.toThrow('platform_employee_materialized_key_immutable');
  });
  it('keeps an unpublished draft rename from blocking repeated deployment of the published identity', async () => {
    const source = await createEmployeeAdministrationFixture(fixture.db);
    await source.preview();
    expect(
      (await publishPlatformEmployee(source.employeeId, { scope: 'assigned' }))
        .valid,
    ).toBe(true);
    const draftKey = `draft-${randomUUID()}`;
    await savePlatformEmployeeDraft(source.employeeId, {
      definition: { ...source.definition, key: draftKey },
    });
    await assignPublishedPlatformEmployeeToWorkspace(
      draftKey,
      source.workspaceId,
    );
    const another = await principal();
    await assignPublishedPlatformEmployeeToWorkspace(
      draftKey,
      another.workspaceId,
    );
    const deployed =
      await fixture.db`select e.employee_key from allrice_platform_employee_tenant_assignments d
      join allrice_employees e on e.id=d.tenant_employee_id where d.employee_id=${source.employeeId}`;
    expect(deployed).toHaveLength(2);
    expect(
      deployed.every((x) => x.employee_key === source.definition.key),
    ).toBe(true);
    await expect(
      savePlatformEmployeeDraft(source.employeeId, {
        definition: source.definition,
      }),
    ).resolves.toBeDefined();
  });
  it('rejects materialized template key changes without detaching instance or content identities', async () => {
    const f = await setup(),
      i = await f.custom('Stable');
    await expect(
      savePlatformEmployeeDraft(f.source.employeeId, {
        definition: { ...f.source.definition, key: 'different-key' },
        expectedRevisionId: f.source.revisionId,
      }),
    ).rejects.toThrow('platform_employee_materialized_key_immutable');
    expect(await getEmployeeInstance(f.a.context, i.id)).toEqual(i);
  });
  it.each([
    'tenant',
    'platform',
    'legacy_assignments',
    'legacy_status',
    'quality_release',
  ] as const)(
    'persistently cancels queued/running/parked jobs on %s withdrawal even after immediate reassignment',
    async (path) => {
      const f = await setup(),
        i = await f.custom('Revocation');
      const runs = [];
      for (const status of ['queued', 'running', 'waiting_approval']) {
        const s = await f.session(i.id),
          sent = await sendChatMessage(f.a.context, f.a.workspaceId, s.id, {
            text: 'Synthetic task',
            clientMessageId: randomUUID(),
          });
        await fixture.db`update allrice_jobs set status=${status} where run_id=${sent.run.id}`;
        runs.push(sent.run.id);
      }
      vi.stubEnv(
        'ALLRICE_PLATFORM_ADMIN_EMAILS',
        `${f.admin.user.email},${f.a.user.email}`,
      );
      const [a] =
        await fixture.db`select employee_id from allrice_employee_assignments where id=${f.assignment.id}`;
      if (path === 'tenant') {
        await f.change('withdraw');
        await f.change('assign');
      } else if (path === 'platform') {
        await disablePlatformEmployee(
          f.source.employeeId,
          { reason: 'Synthetic revocation' },
          'synthetic-platform',
        );
        const saved = await savePlatformEmployeeDraft(f.source.employeeId, {
          definition: f.source.definition,
          expectedRevisionId: f.source.revisionId,
        });
        await f.source.preview();
        await publishPlatformEmployee(f.source.employeeId, {
          scope: 'assigned',
          expectedRevisionId: saved!.currentDraft!.id,
        });
        await f.change('assign');
      } else if (path === 'legacy_assignments') {
        await manageEmployeeAssignments(f.a.context, {
          workspaceId: f.a.workspaceId,
          employeeId: a!.employee_id,
          userIds: [f.b.user.id],
        });
        await manageEmployeeAssignments(f.a.context, {
          workspaceId: f.a.workspaceId,
          employeeId: a!.employee_id,
          userIds: [f.a.user.id, f.b.user.id],
        });
      } else if (path === 'quality_release') {
        await updateEmployeeRelease(f.a.context, {
          workspaceId: f.a.workspaceId,
          employeeId: a!.employee_id,
          action: 'disable',
        });
        await updateEmployeeRelease(f.a.context, {
          workspaceId: f.a.workspaceId,
          employeeId: a!.employee_id,
          action: 'rollback',
        });
      } else {
        await updateEmployeeStatus(f.a.context, a!.employee_id, {
          workspaceId: f.a.workspaceId,
          status: 'archived',
        });
        await f.change('assign');
      }
      expect((await getEmployeeInstance(f.a.context, i.id)).id).toBe(i.id);
      const jobs =
        await fixture.db`select cancel_requested_at from allrice_jobs where run_id in ${fixture.db(runs)}`;
      expect(jobs).toHaveLength(3);
      expect(jobs.every((j) => j.cancel_requested_at)).toBe(true);
    },
  );
  it('retries the entire withdrawal without waiting in reverse order on a worker job SHARE lock', async () => {
    const f = await setup(),
      i = await f.custom('Concurrent'),
      s = await f.session(i.id);
    const sent = await sendChatMessage(f.a.context, f.a.workspaceId, s.id, {
      text: 'Synthetic task',
      clientMessageId: randomUUID(),
    });
    vi.stubEnv(
      'ALLRICE_PLATFORM_ADMIN_EMAILS',
      `${f.admin.user.email},${f.a.user.email}`,
    );
    const [a] =
      await fixture.db`select employee_id from allrice_employee_assignments where id=${f.assignment.id}`;
    const holding = gate(),
      attempting = gate();
    let attempts = 0;
    const original = queue.requestEmployeeAccessCancellationTransaction;
    const spy = vi
      .spyOn(queue, 'requestEmployeeAccessCancellationTransaction')
      .mockImplementation(async (...args) => {
        attempts++;
        attempting.resolve();
        return original(...args);
      });
    const worker = fixture.db.begin(async (tx) => {
      await tx`select id from allrice_jobs where run_id=${sent.run.id} for share`;
      holding.resolve();
      await attempting.promise;
      await tx`set local lock_timeout='1500ms'`;
      await tx`select id from allrice_employees where id=${a!.employee_id} for share`;
    });
    try {
      await holding.promise;
      const withdrawal = updateEmployeeStatus(f.a.context, a!.employee_id, {
        workspaceId: f.a.workspaceId,
        status: 'archived',
      });
      await expect(Promise.all([worker, withdrawal])).resolves.toBeDefined();
      expect(attempts).toBeGreaterThan(1);
      expect(
        (
          await fixture.db`select cancel_requested_at from allrice_jobs where run_id=${sent.run.id}`
        )[0]!.cancel_requested_at,
      ).not.toBeNull();
    } finally {
      attempting.resolve();
      spy.mockRestore();
      await worker;
    }
  });
  it('acquires job NOWAIT before canceling native operations that refresh the task clock', async () => {
    for (const flag of [
      'ALLRICE_ASSISTANTS_ENABLED',
      'ALLRICE_LOCAL_COMMAND_ENABLED',
      'ALLRICE_RUNTIME_POLICY_ENABLED',
      'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
    ])
      vi.stubEnv(flag, '1');
    const f = await createAssistantLocalCommandFixture(fixture.db);
    const operation = await f.create();
    const operationId = operation.snapshot.binding.attempt.operationId;
    await f.db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy)
      values(${f.rootRunId},${f.org},${f.workspace},${f.db.json({ ...resolveTaskRuntimePolicy([]) })})`;
    const [user] =
      await f.db`select email from allrice_users where id=${f.user}`;
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', user!.email);
    const context = await authenticateSession(
      (await createSession(f.user)).token,
      {
        organizationId: f.org,
        workspaceId: f.workspace,
      },
    );
    if (!context) throw Error('fixture_login');
    const holding = gate(),
      attempting = gate();
    let attempts = 0;
    const original = queue.requestEmployeeAccessCancellationTransaction;
    const spy = vi
      .spyOn(queue, 'requestEmployeeAccessCancellationTransaction')
      .mockImplementation(async (...args) => {
        attempts++;
        attempting.resolve();
        return original(...args);
      });
    // Browser authority owns job SHARE before reading employee authority, and
    // has no runtime root lock. Cancellation must release its employee lock
    // before waiting for this transaction, even when ledger.append updates the
    // task clock (and therefore the job) inside root cancellation.
    const browser = f.db.begin(async (tx) => {
      await tx`select id from allrice_jobs where run_id=${f.rootRunId} for share`;
      holding.resolve();
      await attempting.promise;
      await tx`set local lock_timeout='1500ms'`;
      await tx`select id from allrice_employees where id=${f.employee} for share`;
    });
    void browser.catch(() => undefined);
    try {
      await holding.promise;
      const withdrawal = updateEmployeeStatus(context, f.employee, {
        workspaceId: f.workspace,
        status: 'archived',
      });
      const result = await Promise.allSettled([browser, withdrawal]);
      expect(result.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(attempts).toBeGreaterThan(1);
      const [job] =
        await f.db`select cancel_requested_at from allrice_jobs where run_id=${f.rootRunId}`;
      const [root] =
        await f.db`select cancel_requested_at from allrice_runtime_roots where root_run_id=${f.rootRunId}`;
      const [op] =
        await f.db`select snapshot->>'status' as status from allrice_runtime_operations where id=${operationId}`;
      expect(job!.cancel_requested_at).not.toBeNull();
      expect(root!.cancel_requested_at).not.toBeNull();
      expect(['canceled', 'cancel_requested']).toContain(op!.status);
    } finally {
      attempting.resolve();
      spy.mockRestore();
      await browser.catch(() => undefined);
    }
  });
  it('reports contention with no partial archive, then accepts the same request after the worker releases its lock', async () => {
    const f = await setup(),
      i = await f.custom('Atomic'),
      s = await f.session(i.id);
    const sent = await sendChatMessage(f.a.context, f.a.workspaceId, s.id, {
      text: 'Synthetic task',
      clientMessageId: randomUUID(),
    });
    const held = gate(),
      release = gate();
    const worker = fixture.db.begin(async (tx) => {
      await tx`select id from allrice_jobs where run_id=${sent.run.id} for share`;
      held.resolve();
      await release.promise;
    });
    const input = {
      workspaceId: f.a.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 1,
      operation: 'archive',
    };
    try {
      await held.promise;
      await expect(
        changeEmployeeInstanceLifecycle(f.a.context, i.id, input),
      ).rejects.toThrow('employee_access_busy');
      expect(await getEmployeeInstance(f.a.context, i.id)).toEqual(i);
      expect(
        (await getEmployeeInstanceHistory(f.a.context, i.id)).revisions,
      ).toHaveLength(1);
      expect(
        (
          await fixture.db`select cancel_requested_at from allrice_jobs where run_id=${sent.run.id}`
        )[0]!.cancel_requested_at,
      ).toBeNull();
    } finally {
      release.resolve();
      await worker;
    }
    expect(
      (await changeEmployeeInstanceLifecycle(f.a.context, i.id, input))
        .revision,
    ).toBe(2);
  });
  it('serializes duplicate creation and default mapping; retry returns the original creation after rename', async () => {
    const f = await setup(),
      input = f.input('Original');
    const created = await Promise.all(
      [1, 2, 3].map(() => createEmployeeInstance(f.a.context, input)),
    );
    expect(new Set(created.map((i) => i.id)).size).toBe(1);
    const original = created[0]!;
    const renamed = await updateEmployeeInstance(f.a.context, original.id, {
      workspaceId: f.a.workspaceId,
      expectedRevision: 1,
      requestId: randomUUID(),
      profile: { name: 'Renamed' },
    });
    expect(renamed.profile.name).toBe('Renamed');
    expect(await createEmployeeInstance(f.a.context, input)).toEqual(original);
    await expect(
      createEmployeeInstance(f.a.context, {
        ...input,
        profile: { name: 'Different' },
      }),
    ).rejects.toMatchObject({ code: 'instance_conflict' });
    await Promise.all(
      [1, 2, 3].map(() =>
        ensureGeneralEmployeeInstance(fixture.db, f.assignment.id),
      ),
    );
    expect(
      await fixture.db`select id from allrice_employee_instances where assignment_id=${f.assignment.id} and kind='general'`,
    ).toHaveLength(1);
  });
  it('uses optimistic revisions and stable update retries, without accepting authority or tool configuration', async () => {
    const f = await setup(),
      instance = await f.custom('Review');
    const edit = {
      workspaceId: f.a.workspaceId,
      expectedRevision: 1,
      requestId: randomUUID(),
      profile: { name: 'Revision two', role: 'Data reviewer' },
    };
    const edits = [
      edit,
      { ...edit, requestId: randomUUID(), profile: { name: 'Competing' } },
    ];
    const outcomes = await Promise.allSettled(
      edits.map((i) => updateEmployeeInstance(f.a.context, instance.id, i)),
    );
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const winner = outcomes.findIndex((r) => r.status === 'fulfilled');
    const response = (
      outcomes[winner] as PromiseFulfilledResult<
        Awaited<ReturnType<typeof updateEmployeeInstance>>
      >
    ).value;
    const acceptedEdit = edits[winner]!;
    await updateEmployeeInstance(f.a.context, instance.id, {
      ...edit,
      requestId: randomUUID(),
      expectedRevision: 2,
      profile: { name: 'Revision three' },
    });
    expect(
      await updateEmployeeInstance(f.a.context, instance.id, acceptedEdit),
    ).toEqual(response);
    await expect(
      updateEmployeeInstance(f.a.context, instance.id, {
        ...acceptedEdit,
        profile: { name: 'Tampered retry' },
      }),
    ).rejects.toMatchObject({ code: 'instance_conflict' });
    for (const key of [
      'modelPolicy',
      'toolNames',
      'securityPolicy',
      'maintenanceLevel',
    ]) {
      expect(
        EmployeeInstanceProfileSchema.safeParse({
          name: 'Name',
          [key]: 'elevated',
        }).success,
      ).toBe(false);
    }
    await expect(
      updateEmployeeInstance(f.b.context, instance.id, edit),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
  it('binds each Session and paginated sidebar group to the chosen instance and rejects cross-instance Session replay', async () => {
    const f = await setup(),
      one = await f.custom('Weekly'),
      two = await f.custom('Monthly');
    const first = await f.session(one.id),
      second = await f.session(two.id),
      third = await f.session(one.id);
    expect(first.employeeAssignmentId).toBe(f.assignment.id);
    expect(first.employeeInstanceId).toBe(one.id);
    const all = await listChatSessions(f.a.context, f.a.workspaceId, {
      includeEmployeeGroups: true,
    });
    expect(all.employeeGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          employeeInstanceId: one.id,
          employeeName: 'Weekly',
          count: 2,
        }),
        expect.objectContaining({
          employeeInstanceId: two.id,
          employeeName: 'Monthly',
          count: 1,
        }),
      ]),
    );
    const page = await listChatSessions(f.a.context, f.a.workspaceId, {
      employeeInstanceId: one.id,
      limit: 1,
    });
    const next = await listChatSessions(f.a.context, f.a.workspaceId, {
      employeeInstanceId: one.id,
      limit: 1,
      cursor: page.nextCursor!,
    });
    expect(
      [...page.sessions, ...next.sessions].map((s) => s.id).sort(),
    ).toEqual([first.id, third.id].sort());
    expect(second.employeeInstanceId).toBe(two.id);
    await expect(
      createAssignedChatSession(
        f.a.context,
        {
          workspaceId: f.a.workspaceId,
          employeeAssignmentId: f.assignment.id,
          employeeInstanceId: two.id,
        },
        { sessionId: first.id },
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      createChatSession(f.b.context, {
        workspaceId: f.b.workspaceId,
        employeeInstanceId: one.id,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      createChatSession(f.a.context, {
        workspaceId: f.a.workspaceId,
        employeeAssignmentId: f.bAssignment.id,
        employeeInstanceId: one.id,
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    // The database also rejects a forged owner/assignment association.
    await expect(
      fixture.db`update allrice_chat_sessions set employee_instance_id=${f.bAssignment.id} where id=${first.id}`,
    ).rejects.toMatchObject({ code: '23503' });
  });
  it('freezes personal metadata and exact source in the actual Run, preserving retries after a personal edit', async () => {
    const f = await setup(),
      i = await f.custom('Original instance'),
      s = await f.session(i.id);
    const input = {
      text: 'Read installed synthetic skill',
      clientMessageId: randomUUID(),
      deliveryMode: 'follow_up',
    };
    const sent = await sendChatMessage(
      f.a.context,
      f.a.workspaceId,
      s.id,
      input,
    );
    const [before] =
      await fixture.db`select execution_snapshot,prompt_snapshot from allrice_employee_runs where run_id=${sent.run.id}`;
    expect(before!.execution_snapshot.instance).toMatchObject({
      id: i.id,
      revision: 1,
      profile: { name: 'Original instance' },
      source: i.source,
    });
    await updateEmployeeInstance(f.a.context, i.id, {
      workspaceId: f.a.workspaceId,
      expectedRevision: 1,
      requestId: randomUUID(),
      profile: { name: 'New instance name' },
    });
    expect(
      (await sendChatMessage(f.a.context, f.a.workspaceId, s.id, input)).run.id,
    ).toBe(sent.run.id);
    const next = await sendChatMessage(f.a.context, f.a.workspaceId, s.id, {
      ...input,
      clientMessageId: randomUUID(),
      text: 'Next task',
    });
    const [nextRow] =
      await fixture.db`select execution_snapshot from allrice_employee_runs where run_id=${next.run.id}`;
    expect(nextRow!.execution_snapshot.instance).toMatchObject({
      id: i.id,
      revision: 2,
      profile: { name: 'New instance name' },
    });
    expect(
      (
        await fixture.db`select execution_snapshot,prompt_snapshot from allrice_employee_runs where run_id=${sent.run.id}`
      )[0],
    ).toEqual(before);
  });
  it('keeps personal identity through publication, recording creation source separately from the current run source', async () => {
    const f = await setup(),
      i = await f.custom('My reviewer'),
      s = await f.session(i.id);
    const saved = await savePlatformEmployeeDraft(f.source.employeeId, {
      definition: { ...f.source.definition, description: 'Updated template' },
      expectedRevisionId: f.source.revisionId,
    });
    await f.source.preview();
    expect(
      (
        await publishPlatformEmployee(f.source.employeeId, {
          scope: 'assigned',
          expectedRevisionId: saved!.currentDraft!.id,
        })
      ).valid,
    ).toBe(true);
    const updated = await getEmployeeInstance(f.a.context, i.id);
    expect(updated).toMatchObject({
      id: i.id,
      revision: 1,
      profile: i.profile,
      creationSource: i.creationSource,
    });
    expect(updated.source).toMatchObject({
      kind: 'platform',
      templateRevisionId: saved!.currentDraft!.id,
    });
    expect(updated.source.employeeVersionId).not.toBe(
      i.source.employeeVersionId,
    );
    const snapshot = await prepareEmployeeInstanceSnapshot(
      f.a.context,
      s.id,
      f.assignment.id,
      updated.source.employeeVersionId,
    );
    expect(snapshot.source).toEqual(updated.source);
    await expect(
      prepareEmployeeInstanceSnapshot(
        f.a.context,
        s.id,
        f.assignment.id,
        i.source.employeeVersionId,
      ),
    ).rejects.toMatchObject({ code: 'instance_conflict' });
  });
  it('rechecks changed metadata, owner, Session binding, assignment withdrawal and current login before admission', async () => {
    const f = await setup(),
      i = await f.custom('Review'),
      s = await f.session(i.id);
    const snapshot = await prepareEmployeeInstanceSnapshot(
      f.a.context,
      s.id,
      f.assignment.id,
      i.source.employeeVersionId,
    );
    const admit = () =>
      fixture.db.begin((tx) =>
        assertEmployeeInstanceAdmission(tx, f.a.context, s.id, snapshot),
      );
    await admit();
    await expect(
      fixture.db.begin((tx) =>
        assertEmployeeInstanceAdmission(tx, f.b.context, s.id, snapshot),
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    const other = await f.session((await f.custom('Other')).id);
    await expect(
      fixture.db.begin((tx) =>
        assertEmployeeInstanceAdmission(tx, f.a.context, other.id, snapshot),
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await updateEmployeeInstance(f.a.context, i.id, {
      workspaceId: f.a.workspaceId,
      expectedRevision: 1,
      requestId: randomUUID(),
      profile: { name: 'Changed while preparing' },
    });
    await expect(admit()).rejects.toMatchObject({ code: 'instance_conflict' });
    await f.change('withdraw');
    await expect(admit()).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    await expect(f.session(i.id)).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    await f.change('assign');
    await revokeSession(f.a.login.token);
    await expect(
      createEmployeeInstance(f.a.context, f.input('Revoked login')),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });
  it('keeps scheduled work independent of browser logins while rechecking current membership', async () => {
    const f = await setup();
    const rule = await createAutomation(f.a.context, {
      workspaceId: f.a.workspaceId,
      employeeAssignmentId: f.assignment.id,
      name: 'Synthetic daily task',
      prompt: 'Return the synthetic count',
      schedule: { frequency: 'daily', time: '09:00', timezone: 'UTC' },
    });
    await revokeSession(f.a.login.token);
    await expect(
      createEmployeeInstance(f.a.context, f.input('Expired')),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    const tick = async () => {
      await fixture.db`update allrice_automations set next_run_at=clock_timestamp()-interval '1 second' where id=${rule.id}`;
      await claimDueAutomations();
      return fixture.db`select r.run_id,r.status,e.execution_snapshot from allrice_automation_runs r left join allrice_employee_runs e on e.run_id=r.run_id where r.automation_id=${rule.id} order by r.created_at`;
    };
    const first = await tick();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      status: 'queued',
      execution_snapshot: {
        instance: { id: f.assignment.id, ownerId: f.a.user.id },
      },
    });
    await fixture.db`update allrice_memberships set active=false where user_id=${f.a.user.id} and organization_id=${f.a.organizationId}`;
    const afterRevocation = await tick();
    expect(afterRevocation).toHaveLength(2);
    expect(afterRevocation[0]!.run_id).toBe(first[0]!.run_id);
    expect(afterRevocation[1]).toMatchObject({
      status: 'failed',
      run_id: null,
    });
  });
  it('serializes simultaneous actual task admissions for one user across two instances without a lock upgrade deadlock', async () => {
    const f = await setup(),
      a = await f.session((await f.custom('A')).id),
      b = await f.session((await f.custom('B')).id);
    const result = await Promise.all(
      [a, b].map((s) =>
        sendChatMessage(f.a.context, f.a.workspaceId, s.id, {
          text: 'Independent task',
          clientMessageId: randomUUID(),
          deliveryMode: 'follow_up',
        }),
      ),
    );
    expect(new Set(result.map((r) => r.run.id)).size).toBe(2);
    const rows =
      await fixture.db`select execution_snapshot from allrice_employee_runs where run_id in ${fixture.db(result.map((r) => r.run.id))}`;
    expect(rows.map((r) => r.execution_snapshot.instance.id).sort()).toEqual(
      [a.employeeInstanceId, b.employeeInstanceId].sort(),
    );
  }, 30000);
  it('serializes task admission before downstream folder authority takes user SHARE', async () => {
    const f = await setup(),
      a = await f.session((await f.custom('Folder A')).id),
      b = await f.session((await f.custom('Folder B')).id);
    const calls = new Map<string, number>();
    // Isolate the folder-authority port's lock behaviour. Actual folder grant,
    // import and lost-ACK checks remain in folder-triggers.integration.test.ts.
    const spy = vi
      .spyOn(folderTriggers, 'assertFolderTriggerMessage')
      .mockImplementation(async (tx, eventId, context) => {
        await tx`select id from allrice_users where id=${context.actor.id} for share`;
        const n = (calls.get(eventId) ?? 0) + 1;
        calls.set(eventId, n);
        if (n === 2) {
          // At queue admission another event must be unable to acquire SHARE.
          // Otherwise both events could subsequently wait on a lock upgrade.
          await expect(
            fixture.db.begin(async (probe) => {
              await probe`select id from allrice_users where id=${context.actor.id} for share nowait`;
            }),
          ).rejects.toMatchObject({ code: '55P03' });
        }
      });
    try {
      const result = await Promise.all(
        [a, b].map((s) => {
          const eventId = randomUUID();
          return sendChatMessage(
            f.a.context,
            f.a.workspaceId,
            s.id,
            {
              text: 'Folder task',
              clientMessageId: eventId,
              deliveryMode: 'follow_up',
            },
            { folderEventId: eventId },
          );
        }),
      );
      expect(new Set(result.map((r) => r.run.id)).size).toBe(2);
      expect([...calls.values()]).toEqual([2, 2]);
    } finally {
      spy.mockRestore();
    }
  });
  const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  async function waitingOnLock(pid: number) {
    await expect
      .poll(
        async () =>
          (
            await fixture.db`select wait_event_type from pg_stat_activity where pid=${pid}`
          )[0]?.wait_event_type,
        { timeout: 2000, interval: 10 },
      )
      .toBe('Lock');
  }
  it('admits while a workbench writer waits on the same identity, without a Session→user lock inversion', async () => {
    const f = await setup(),
      i = await f.custom('Concurrent writer'),
      s = await f.session(i.id);
    const snapshot = await prepareEmployeeInstanceSnapshot(
      f.a.context,
      s.id,
      f.assignment.id,
      i.source.employeeVersionId,
    );
    const locked = gate(),
      proceed = gate(),
      readerReady = gate();
    let readerPid = 0;
    const admission = fixture.db.begin(async (tx) => {
      await lockEmployeeInstanceAdmissionIdentity(tx, f.a.context);
      locked.resolve();
      await proceed.promise;
      await assertEmployeeInstanceAdmission(tx, f.a.context, s.id, snapshot);
    });
    void admission.catch(() => undefined);
    await locked.promise;
    const workbench = fixture.db.begin(async (tx) => {
      readerPid = (await tx`select pg_backend_pid() pid`)[0]!.pid;
      readerReady.resolve();
      await assertWorkbenchSession(tx, f.a.context, s.id, true);
    });
    void workbench.catch(() => undefined);
    try {
      await readerReady.promise;
      await waitingOnLock(readerPid);
    } finally {
      proceed.resolve();
    }
    expect(
      (await Promise.allSettled([admission, workbench])).map((r) => r.status),
    ).toEqual(['fulfilled', 'fulfilled']);
  });
  it('permits publication FK checks while admission waits on its assignment', async () => {
    const f = await setup(),
      i = await f.custom('Publishing'),
      s = await f.session(i.id);
    const snapshot = await prepareEmployeeInstanceSnapshot(
      f.a.context,
      s.id,
      f.assignment.id,
      i.source.employeeVersionId,
    );
    const locked = gate(),
      publish = gate(),
      admissionReady = gate();
    let admissionPid = 0;
    const publication = fixture.db.begin(async (tx) => {
      // The same assignment/skill-binding sequence used by materialization.
      await tx`select id from allrice_employee_assignments where id=${f.assignment.id} for no key update`;
      locked.resolve();
      await publish.promise;
      const [binding] =
        await tx`delete from allrice_employee_dsh_skill_bindings where employee_id=${f.assignment.employeeId} returning *`;
      if (!binding) throw Error('fixture_binding_missing');
      await tx`insert into allrice_employee_dsh_skill_bindings(organization_id,workspace_id,employee_id,skill_id,bound_by)
        values(${binding.organization_id},${binding.workspace_id},${binding.employee_id},${binding.skill_id},${f.a.user.id})`;
    });
    void publication.catch(() => undefined);
    await locked.promise;
    const admission = fixture.db.begin(async (tx) => {
      admissionPid = (await tx`select pg_backend_pid() pid`)[0]!.pid;
      await lockEmployeeInstanceAdmissionIdentity(tx, f.a.context);
      admissionReady.resolve();
      await assertEmployeeInstanceAdmission(tx, f.a.context, s.id, snapshot);
    });
    void admission.catch(() => undefined);
    try {
      await admissionReady.promise;
      await waitingOnLock(admissionPid);
    } finally {
      publish.resolve();
    }
    expect(
      (await Promise.allSettled([publication, admission])).map((r) => r.status),
    ).toEqual(['fulfilled', 'fulfilled']);
  });
  it('reads a stored legacy Run without adding instance data or rewriting its frozen JSON', async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const f = await createAssistantAuthorityFixture(fixture.db, {
      memberRole: 'member',
    });
    const before = (
      await fixture.db`select execution_snapshot::text snapshot,prompt_snapshot::text prompt from allrice_employee_runs where run_id=${f.rootRunId}`
    )[0]!;
    expect(JSON.parse(before.snapshot)).not.toHaveProperty('instance');
    await ensureGeneralEmployeeInstance(fixture.db, f.assignment);
    const { getChatSessionHistory } = await import('../workspace/service.ts');
    const login = await createSession(f.user);
    const context = await authenticateSession(login.token, {
      organizationId: f.org,
      workspaceId: f.workspace,
    });
    if (!context) throw Error('fixture_login');
    const history = await getChatSessionHistory(
      context,
      f.workspace,
      f.session,
    );
    expect(history.session.employeeInstanceId).toBe(f.assignment);
    expect(
      (
        await fixture.db`select execution_snapshot::text snapshot,prompt_snapshot::text prompt from allrice_employee_runs where run_id=${f.rootRunId}`
      )[0],
    ).toEqual(before);
  });
  it('keeps an existing native assistant root canceled after the archived instance is restored', async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const f = await createAssistantAuthorityFixture(fixture.db, {
      memberRole: 'member',
    });
    await ensureGeneralEmployeeInstance(fixture.db, f.assignment);
    const context = await authenticateSession(
      (await createSession(f.user)).token,
      { organizationId: f.org, workspaceId: f.workspace },
    );
    if (!context) throw Error('fixture_login');
    const input = {
      workspaceId: f.workspace,
      requestId: randomUUID(),
      expectedRevision: 1,
      operation: 'archive',
    };
    await changeEmployeeInstanceLifecycle(context, f.assignment, input);
    const [cutoff] =
      await fixture.db`select cancel_request_id,cancel_requested_at from allrice_runtime_roots where root_run_id=${f.rootRunId}`;
    expect(cutoff!.cancel_request_id).not.toBeNull();
    await changeEmployeeInstanceLifecycle(context, f.assignment, {
      ...input,
      requestId: randomUUID(),
      expectedRevision: 2,
      operation: 'restore',
      sourceRevision: 1,
    });
    expect(
      (
        await fixture.db`select cancel_request_id,cancel_requested_at from allrice_runtime_roots where root_run_id=${f.rootRunId}`
      )[0],
    ).toEqual(cutoff);
    expect(
      await f.runtime.assertCurrentAuthority({
        scope: f.task.scope,
        rootRunId: f.rootRunId,
        worker: f.worker,
      }),
    ).toEqual({ cancelRequested: true });
  });
  it('maps legacy Sessions to their original default, labels unprovable provenance honestly, and leaves old Run JSON intact', async () => {
    const f = await setup();
    const s = await f.session(f.assignment.id);
    await fixture.db`update allrice_chat_sessions set employee_instance_id=null where id=${s.id}`;
    await fixture.db`delete from allrice_employee_version_sources where employee_version_id=${f.assignment.currentVersion.id}`;
    const snapshot = await prepareEmployeeInstanceSnapshot(
      f.a.context,
      s.id,
      f.assignment.id,
      f.assignment.currentVersion.id,
    );
    expect(snapshot.id).toBe(f.assignment.id);
    expect(snapshot.source).toEqual({
      kind: 'tenant_version',
      employeeVersionId: f.assignment.currentVersion.id,
    });
    expect(
      (await listChatSessions(f.a.context, f.a.workspaceId)).sessions[0]!
        .employeeInstanceId,
    ).toBe(f.assignment.id);
    expect(
      (
        await fixture.db`select employee_instance_id from allrice_chat_sessions where id=${s.id}`
      )[0]!.employee_instance_id,
    ).toBeNull();
  });
});
