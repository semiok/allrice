import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EmployeeMemoryRecord, RequestContext } from '@allrice/contracts';
import * as client from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  createEmployeeMemoryPort,
  type EmployeeMemoryModuleQualification,
} from './employee-memory-port.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from './identity.ts';
import { ensureGeneralEmployeeInstance } from './employees/employee-instances.ts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { seedPersonalMemoryPair } from './workspace/employee-memory-pair.fixture.ts';
import { ensureDefaultEmployee } from './workspace/service.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const signal = () => new AbortController().signal;

suite('memory public management port: real transactions without a Run', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let admin: RequestContext;
  beforeAll(async () => {
    fixture = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    const principal = await ensureBootstrapPortalPrincipal({
      organizationSlug: 'allrice-platform',
      organizationName: 'Platform',
      workspaceSlug: 'default',
      workspaceName: 'Default',
      email: 'memory-port-admin@example.test',
      displayName: 'Admin',
      role: 'member',
    });
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', principal.user.email);
    admin = (await authenticateSession(
      (await createSession(principal.user.id)).token,
    ))!;
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture?.close();
  }, 30000);

  async function setup() {
    const suffix = randomUUID();
    const principal = await ensureBootstrapPortalPrincipal({
      organizationSlug: `memory-port-${suffix}`,
      organizationName: 'Memory port fixture',
      workspaceSlug: 'default',
      workspaceName: 'Default',
      email: `memory-port-${suffix}@example.test`,
      displayName: 'Owner',
      role: 'member',
    });
    const context = (await authenticateSession(
      (await createSession(principal.user.id)).token,
      principal,
    ))!;
    const assignment = await ensureDefaultEmployee(
      context,
      principal.workspaceId,
    );
    if (!assignment) throw Error('memory_port_fixture_assignment_missing');
    await ensureGeneralEmployeeInstance(fixture.db, assignment.id);
    // These are actual current identity/instance fixtures. No Run, worker,
    // execution context, issued pin or synthetic 4.0 host is created.
    return {
      context,
      organizationId: principal.organizationId,
      workspaceId: principal.workspaceId,
      ownerId: principal.user.id,
      instanceId: assignment.id,
      employeeId: assignment.employeeId,
    };
  }
  type Scope = Awaited<ReturnType<typeof setup>>;
  const query = (f: Scope) => ({
    workspaceId: f.workspaceId,
    instanceId: f.instanceId,
  });
  function permitted() {
    // Only MET-273 module qualification is a contract double. Every memory
    // mutation, identity/resource gate, revision, receipt and audit is real PG.
    const requireCurrentAccess = vi.fn<
      EmployeeMemoryModuleQualification['requireCurrentAccess']
    >(async () => {});
    return {
      port: createEmployeeMemoryPort({
        qualification: { requireCurrentAccess },
      }),
      requireCurrentAccess,
    };
  }
  const createInput = (f: Scope) => ({
    ...query(f),
    idempotencyKey: randomUUID(),
    summary: '周报优先给出风险和下一步',
    details: '适用于当前员工的工作周报，保留限定条件。',
  });
  const command = (f: Scope, row: EmployeeMemoryRecord) => ({
    target: { workspaceId: f.workspaceId, memoryId: row.id },
    body: {
      instanceId: f.instanceId,
      expectedRevision: row.revision,
      pairDigest: row.pairDigest,
      idempotencyKey: randomUUID(),
    },
  });
  async function snapshot(id: string) {
    const [row] = await fixture.db`select jsonb_build_object(
      'memory',(select to_jsonb(m) from allrice_memories m where id=${id}),
      'revisions',(select jsonb_agg(to_jsonb(r) order by revision) from allrice_memory_revisions r where memory_id=${id}),
      'receipts',(select jsonb_agg(to_jsonb(o) order by operation_key) from allrice_employee_memory_operations o where memory_id=${id}),
      'audit',(select jsonb_agg(to_jsonb(a) order by id) from allrice_audit_events a where resource_id=${id})) value`;
    return row!.value;
  }

  it('saves an owner-requested complete pair, reads it, clears details explicitly and withdraws by CAS', async () => {
    // 用户：“请记住：周报优先给出风险和下一步，只用于当前员工的工作周报。”
    const f = await setup();
    const { port, requireCurrentAccess } = permitted();
    const input = createInput(f);
    const saved = await port.create(f.context, input, signal());
    expect(saved.memory).toMatchObject({
      summary: input.summary,
      details: input.details,
      state: 'active',
      revision: 1,
    });
    expect(saved.counts).toEqual({ active: 1, pending: 0, maxActive: 100 });
    expect(
      requireCurrentAccess.mock.calls.every(
        ([, target]) => JSON.stringify(target) === JSON.stringify(query(f)),
      ),
    ).toBe(true);
    const listed = await port.list(f.context, query(f), signal());
    expect(listed.active[0]).not.toHaveProperty('details');
    expect(
      (
        await port.detail(
          f.context,
          { ...query(f), memoryId: saved.memory.id },
          signal(),
        )
      ).memory,
    ).toEqual(saved.memory);
    const edited = await port.correct(
      f.context,
      {
        ...command(f, saved.memory),
        body: {
          ...command(f, saved.memory).body,
          summary: '周报先给风险',
          details: null,
          reason: '本人编辑',
        },
      },
      signal(),
    );
    expect(edited.memory).toMatchObject({
      summary: '周报先给风险',
      details: null,
      hasDetails: false,
      revision: 2,
    });
    const remove = command(f, edited.memory);
    await port.withdraw(f.context, remove, signal());
    await port.withdraw(f.context, remove, signal());
    expect((await port.list(f.context, query(f), signal())).counts).toEqual({
      active: 0,
      pending: 0,
      maxActive: 100,
    });
    const [stored] = await fixture.db`select m.revision,m.archived_at,
      (select count(*)::int from allrice_memory_revisions r where r.memory_id=m.id) revisions,
      (select count(*)::int from allrice_employee_memory_operations o where o.memory_id=m.id) receipts,
      (select count(*)::int from allrice_employee_runs where organization_id=${f.organizationId}) runs
      from allrice_memories m where m.id=${saved.memory.id}`;
    expect(stored).toMatchObject({
      revision: 3,
      revisions: 3,
      receipts: 3,
      runs: 0,
    });
    expect(stored!.archived_at).not.toBeNull();
  });

  it('keeps pair CAS, required details and operation digests ahead of mutation and replay', async () => {
    const f = await setup(),
      { port } = permitted();
    const input = createInput(f);
    const saved = await port.create(f.context, input, signal());
    expect(await port.create(f.context, input, signal())).toEqual(saved);
    const before = await snapshot(saved.memory.id);
    await expect(
      port.create(f.context, { ...input, details: '异内容' }, signal()),
    ).rejects.toMatchObject({ details: { reason: 'idempotency_conflict' } });
    const correction = {
      ...command(f, saved.memory),
      body: {
        ...command(f, saved.memory).body,
        summary: '修订摘要',
        reason: '本人编辑',
      },
    };
    // A malformed boundary payload must never clear the stored detail.
    await expect(
      port.correct(
        f.context,
        correction as Parameters<typeof port.correct>[1],
        signal(),
      ),
    ).rejects.toHaveProperty('name', 'ZodError');
    await expect(
      port.confirm(
        f.context,
        {
          ...command(f, saved.memory),
          body: {
            ...command(f, saved.memory).body,
            pairDigest: `sha256:${'0'.repeat(64)}`,
          },
        },
        signal(),
      ),
    ).rejects.toMatchObject({ details: { reason: 'cas_conflict' } });
    expect(await snapshot(saved.memory.id)).toEqual(before);
    const edited = await port.correct(
      f.context,
      { ...correction, body: { ...correction.body, details: null } },
      signal(),
    );
    expect(edited.memory.revision).toBe(2);
    await expect(port.create(f.context, input, signal())).rejects.toMatchObject(
      { details: { reason: 'idempotency_conflict' } },
    );
  });

  it('confirms a pending complete pair and admits only one final active place concurrently', async () => {
    const f = await setup(),
      { port } = permitted();
    const pending = await Promise.all(
      ['甲', '乙'].map((name) =>
        seedPersonalMemoryPair(fixture.db, f.context, {
          ...query(f),
          summary: `待确认${name}`,
          details: `限定${name}`,
        }),
      ),
    );
    const seeded = await fixture.db<
      { id: string }[]
    >`insert into allrice_memories
      (organization_id,workspace_id,employee_id,owner_id,instance_id,content,summary,details,source_type,trust_level,lifecycle_state)
      select ${f.organizationId},${f.workspaceId},${f.employeeId},${f.ownerId},${f.instanceId},'已有'||n,'已有'||n,null,'user','user_confirmed','durable'
      from generate_series(1,99) n returning id`;
    await fixture.db`insert into allrice_memory_revisions
      (organization_id,workspace_id,memory_id,revision,content,summary,details,trust_level,lifecycle_state,memory_class,confidence,expires_at,reason,changed_by)
      select organization_id,workspace_id,id,revision,content,summary,details,trust_level,lifecycle_state,memory_class,
        confidence,expires_at,'isolated current pair baseline',owner_id
      from allrice_memories where id=any(${seeded.map((row) => row.id)}::uuid[])`;
    expect((await port.list(f.context, query(f), signal())).counts).toEqual({
      active: 99,
      pending: 2,
      maxActive: 100,
    });
    const commands = pending.map((row) => command(f, row));
    const results = await Promise.allSettled(
      commands.map((value) => port.confirm(f.context, value, signal())),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({
      reason: { details: { reason: 'memory_limit_reached' } },
    });
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    const replay = await port.confirm(f.context, commands[winner]!, signal());
    expect(replay.memory).toMatchObject({
      state: 'active',
      details: winner === 0 ? '限定甲' : '限定乙',
      revision: 2,
    });
    expect((await port.list(f.context, query(f), signal())).counts).toEqual({
      active: 100,
      pending: 1,
      maxActive: 100,
    });
  });

  it('fails closed without current module qualification and still checks real owner, tenant, instance and browser authority', async () => {
    const f = await setup(),
      other = await setup(),
      { port } = permitted();
    const input = createInput(f);
    await expect(
      createEmployeeMemoryPort().create(f.context, input, signal()),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    const canceled = new AbortController();
    const cancelReason = new Error('canceled_before_memory_admission');
    canceled.abort(cancelReason);
    await expect(port.create(f.context, input, canceled.signal)).rejects.toBe(
      cancelReason,
    );
    const saved = await port.create(f.context, input, signal());
    const before = await snapshot(saved.memory.id);
    await expect(
      port.detail(
        other.context,
        { ...query(f), memoryId: saved.memory.id },
        signal(),
      ),
    ).rejects.toBeInstanceOf(DataAccessError);
    await expect(
      port.detail(
        f.context,
        {
          ...query(f),
          instanceId: other.instanceId,
          memoryId: saved.memory.id,
        },
        signal(),
      ),
    ).rejects.toBeInstanceOf(DataAccessError);
    await fixture.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${f.context.sessionId}`;
    await expect(
      port.create(f.context, input, signal()),
    ).rejects.toBeInstanceOf(DataAccessError);
    expect(await snapshot(saved.memory.id)).toEqual(before);
  });

  it('retains a committed receipt when qualification is revoked before delivery', async () => {
    const f = await setup();
    let checks = 0;
    const port = createEmployeeMemoryPort({
      qualification: {
        async requireCurrentAccess() {
          if (++checks === 2) throw new DataAccessError('authorization_denied');
        },
      },
    });
    const input = createInput(f);
    await expect(port.create(f.context, input, signal())).rejects.toMatchObject(
      { code: 'authorization_denied' },
    );
    const [saved] =
      await fixture.db`select memory_id from allrice_employee_memory_operations where organization_id=${f.organizationId} and operation_key=${input.idempotencyKey}`;
    expect(saved).toBeDefined();
    const { port: restored } = permitted();
    expect((await restored.create(f.context, input, signal())).memory.id).toBe(
      saved!.memory_id,
    );
    const [count] =
      await fixture.db`select count(*)::int n from allrice_memories where organization_id=${f.organizationId}`;
    expect(count!.n).toBe(1);
  });

  it('joins a real blocked write on cancellation, suppresses delivery and reconciles by the original key', async () => {
    const f = await setup(),
      { port } = permitted();
    const input = createInput(f),
      controller = new AbortController();
    const key = `memory-order:${f.organizationId}:${f.ownerId}:${f.instanceId}`;
    let release!: () => void, acquired!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const blocker = fixture.db.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${key},0))`;
      acquired();
      await held;
    });
    let settled = false;
    let write: Promise<unknown> | undefined;
    try {
      await ready;
      write = port.create(f.context, input, controller.signal);
      const outcome = write.then(
        (value) => {
          settled = true;
          return { value };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        },
      );
      const cancelReason = new Error('memory_port_test_cancel');
      await vi.waitFor(
        async () => {
          const [row] =
            await fixture.db`select exists(select 1 from pg_locks where locktype='advisory' and not granted
          and classid::bigint=((hashtextextended(${key},0)>>32)&4294967295)
          and objid::bigint=(hashtextextended(${key},0)&4294967295) and objsubid=1) blocked`;
          expect(row!.blocked).toBe(true);
        },
        { timeout: 5000, interval: 20 },
      );
      controller.abort(cancelReason);
      expect(settled).toBe(false);
      release();
      await blocker;
      // The core commits after its lock clears; the facade joins and throws
      // the native signal reason instead of delivering a late success.
      expect(await outcome).toEqual({ error: cancelReason });
      const replay = await port.create(f.context, input, signal());
      const [count] =
        await fixture.db`select count(*)::int n from allrice_employee_memory_operations where organization_id=${f.organizationId} and operation_key=${input.idempotencyKey}`;
      expect(replay.memory.state).toBe('active');
      expect(count!.n).toBe(1);
    } finally {
      release();
      await blocker;
      await write?.catch(() => undefined);
    }
  });

  it('preserves the real admin actor and body-free audit independently of owner module qualification', async () => {
    const f = await setup(),
      { port } = permitted();
    const saved = await port.create(f.context, createInput(f), signal());
    const inspection = createEmployeeMemoryPort();
    const target = {
      organizationId: f.organizationId,
      ownerId: f.ownerId,
      instanceId: f.instanceId,
    };
    expect(
      (await inspection.listAdmin(admin, target, signal())).counts.active,
    ).toBe(1);
    expect(
      (
        await inspection.detailAdmin(
          admin,
          { ...target, memoryId: saved.memory.id },
          signal(),
        )
      ).memory,
    ).toEqual(saved.memory);
    const audits =
      await fixture.db`select actor_id,metadata from allrice_audit_events where organization_id=${f.organizationId} and action='employee_memory.admin_read'`;
    expect(audits).toHaveLength(2);
    expect(audits.every((row) => row.actor_id === admin.actor.id)).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(saved.memory.summary);
    expect(JSON.stringify(audits)).not.toContain(saved.memory.details!);
    await expect(
      inspection.listAdmin(f.context, target, signal()),
    ).rejects.toBeInstanceOf(DataAccessError);
    const [count] =
      await fixture.db`select count(*)::int n from allrice_audit_events where organization_id=${f.organizationId} and action='employee_memory.admin_read'`;
    expect(count!.n).toBe(2);
    await expect(
      port.confirm(admin, command(f, saved.memory), signal()),
    ).rejects.toBeInstanceOf(DataAccessError);
  });
});
