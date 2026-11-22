/** Real baseline callers/PG/Storage only. No native module/B/VM producer. */
import { createHash, randomUUID } from 'node:crypto';
import {
  setImmediate as turn,
  setTimeout as delay,
} from 'node:timers/promises';
import postgres, { type Sql } from 'postgres';
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
  CompanyAssetMutationSchema,
  makeObjectKey,
  type CompanyAssetContent,
  type EmployeeContentReference,
  type RequestContext,
} from '@allrice/contracts';
import * as client from '../core/client.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
  revokeSession,
} from '../identity.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../runtime.fixture.ts';
import { requireContentMaintenance } from '../content-maintenance.ts';
import { getEmployeeInstance } from '../employees/employee-instances.ts';
import { resolveEmployeeContentSource } from '../employees/employee-content-sources.ts';
import {
  createPersonalEmployeeMemory,
  correctPersonalEmployeeMemory,
  deleteManagedEmployeeMemory,
  ensureDefaultEmployee,
} from '../workspace/service.ts';
import { memoryPairDigest } from '../workspace/employee-memory.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import {
  bindCallerSourceQueries,
  createBusinessRuntimeCaller,
  joinCallerSave,
  withDedicatedCallerTransaction,
} from './caller-transaction.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

suite('host caller transaction bindings with original SQL owners', () => {
  let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let owner: RequestContext;
  let adminUser: string;
  let instanceId: string;
  const caller = createBusinessRuntimeCaller();
  const releases: (() => void)[] = [];
  const pending: Promise<unknown>[] = [];
  const cleanup: (() => Promise<void>)[] = [];
  const track = <T>(promise: Promise<T>) => {
    pending.push(promise);
    void promise.catch(() => {});
    return promise;
  };
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    f = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
    const person = await ensureBootstrapPortalPrincipal(
      {
        organizationSlug: 'caller-owner',
        organizationName: 'Caller owner',
        workspaceSlug: 'work',
        workspaceName: 'Work',
        email: 'caller-owner@example.test',
        displayName: 'Owner',
        role: 'member',
      },
      f.db,
    );
    owner = (await authenticateSession(
      (await createSession(person.user.id)).token,
    ))!;
    owner = { ...owner, workspaceId: person.workspaceId };
    const employee = await ensureDefaultEmployee(owner, person.workspaceId);
    if (!employee) throw new Error('Baseline employee fixture required');
    instanceId = employee.id;
    const principal = await ensureBootstrapPortalPrincipal(
      {
        organizationSlug: 'allrice-platform',
        organizationName: 'Platform',
        workspaceSlug: 'default',
        workspaceName: 'Default',
        email: 'caller-admin@example.test',
        displayName: 'Admin',
        role: 'member',
      },
      f.db,
    );
    adminUser = principal.user.id;
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', principal.user.email);
  }, 120000);
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    await Promise.allSettled(pending.splice(0));
    for (const close of cleanup.splice(0).reverse()) await close();
  }, 30000);
  afterAll(async () => {
    try {
      if (f)
        expect(await f.close()).toMatchObject({
          schemaRemoved: true,
          storageRemoved: true,
          databaseClosed: true,
          adminClosed: true,
        });
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  }, 30000);

  async function admin() {
    const session = await createSession(adminUser);
    return {
      token: session.token,
      context: (await authenticateSession(session.token))!,
    };
  }
  async function memory() {
    const value = await createPersonalEmployeeMemory(owner, {
      instanceId,
      workspaceId: owner.workspaceId,
      idempotencyKey: randomUUID(),
      summary: 'Caller source',
      details: 'Exact personal body\nwith emoji: \ud83d\ude42',
    });
    const [row] = await f.db<
      { id: string; content: string; employee_id: string }[]
    >`
      select r.id,r.content,m.employee_id from allrice_memories m
      join allrice_memory_revisions r on r.memory_id=m.id and r.revision=m.revision
      where m.id=${value.id}`;
    if (!row) throw new Error('Original memory revision required');
    return { value, revision: row };
  }
  const content = (
    source: Awaited<ReturnType<typeof memory>>,
  ): CompanyAssetContent => ({
    kind: 'rule',
    title: 'Independent company wording',
    body: 'Authored company rule, not original memory bytes.',
    category: 'operations',
    appliesToEmployeeIds: [],
    taskKeywords: [],
    slots: [],
    sourceMemoryId: source.value.id,
    sourceMemoryRevisionId: source.revision.id,
  });
  async function save(
    context: RequestContext,
    source: Awaited<ReturnType<typeof memory>>,
    assetId = randomUUID(),
    signal?: AbortSignal,
  ) {
    return caller.mutateCompanyAsset(
      context,
      owner.organizationId,
      CompanyAssetMutationSchema.parse({
        operation: 'save',
        assetId,
        expectedRevision: 0,
        content: content(source),
      }),
      runtimeFixtureStorage(f.db),
      true,
      signal,
    );
  }
  function archive(source: Awaited<ReturnType<typeof memory>>) {
    return deleteManagedEmployeeMemory(
      owner,
      owner.workspaceId!,
      source.value.id,
      {
        instanceId: source.value.instanceId,
        expectedRevision: source.value.revision,
        pairDigest: memoryPairDigest(source.value),
        idempotencyKey: randomUUID(),
      },
    );
  }
  async function observer() {
    const sql = await f.db.reserve();
    cleanup.push(async () => {
      await sql.release();
    });
    return sql;
  }
  async function ownClient(idle_timeout?: number) {
    const value = process.env.ALLRICE_TEST_DATABASE_URL;
    if (!value) throw new Error('Dedicated fixture database required');
    const [settings] = await f.db<{ path: string }[]>`
      select current_setting('search_path') as path`;
    if (!settings?.path) throw new Error('Actual fixture search path required');
    const sql = postgres(value, {
      max: 1,
      idle_timeout,
      connection: {
        application_name: 'caller_dedicated_' + randomUUID(),
        search_path: settings.path,
      },
    });
    cleanup.push(async () => {
      try {
        await sql`drop table if exists caller_dedicated_probe`;
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
    await sql`create table caller_dedicated_probe(marker uuid primary key)`;
    return sql;
  }
  async function dedicatedEnded(sql: ReturnType<typeof postgres>, pid: number) {
    const [observer] = await sql<
      { pid: number }[]
    >`select pg_backend_pid() as pid`;
    expect(pid).toBeGreaterThan(0);
    expect(observer?.pid).not.toBe(pid);
    await expect
      .poll(
        async () => sql<{ pid: number }[]>`
      select pid from pg_stat_activity where pid=${pid}`,
      )
      .toEqual([]);
  }
  async function blockedBy(
    sql: Awaited<ReturnType<typeof observer>>,
    blocker: number,
  ) {
    const [observerIdentity] = await sql<
      { application_name: string; pid: number }[]
    >`select current_setting('application_name') as application_name,pg_backend_pid() as pid`;
    if (!observerIdentity?.application_name || observerIdentity.pid <= 0)
      throw new Error('Actual observer connection identity required');
    let pids: number[] = [];
    await expect
      .poll(async () => {
        const rows = await sql<
          { pid: number }[]
        >`select pid from pg_stat_activity
        where application_name=${observerIdentity.application_name} and pid<>${observerIdentity.pid}
          and ${blocker}=any(pg_blocking_pids(pid)) order by pid`;
        return (pids = rows.map((row) => row.pid));
      })
      .toHaveLength(1);
    const [pid] = pids;
    if (pid === undefined) throw new Error('Exactly one blocked PID required');
    expect(pid).toBeGreaterThan(0);
    return pid;
  }
  async function pauseRevision(assetId: string, deferred = false) {
    const key = 'caller-test:' + randomUUID();
    const name = 'caller_gate_' + randomUUID().replaceAll('-', '');
    const release = gate();
    const entered = gate<number>();
    releases.push(() => release.resolve());
    const holding = track(
      f.db.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${key},0))`;
        const [row] = await tx<
          { pid: number }[]
        >`select pg_backend_pid() as pid`;
        entered.resolve(row!.pid);
        await release.promise;
      }),
    );
    const pid = await entered.promise;
    // Test-only SQL barrier in this isolated schema, after source SHARE locks.
    await f.db
      .unsafe(`create function ${name}() returns trigger language plpgsql as $$
      begin if new.asset_id='${assetId}'::uuid then
        perform pg_advisory_xact_lock(hashtextextended('${key}',0));
      end if; return new; end $$`);
    await f.db.unsafe(
      deferred
        ? `create constraint trigger ${name} after insert on allrice_company_asset_revisions deferrable initially deferred for each row execute function ${name}()`
        : `create trigger ${name} before insert on allrice_company_asset_revisions for each row execute function ${name}()`,
    );
    cleanup.push(async () => {
      await f.db.unsafe(`drop function ${name}() cascade`);
    });
    return { pid, release: () => release.resolve(), holding };
  }

  it('saves a selected old confirmed revision and preserves independently authored body', async () => {
    const who = await admin();
    const source = await memory();
    await correctPersonalEmployeeMemory(
      owner,
      owner.workspaceId!,
      source.value.id,
      {
        instanceId: source.value.instanceId,
        expectedRevision: source.value.revision,
        pairDigest: memoryPairDigest(source.value),
        idempotencyKey: randomUUID(),
        summary: 'Current revision two',
        details: null,
        reason: 'Correct after selecting revision one',
      },
    );
    const listed = await caller.listCompanyRuleSources(
      who.context,
      owner.organizationId,
    );
    expect(
      listed.sources.find((row) => row.id === source.value.id)?.revision,
    ).toBe(2);
    const saved = await save(who.context, source);
    expect(saved.latest.content).toEqual(content(source));
    const [row] = await f.db<{ source_memory_revision_id: string }[]>`
      select source_memory_revision_id from allrice_company_asset_revisions where id=${saved.latest.id}`;
    expect(row?.source_memory_revision_id).toBe(source.revision.id);
  }, 30000);

  it('retains the existing fifty-row / SQL four-thousand-character list contract', async () => {
    const who = await admin();
    const source = await memory();
    // Fixture data only: no source-read authority or production writer is minted.
    await f.db`update allrice_memory_revisions set content=repeat('\ud83d\ude42',4001) where id=${source.revision.id}`;
    await f.db`insert into allrice_memories
      select (jsonb_populate_record(null::allrice_memories,
        to_jsonb(m)||jsonb_build_object('id',gen_random_uuid(),'created_at',clock_timestamp()))).*
      from allrice_memories m cross join generate_series(1,51) where m.id=${source.value.id}`;
    await f.db`insert into allrice_memory_revisions
      select (jsonb_populate_record(null::allrice_memory_revisions,
        to_jsonb(r)||jsonb_build_object('id',gen_random_uuid(),'memory_id',m.id))).*
      from allrice_memories m cross join allrice_memory_revisions r
      where r.id=${source.revision.id} and m.organization_id=${owner.organizationId}
        and not exists(select 1 from allrice_memory_revisions existing where existing.memory_id=m.id)`;
    const listed = await caller.listCompanyRuleSources(
      who.context,
      owner.organizationId,
    );
    expect(listed.sources).toHaveLength(50);
    expect(listed.sources.map((row) => row.content)).toEqual(
      Array(50).fill('\ud83d\ude42'.repeat(4000)),
    );
    const expected = await f.db<
      { id: string }[]
    >`select id from allrice_memories
      where organization_id=${owner.organizationId} order by created_at desc,id desc limit 50`;
    expect(listed.sources.map((row) => row.id)).toEqual(
      expected.map((row) => row.id),
    );
  }, 30000);

  it('rejects a revision whose owner archived it before caller admission', async () => {
    const who = await admin();
    const source = await memory();
    await archive(source);
    await expect(save(who.context, source)).rejects.toMatchObject({
      code: 'source_changed',
    });
  }, 30000);

  it('holds source SHARE locks until the actual outer save commits, then lets archive proceed', async () => {
    const who = await admin();
    const source = await memory();
    const id = randomUUID();
    const sql = await observer();
    const barrier = await pauseRevision(id);
    const saving = track(save(who.context, source, id));
    const callerPid = await blockedBy(sql, barrier.pid);
    const archiving = track(archive(source));
    expect(await blockedBy(sql, callerPid)).toBeGreaterThan(0);
    barrier.release();
    const saved = await saving;
    await archiving;
    expect(saved.latest.content).toEqual(content(source));
    const [row] = await f.db<{ count: number }[]>`select count(*)::int as count
      from allrice_company_asset_revisions where asset_id=${id}`;
    expect(row?.count).toBe(1);
  }, 30000);

  it('does not return on abort until blocked SQL and actual rollback settle, with no saved revision', async () => {
    const who = await admin();
    const source = await memory();
    const id = randomUUID();
    const sql = await observer();
    const barrier = await pauseRevision(id);
    const controller = new AbortController();
    const reason = new Error('cancel before commit');
    let finished = false;
    const saving = track(save(who.context, source, id, controller.signal));
    const observed = saving.catch((error: unknown) => {
      finished = true;
      return error;
    });
    await blockedBy(sql, barrier.pid);
    controller.abort(reason);
    await turn();
    expect(finished).toBe(false);
    barrier.release();
    expect(await observed).toBe(reason);
    const [row] = await f.db<{ count: number }[]>`select count(*)::int as count
      from allrice_company_asset_revisions where asset_id=${id}`;
    expect(row?.count).toBe(0);
  }, 30000);

  it('keeps a real commit result when cancellation arrives during the deferred commit barrier', async () => {
    const who = await admin();
    const source = await memory();
    const id = randomUUID();
    const sql = await observer();
    const barrier = await pauseRevision(id, true);
    const controller = new AbortController();
    const saving = track(save(who.context, source, id, controller.signal));
    const pid = await blockedBy(sql, barrier.pid);
    const [active] = await sql<
      { query: string }[]
    >`select query from pg_stat_activity where pid=${pid}`;
    expect(active?.query).toBe('commit');
    controller.abort(new Error('late cancellation'));
    barrier.release();
    const saved = await saving;
    expect(saved.id).toBe(id);
    const [row] = await f.db<{ count: number }[]>`select count(*)::int as count
      from allrice_company_asset_revisions where asset_id=${id}`;
    expect(row?.count).toBe(1);
  }, 30000);

  it('rejects revoked issuer first and makes later revocation wait for admitted rollback', async () => {
    const denied = await admin();
    const source = await memory();
    await revokeSession(denied.token);
    await expect(save(denied.context, source)).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    const who = await admin();
    const id = randomUUID();
    const sql = await observer();
    const barrier = await pauseRevision(id);
    const controller = new AbortController();
    const reason = new Error('admitted transaction cancelled');
    const saving = track(save(who.context, source, id, controller.signal));
    const observed = saving.catch((error: unknown) => error);
    const callerPid = await blockedBy(sql, barrier.pid);
    const revoking = track(revokeSession(who.token));
    expect(await blockedBy(sql, callerPid)).toBeGreaterThan(0);
    controller.abort(reason);
    barrier.release();
    expect(await observed).toBe(reason);
    await revoking;
  }, 30000);

  it('keeps personal current revision, scope and runtimePolicyDigest checks owner-local', async () => {
    const source = await memory();
    const ref: EmployeeContentReference = {
      sourceKind: 'experience',
      contentId: source.value.id,
      revisionId: source.revision.id,
      digest: runtimePolicyDigest({
        memoryId: source.value.id,
        revisionId: source.revision.id,
        revision: source.value.revision,
        content: source.revision.content,
      }),
    };
    await f.db.begin(async (tx) => {
      await requireContentMaintenance(
        owner,
        {
          scope: 'personal',
          organizationId: owner.organizationId,
          ownerId: owner.actor.id,
        },
        tx,
      );
      const employee = await getEmployeeInstance(
        owner,
        source.value.instanceId!,
        tx,
      );
      const sources = bindCallerSourceQueries(tx, {
        organizationId: owner.organizationId,
        workspaceId: owner.workspaceId!,
      });
      try {
        const input = {
          context: owner,
          employeeId: source.revision.employee_id,
          instanceId: employee.id,
          ownership: {
            scope: 'personal' as const,
            organizationId: owner.organizationId,
            ownerId: owner.actor.id,
          },
          ref,
          sql: tx,
          lock: true,
          allowDraft: false,
          callerSources: sources,
        };
        const exact = await resolveEmployeeContentSource(input);
        expect(exact.dto).toMatchObject({
          available: true,
          body: 'Caller source\nExact personal body\nwith emoji: \ud83d\ude42',
        });
        expect(
          (
            await resolveEmployeeContentSource({
              ...input,
              ref: {
                ...ref,
                digest:
                  'sha256:0000000000000000000000000000000000000000000000000000000000000000',
              },
            })
          ).issue?.code,
        ).toBe('source_changed');
        expect(
          (
            await resolveEmployeeContentSource({
              ...input,
              instanceId: randomUUID(),
            })
          ).dto.available,
        ).toBe(false);
        expect(
          (
            await resolveEmployeeContentSource({
              ...input,
              ownership: {
                scope: 'company',
                organizationId: owner.organizationId,
              },
            })
          ).issue?.code,
        ).toBe('source_scope_mismatch');
      } finally {
        await sources.close();
      }
    });
    await correctPersonalEmployeeMemory(
      owner,
      owner.workspaceId!,
      source.value.id,
      {
        instanceId: source.value.instanceId,
        expectedRevision: source.value.revision,
        pairDigest: memoryPairDigest(source.value),
        idempotencyKey: randomUUID(),
        summary: 'Changed current revision',
        details: null,
        reason: 'Old personal ref must stop',
      },
    );
    await f.db.begin(async (tx) => {
      const unavailable = await resolveEmployeeContentSource({
        context: owner,
        employeeId: source.revision.employee_id,
        instanceId: source.value.instanceId!,
        ownership: {
          scope: 'personal',
          organizationId: owner.organizationId,
          ownerId: owner.actor.id,
        },
        ref,
        sql: tx,
        lock: true,
        allowDraft: false,
      });
      expect(unavailable.dto).toEqual({
        reference: ref,
        available: false,
        ownership: null,
        canMaintain: false,
      });
      expect(unavailable.issue?.code).toBe('source_unavailable');
    });
  }, 30000);

  it('commits and rolls back on owned dedicated connections, then rejects closed handles', async () => {
    const sql = await ownClient(0.05),
      committed = randomUUID(),
      rejected = randomUUID();
    let saved: Sql | undefined,
      pid = 0;
    let lazy: PromiseLike<unknown> | undefined;
    const startedAt = performance.now();
    expect(
      await withDedicatedCallerTransaction(sql, async (tx) => {
        saved = tx;
        lazy = tx`insert into caller_dedicated_probe values(${randomUUID()})`;
        const [row] = await tx<
          { pid: number; xid: string }[]
        >`select pg_backend_pid() as pid,txid_current()::text as xid`;
        if (!row) throw new Error('Actual backend required');
        pid = row.pid;
        const elapsedMs = performance.now() - startedAt;
        expect(Number.isFinite(elapsedMs) && elapsedMs >= 0).toBe(true);
        console.info(
          JSON.stringify({
            metric: 'dedicated_scope_first_select_ms',
            elapsedMs,
            includes: 'client+connect/auth/TLS+BEGIN+first SELECT',
          }),
        );
        await tx`insert into caller_dedicated_probe values(${committed})`;
        await delay(100);
        expect(
          await tx`select pg_backend_pid() as pid,txid_current()::text as xid`,
        ).toEqual([row]);
        const fragment = tx`marker=${committed}`;
        expect(
          await tx`select marker from caller_dedicated_probe where ${fragment}`,
        ).toEqual([{ marker: committed }]);
        return committed;
      }),
    ).toBe(committed);
    await dedicatedEnded(sql, pid);
    let rejectedPid = 0;
    const failure = new Error('ordinary callback refusal');
    await expect(
      withDedicatedCallerTransaction(sql, async (tx) => {
        const [identity] = await tx<
          { pid: number }[]
        >`select pg_backend_pid() as pid`;
        if (!identity) throw new Error('Actual dedicated backend required');
        rejectedPid = identity.pid;
        await tx`insert into caller_dedicated_probe values(${rejected})`;
        throw failure;
      }),
    ).rejects.toBe(failure);
    await dedicatedEnded(sql, rejectedPid);
    if (!saved || !lazy) throw new Error('Actual callback handles required');
    const captured = saved;
    expect(() => captured`select 1`).toThrow('authorization_denied');
    await expect(Promise.resolve(lazy)).rejects.toThrow('authorization_denied');
    expect(
      await sql<
        { marker: string }[]
      >`select marker from caller_dedicated_probe`,
    ).toEqual([{ marker: committed }]);
    const [reused] = await sql<{ pid: number; xid: string | null }[]>`
      select pg_backend_pid() as pid,txid_current_if_assigned()::text as xid`;
    expect(reused?.xid).toBe(null);
    expect(reused?.pid).not.toBe(pid);
  }, 15000);

  it('rolls back a native UNDEFINED_VALUE build failure after a real write before ending its client', async () => {
    const sql = await ownClient(),
      marker = randomUUID();
    const [identity] = await sql<
      { pid: number; application_name: string }[]
    >`select pg_backend_pid() as pid,current_setting('application_name') as application_name`;
    if (!identity?.application_name || identity.pid <= 0)
      throw new Error('Actual owned backend identity required');
    let parameterFailure: unknown,
      scopePid = 0;
    const failure = await withDedicatedCallerTransaction(sql, async (tx) => {
      const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      if (!row) throw new Error('Actual dedicated backend required');
      scopePid = row.pid;
      await tx`insert into caller_dedicated_probe values(${marker})`;
      try {
        // Invalid runtime input through the public unsafe API, deliberately
        // outside its static parameter type; no private driver hooks or faults.
        await Reflect.apply(tx.unsafe, tx, ['select $1::text', [undefined]]);
      } catch (error) {
        parameterFailure = error;
        throw error;
      }
    }).catch((error: unknown) => error);
    expect(failure).toBe(parameterFailure);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(postgres.PostgresError);
    expect(failure).toMatchObject({ code: 'UNDEFINED_VALUE' });
    await dedicatedEnded(sql, scopePid);
    expect(await sql`select marker from caller_dedicated_probe`).toEqual([]);
    const [reused] = await sql<{ pid: number; xid: string | null }[]>`
      select pg_backend_pid() as pid,txid_current_if_assigned()::text as xid`;
    expect(reused).toEqual({ pid: identity.pid, xid: null });
  }, 15000);

  it('rolls back a received statement_timeout error before ending the dedicated client', async () => {
    const sql = await ownClient(),
      marker = randomUUID();
    let scopePid = 0;
    const failure = await withDedicatedCallerTransaction(sql, async (tx) => {
      const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      if (!row) throw new Error('Actual dedicated backend required');
      scopePid = row.pid;
      await tx`insert into caller_dedicated_probe values(${marker})`;
      await tx`set local statement_timeout='30ms'`;
      await tx`select pg_sleep(5)`;
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(postgres.PostgresError);
    expect(failure).toMatchObject({ code: '57014', severity: 'ERROR' });
    await dedicatedEnded(sql, scopePid);
    expect(await sql`select marker from caller_dedicated_probe`).toHaveLength(
      0,
    );
    const [reused] = await sql<{ timeout: string }[]>`
      select current_setting('statement_timeout') as timeout`;
    expect(reused?.timeout).toBe('0');
  }, 15000);

  it('joins real Storage after caller abort without blocking an independent client', async () => {
    const sql = await ownClient(),
      marker = randomUUID();
    const entered = gate(),
      release = gate();
    releases.push(() => release.resolve());
    const controller = new AbortController(),
      reason = new Error('abort during actual Storage');
    const bytes = Buffer.from('Reserved actual Storage 中文🙂');
    const workspaceId = owner.workspaceId;
    if (!workspaceId) throw new Error('Actual fixture workspace required');
    const object = {
      id: marker,
      organizationId: owner.organizationId,
      workspaceId,
      ownerId: owner.actor.id,
      key: makeObjectKey({
        organizationId: owner.organizationId,
        workspaceId,
        ownerId: owner.actor.id,
        category: 'uploads',
        objectId: marker,
      }),
      checksum: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      mediaType: 'text/plain',
      sizeBytes: bytes.length,
      retentionUntil: null,
      deletedAt: null,
      immutable: false,
    };
    const storage = runtimeFixtureStorage(f.db);
    let finished = false,
      scopePid = 0;
    const saving = track(
      withDedicatedCallerTransaction(
        sql,
        async (tx) => {
          const [row] = await tx<
            { pid: number }[]
          >`select pg_backend_pid() as pid`;
          if (!row) throw new Error('Actual dedicated backend required');
          scopePid = row.pid;
          await tx`insert into caller_dedicated_probe values(${marker})`;
          await (async () => {
            await storage.put(
              object,
              new Blob(['Reserved actual Storage 中文🙂']).stream(),
            );
            entered.resolve();
            await release.promise;
          })();
          expect(() => tx`select forbidden`).toThrow(reason);
        },
        controller.signal,
      ),
    );
    const observed = saving.catch((error: unknown) => {
      finished = true;
      return error;
    });
    await entered.promise;
    controller.abort(reason);
    await turn();
    expect(finished).toBe(false);
    const [independent] = await f.db<{ ok: number }[]>`select 1::int as ok`;
    expect(independent).toEqual({ ok: 1 });
    release.resolve();
    expect(await observed).toBe(reason);
    await dedicatedEnded(sql, scopePid);
    expect(await sql`select marker from caller_dedicated_probe`).toHaveLength(
      0,
    );
    expect(
      Buffer.from(await new Response(await storage.get(object)).arrayBuffer()),
    ).toEqual(bytes);
    await storage.delete(object);
  }, 15000);

  it('binds G5 to the physical caller transaction and returns query before commit without fabricating a zero fact', async () => {
    const releaseTable = gate();
    const tablePid = gate<number>();
    const releaseCaller = gate();
    const queryDone = gate<unknown>();
    releases.push(
      () => releaseTable.resolve(),
      () => releaseCaller.resolve(),
    );
    track(
      f.db.begin(async (tx) => {
        await tx`lock table allrice_employee_runs in access exclusive mode`;
        const [row] = await tx<
          { pid: number }[]
        >`select pg_backend_pid() as pid`;
        tablePid.resolve(row!.pid);
        await releaseTable.promise;
      }),
    );
    const blocker = await tablePid.promise;
    let callerPid = 0;
    const sql = await observer();
    let work: Promise<void> | undefined;
    const transaction = f.db.begin((tx) => {
      work = (async () => {
        await requireContentMaintenance(
          owner,
          {
            scope: 'personal',
            organizationId: owner.organizationId,
            ownerId: owner.actor.id,
          },
          tx,
        );
        const [row] = await tx<
          { pid: number }[]
        >`select pg_backend_pid() as pid`;
        callerPid = row!.pid;
        const sources = bindCallerSourceQueries(tx, {
          organizationId: owner.organizationId,
          workspaceId: owner.workspaceId!,
        });
        try {
          queryDone.resolve(
            await sources.classifyMemoryOrigin({
              sourceType: 'message',
              sourceId: randomUUID(),
            }),
          );
          await releaseCaller.promise;
        } finally {
          await sources.close();
        }
      })();
      return work;
    });
    let ended = false;
    track(
      joinCallerSave(transaction, () => work).then(() => {
        ended = true;
      }),
    );
    expect(await blockedBy(sql, blocker)).toBe(callerPid);
    releaseTable.resolve();
    expect(await queryDone.promise).toEqual({
      sourceCheck: 'checked',
      excludedByMethodAuthoring: false,
    });
    expect(ended).toBe(false);
    releaseCaller.resolve();
  }, 30000);
});
