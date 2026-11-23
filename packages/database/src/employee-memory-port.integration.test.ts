import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  MemoryDetailQueryProjectionSchema,
  EmployeeMemoryWriteResponseSchema,
  type EmployeeMemoryRecord,
  type RequestContext,
} from '@allrice/contracts';
import type * as MemoryClientModule from '../../../apps/web/lib/memory/employee-memory-client.ts';
import * as client from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  createEmployeeMemoryPort,
  EmployeeMemoryWriteOutcomeUnknown,
  type EmployeeMemoryModuleQualification,
  type EmployeeMemoryPort,
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
  type ClientModule = typeof MemoryClientModule;
  let employeeMemoryClient: ClientModule['employeeMemoryClient'];
  let storageErrorResponse: (
    error: unknown,
    options: { onUnexpectedError: (error: unknown) => void },
  ) => Response;
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
    const clientPath = '../../../apps/web/lib/memory/employee-memory-client.ts';
    const responsePath = '../../../apps/web/lib/storage/responses.ts';
    ({ employeeMemoryClient } = (await import(clientPath)) as ClientModule);
    ({ storageErrorResponse } = (await import(responsePath)) as {
      storageErrorResponse: typeof storageErrorResponse;
    });
  }, 120000);
  afterEach(() => vi.unstubAllGlobals());
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

  function httpConsumer(
    f: Scope,
    port: EmployeeMemoryPort,
    requestSignal = signal,
  ) {
    const writes: Parameters<ClientModule['employeeMemoryClient']>[1] =
      new Map();
    const requests: Array<Record<string, unknown>> = [];
    const replies: Array<{ status: number; text: string }> = [];
    const unexpected: unknown[] = [];
    // Only the HTTP routing boundary is substituted. The production client,
    // storage error mapping, facade and PostgreSQL transactions are real.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (address: unknown, init?: RequestInit) => {
        const url = new URL(String(address), 'http://localhost');
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        let response: Response;
        try {
          if (url.pathname === '/api/v1/memories') {
            response = Response.json(
              await port.create(
                f.context,
                body as Parameters<EmployeeMemoryPort['create']>[1],
                requestSignal(),
              ),
              { status: 201 },
            );
          } else {
            const target = {
              workspaceId: url.searchParams.get('workspaceId')!,
              memoryId: decodeURIComponent(url.pathname.split('/')[4]!),
            };
            if (init?.method === 'PATCH') {
              response = Response.json(
                await port.correct(
                  f.context,
                  {
                    target,
                    body: body as Parameters<
                      EmployeeMemoryPort['correct']
                    >[1]['body'],
                  },
                  requestSignal(),
                ),
              );
            } else if (init?.method === 'DELETE') {
              await port.withdraw(
                f.context,
                {
                  target,
                  body: body as Parameters<
                    EmployeeMemoryPort['withdraw']
                  >[1]['body'],
                },
                requestSignal(),
              );
              response = new Response(null, { status: 204 });
            } else {
              response = Response.json(
                await port.confirm(
                  f.context,
                  {
                    target,
                    body: body as Parameters<
                      EmployeeMemoryPort['confirm']
                    >[1]['body'],
                  },
                  requestSignal(),
                ),
              );
            }
          }
        } catch (error) {
          response = storageErrorResponse(error, {
            onUnexpectedError: (failure) => {
              unexpected.push(failure);
            },
          });
        }
        replies.push({
          status: response.status,
          text: await response.clone().text(),
        });
        return response;
      }),
    );
    return {
      client: employeeMemoryClient(
        { scopeId: f.context.sessionId, ...query(f), headers: {} },
        writes,
      ),
      writes,
      requests,
      replies,
      unexpected,
    };
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

  it.each(['create', 'edit', 'confirm', 'withdraw'] as const)(
    'retains the real client %s key and CAS through post-commit revocation, a later denial and recovery',
    async (action) => {
      const f = await setup(),
        { port: current } = permitted();
      let row: EmployeeMemoryRecord | null = null;
      if (action === 'confirm') {
        row = await seedPersonalMemoryPair(fixture.db, f.context, {
          ...query(f),
          summary: '待确认周报偏好',
          details: '仅当前员工',
        });
      } else if (action !== 'create') {
        row = (await current.create(f.context, createInput(f), signal()))
          .memory;
      }
      const originalCas = row && {
        expectedRevision: row.revision,
        pairDigest: row.pairDigest,
      };
      let enabled = true,
        revoke = true,
        checks = 0;
      const denied = new DataAccessError('authorization_denied');
      const port = createEmployeeMemoryPort({
        qualification: {
          async requireCurrentAccess() {
            if (!enabled) throw denied;
            if (++checks === 2 && revoke) {
              enabled = false;
              throw denied;
            }
          },
        },
      });
      const consumer = httpConsumer(f, port);
      const pair = {
        summary: '周报先给风险与下一步',
        details: '限定为当前员工工作周报',
      };
      const invoke = () =>
        action === 'confirm'
          ? consumer.client.confirm(row!)
          : action === 'withdraw'
            ? consumer.client.remove(row!)
            : consumer.client.save(pair, row);
      await expect(invoke()).rejects.toMatchObject({ definitive: false });
      expect(consumer.requests).toHaveLength(1); // No automatic retry.
      expect(consumer.writes.size).toBe(1);
      expect(consumer.replies[0]!.status).toBe(500);
      expect(JSON.parse(consumer.replies[0]!.text)).toMatchObject({
        error: { code: 'INTERNAL_ERROR' },
      });
      expect(consumer.replies[0]!.text).not.toContain(pair.summary);
      expect(consumer.replies[0]!.text).not.toContain('authorization_denied');
      expect(consumer.unexpected[0]).toBeInstanceOf(
        EmployeeMemoryWriteOutcomeUnknown,
      );
      expect((consumer.unexpected[0] as Error).cause).toBe(denied);
      const key = consumer.requests[0]!.idempotencyKey;
      const [receipt] =
        await fixture.db`select memory_id from allrice_employee_memory_operations where organization_id=${f.organizationId} and operation_key=${String(key)}`;
      expect(receipt).toBeDefined();
      const committed = await snapshot(receipt!.memory_id);
      await expect(invoke()).rejects.toMatchObject({ definitive: true });
      expect(consumer.replies[1]!.status).toBe(403);
      expect(consumer.writes.size).toBe(1); // Earlier unknown cannot be disproved.
      enabled = true;
      revoke = false;
      if (action === 'edit' || action === 'confirm') {
        row = (
          await current.detail(
            f.context,
            { ...query(f), memoryId: row!.id },
            signal(),
          )
        ).memory;
      }
      await invoke();
      expect(consumer.requests).toHaveLength(3);
      expect(consumer.requests.map((body) => body.idempotencyKey)).toEqual([
        key,
        key,
        key,
      ]);
      if (originalCas)
        for (const body of consumer.requests)
          expect(body).toMatchObject(originalCas);
      expect(await snapshot(receipt!.memory_id)).toEqual(committed);
      expect(consumer.writes.size).toBe(0);
      expect(consumer.replies[2]!.status).toBe(
        action === 'create' ? 201 : action === 'withdraw' ? 204 : 200,
      );
    },
  );

  it('keeps a pre-admission denial definitive for the real client and performs zero writes', async () => {
    const f = await setup();
    let enabled = false;
    const port = createEmployeeMemoryPort({
      qualification: {
        async requireCurrentAccess() {
          if (!enabled) throw new DataAccessError('authorization_denied');
        },
      },
    });
    const consumer = httpConsumer(f, port);
    const pair = { summary: '周报先给风险', details: null };
    await expect(consumer.client.save(pair, null)).rejects.toMatchObject({
      definitive: true,
    });
    expect(consumer.replies[0]!.status).toBe(403);
    expect(consumer.writes.size).toBe(0);
    const [before] = await fixture.db`select
      (select count(*)::int from allrice_memories where organization_id=${f.organizationId}) memories,
      (select count(*)::int from allrice_employee_memory_operations where organization_id=${f.organizationId}) receipts`;
    expect(before).toEqual({ memories: 0, receipts: 0 });
    enabled = true;
    await consumer.client.save(pair, null);
    expect(consumer.requests[1]!.idempotencyKey).not.toBe(
      consumer.requests[0]!.idempotencyKey,
    );
    expect(consumer.writes.size).toBe(0);
  });

  it('does not label a post-commit response-schema failure as definitive request validation', async () => {
    const f = await setup(),
      { port } = permitted();
    const consumer = httpConsumer(f, port);
    const pair = { summary: '保留完整配对回执', details: '条件不能丢失' };
    const invalid = MemoryDetailQueryProjectionSchema.safeParse({});
    if (invalid.success) throw Error('validation_fault_fixture_missing');
    // Fault only the final response validation boundary. The actual owner
    // write/commit/receipt remains real and has already completed at this call.
    const validation = vi
      .spyOn(EmployeeMemoryWriteResponseSchema, 'parse')
      .mockImplementationOnce(() => {
        throw invalid.error;
      });
    try {
      await expect(consumer.client.save(pair, null)).rejects.toMatchObject({
        definitive: false,
      });
    } finally {
      validation.mockRestore();
    }
    expect(consumer.replies[0]!.status).toBe(500);
    expect((consumer.unexpected[0] as Error).cause).toBe(invalid.error);
    expect(consumer.writes.size).toBe(1);
    const key = consumer.requests[0]!.idempotencyKey;
    const [receipt] =
      await fixture.db`select memory_id from allrice_employee_memory_operations where organization_id=${f.organizationId} and operation_key=${String(key)}`;
    const committed = await snapshot(receipt!.memory_id);
    await consumer.client.save(pair, null);
    expect(consumer.requests.map((body) => body.idempotencyKey)).toEqual([
      key,
      key,
    ]);
    expect(await snapshot(receipt!.memory_id)).toEqual(committed);
  });

  it('keeps the native abort cause on a committed delivery failure while the real client retains its operation', async () => {
    const f = await setup();
    let requestController = new AbortController(),
      checks = 0;
    const cancelReason = new DataAccessError('authorization_denied');
    const port = createEmployeeMemoryPort({
      qualification: {
        async requireCurrentAccess() {
          if (++checks === 2) requestController.abort(cancelReason);
        },
      },
    });
    const consumer = httpConsumer(f, port, () => requestController.signal);
    const pair = { summary: '取消不代表回滚', details: null };
    await expect(consumer.client.save(pair, null)).rejects.toMatchObject({
      definitive: false,
    });
    expect(requestController.signal.reason).toBe(cancelReason);
    expect((consumer.unexpected[0] as Error).cause).toBe(cancelReason);
    expect(consumer.replies[0]!.status).toBe(500);
    expect(consumer.writes.size).toBe(1);
    const key = consumer.requests[0]!.idempotencyKey;
    requestController = new AbortController();
    await consumer.client.save(pair, null);
    expect(consumer.requests.map((body) => body.idempotencyKey)).toEqual([
      key,
      key,
    ]);
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
      // The core commits after its lock clears. Join completes before the
      // delivery-failure error retains the original native cancellation cause.
      expect(await outcome).toEqual({
        error: expect.any(EmployeeMemoryWriteOutcomeUnknown),
      });
      const failure = await outcome;
      expect('error' in failure && (failure.error as Error).cause).toBe(
        cancelReason,
      );
      expect(controller.signal.reason).toBe(cancelReason);
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
