import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type TransactionSql } from 'postgres';
import * as client from './core/client.ts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { assertRuntimeFixtureDatabase } from './runtime-fixture-database.ts';
import { createRunAuthorityFixture } from './run-authority.fixture.ts';
import { authenticateSession, createSession } from './identity.ts';
import { ensureGeneralEmployeeInstance } from './employees/employee-instances.ts';
import { freezeEmployeeDocuments } from './employees/employee-documents.ts';
import {
  prepareRunMemoryContext,
  assertRunMemoryContextCurrent,
  type RunMemoryAuthority,
} from './run-memory-context.ts';
import { readRunExperienceSource } from './run-experience-source.ts';
import {
  createPersonalEmployeeMemory,
  correctPersonalEmployeeMemory,
  createTraceableMemory,
  deleteWorkspaceMemory,
} from './workspace/service.ts';
import {
  legacyPersonalMemoryPair,
  memoryContentDigest,
  memoryPairDigest,
} from './workspace/employee-memory.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const migration = await readFile(
  new URL('../migrations/0236_employee_memory_pairs.sql', import.meta.url),
  'utf8',
);
async function personaCompatibility(db: ReturnType<typeof postgres>) {
  return db`select
    pg_get_functiondef('allrice_native_session_version_compatible(jsonb,jsonb)'::regprocedure) definition,
    allrice_native_session_version_compatible(
      '{"schemaVersion":2,"contextKind":"chat","sourcePolicy":{"family":"allrice_declarative_employee_v1"},"distributionGeneration":"dsh-0.2.1-rc.2-687f282"}'::jsonb,
      '{"schemaVersion":2,"runtimePolicy":{"harness":"dsh"},"runtimePackage":{"schemaVersion":3,"runtimeManifest":{"distributionGeneration":"dsh-0.2.1-rc.2-687f282"}}}'::jsonb
    ) schema3`;
}
suite(
  '0236: isolated old data, atomic refusal and forward-compatible recovery',
  () => {
    let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let runtimeDb: ReturnType<typeof postgres> | undefined;
    let f: Awaited<ReturnType<typeof createRunAuthorityFixture>>;
    let context: NonNullable<Awaited<ReturnType<typeof authenticateSession>>>;
    let auth: RunMemoryAuthority;
    let shortId: string, longId: string, archivedId: string, rawId: string;
    let before: Record<string, unknown>[];
    let frozen: Awaited<ReturnType<typeof freezeEmployeeDocuments>>;
    let runState: unknown;
    let compatibility: Awaited<ReturnType<typeof personaCompatibility>>;
    const original = '🧑'.repeat(39) + '\n原始条件：月结前不得外发。';
    async function seed(tx: TransactionSql, content: string, archived = false) {
      const id = randomUUID();
      await tx`insert into allrice_memories(id,organization_id,workspace_id,employee_id,owner_id,instance_id,content,source_type,
      lifecycle_state,trust_level,captured_at,expires_at,updated_at,archived_at,metadata)
      values(${id},${f.org},${f.workspace},${f.employee},${f.user},${f.assignment},${content},'user',
        'durable','user_confirmed',now()-interval '2 days',now()+interval '1 day',now()-interval '1 day',
        ${archived ? new Date() : null},'{"memoryPinOrder":1}')`;
      await tx`insert into allrice_memory_revisions(organization_id,workspace_id,memory_id,revision,content,trust_level,
      lifecycle_state,memory_class,confidence,expires_at,reason,changed_by,changed_at)
      select organization_id,workspace_id,id,revision,content,trust_level,lifecycle_state,memory_class,confidence,
        expires_at,'synthetic old revision',owner_id,updated_at from allrice_memories where id=${id}`;
      return id;
    }
    beforeAll(async () => {
      fixture = await createRuntimeFixtureDatabase({
        ownSchemaOnly: true,
        throughMigration: '0235_persona_runtime_package_compatibility.sql',
      });
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      compatibility = await personaCompatibility(fixture.db);
      expect(compatibility[0]!.schema3).toBe(true);
      f = await createRunAuthorityFixture(fixture.db, {
        toolNames: ['workspace.memory.search', 'workspace.experience.read'],
        allowedTools: ['workspace.memory.search', 'workspace.experience.read'],
      });
      await ensureGeneralEmployeeInstance(fixture.db, f.assignment);
      context = (await authenticateSession(
        (await createSession(f.user)).token,
        { organizationId: f.org, workspaceId: f.workspace },
      ))!;
      await fixture.db.begin(async (tx) => {
        shortId = await seed(tx, '日报不得外发');
        longId = await seed(tx, original);
        archivedId = await seed(tx, '已删除仍保留', true);
        rawId = await seed(tx, '原始来源'.repeat(1000));
        await tx`update allrice_memories set employee_id=null where id=${rawId}`;
        const [run] =
          await tx`select user_message_id from allrice_employee_runs where run_id=${f.rootRunId}`;
        await tx`insert into allrice_experience_reviews(memory_id,organization_id,workspace_id,owner_id,client_request_id,
        request_digest,run_id,session_id,message_id,source_excerpt,source_digest,proposed_digest,requested_scope,share_acknowledged)
        values(${rawId},${f.org},${f.workspace},${f.user},${randomUUID()},${memoryContentDigest('request')},
          ${f.rootRunId},${f.session},${run!.user_message_id},'synthetic raw source',${memoryContentDigest('source')},
          ${memoryContentDigest('proposed')},'private',false)`;
      });
      before = await fixture.db`select id,to_jsonb(m) as memory,
      (select to_jsonb(r) from allrice_memory_revisions r where memory_id=m.id and revision=1) as revision
      from allrice_memories m order by id`;
      const scope = {
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        runId: f.rootRunId,
        sessionId: f.session,
      };
      const [job] =
        await fixture.db`select attempt from allrice_jobs where id=${f.worker.jobId}`;
      auth = {
        scope,
        worker: { ...f.worker, attempt: job!.attempt as number },
      };
      frozen = await freezeEmployeeDocuments(
        fixture.db,
        { ...scope, instanceId: f.assignment },
        {},
        true,
      );
      await fixture.db`update allrice_employee_runs set status='running',memory_context_state='{"schemaVersion":1,"pending":true}' where run_id=${f.rootRunId}`;
      await prepareRunMemoryContext(
        auth,
        frozen.memories,
        frozen.employeeDocuments.memory,
      );
      [runState] =
        await fixture.db`select memory_context_state from allrice_employee_runs where run_id=${f.rootRunId}`;
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      try {
        await runtimeDb?.end({ timeout: 5 });
      } finally {
        await fixture?.close();
      }
    });
    it.each([
      ['over2000', 'long'],
      ['invalidDerivedPair', 'blank'],
      ['scopeAnomalies', 'scope'],
      ['expired', 'expired'],
      ['overActiveLimitScopes', 'limit'],
      ['legacyReadableReview', 'review'],
      ['missingCurrentRevision', 'revision'],
    ])(
      'aborts %s atomically and preserves old rows, revisions and frozen Run',
      async (key, fault) => {
        await expect(
          fixture.db.begin(async (tx) => {
            if (fault === 'long')
              await tx`update allrice_memories set content=repeat('🧑',2001) where id=${shortId}`;
            if (fault === 'blank')
              await tx`update allrice_memories set content=E' \n\t' where id=${shortId}`;
            if (fault === 'scope')
              await tx`update allrice_memories set employee_id=null where id=${shortId}`;
            if (fault === 'expired')
              await tx`update allrice_memories set expires_at=now()-interval '1 day' where id=${shortId}`;
            if (fault === 'limit')
              for (let i = 0; i < 100; i++) await seed(tx, '生效名额');
            if (fault === 'review')
              await tx`update allrice_experience_reviews set status='approved',reviewed_by=${f.user},reviewed_at=now(),review_reason='synthetic' where memory_id=${rawId}`;
            if (fault === 'revision')
              await tx`delete from allrice_memory_revisions where memory_id=${shortId}`;
            await tx.unsafe(migration);
          }),
        ).rejects.toMatchObject({
          code: '23514',
          message: 'employee_memory_pair_preflight_failed',
          detail: expect.stringMatching(new RegExp(`"${key}": [1-9]`)),
        });
        const [columns] =
          await fixture.db`select count(*)::int count from pg_attribute where attrelid='allrice_memories'::regclass and attname in ('summary','details') and not attisdropped`;
        expect(columns!.count).toBe(0);
        expect(await personaCompatibility(fixture.db)).toEqual(compatibility);
        expect(
          await fixture.db`select id,to_jsonb(m) as memory,
      (select to_jsonb(r) from allrice_memory_revisions r where memory_id=m.id and revision=1) as revision
      from allrice_memories m order by id`,
        ).toEqual(before);
        expect(
          (
            await fixture.db`select memory_context_state from allrice_employee_runs where run_id=${f.rootRunId}`
          )[0],
        ).toEqual(runState);
      },
    );
    it('mechanically preserves old content, revisions, raw review, ordering and v1 pins while appending a system revision', async () => {
      const [rawBefore] =
        await fixture.db`select to_jsonb(er) value from allrice_experience_reviews er where memory_id=${rawId}`;
      await fixture.db.begin((tx) => tx.unsafe(migration));
      expect(await personaCompatibility(fixture.db)).toEqual(compatibility);
      const rows = await fixture.db<
        { value: Record<string, unknown> & { id: string; content: string } }[]
      >`select to_jsonb(m) value from allrice_memories m order by id`;
      for (const old of before) {
        const saved = rows.find((row) => row.value.id === old.id)!.value;
        const { summary, details, ...oldColumns } = saved;
        const oldMemory = old.memory as Record<string, unknown>;
        if (saved.id === rawId) {
          expect(oldColumns).toEqual(oldMemory);
          expect({ summary, details }).toEqual({
            summary: null,
            details: null,
          });
        } else {
          expect(oldColumns).toEqual({
            ...oldMemory,
            revision: 2,
            expires_at: saved.id === archivedId ? oldMemory.expires_at : null,
          });
          expect({ summary, details }).toEqual(
            legacyPersonalMemoryPair(saved.content as string),
          );
        }
        const [revision] =
          await fixture.db`select to_jsonb(r)-'summary'-'details' value from allrice_memory_revisions r where memory_id=${saved.id} and revision=1`;
        expect(revision!.value).toEqual(old.revision);
      }
      const [rawAfter] =
        await fixture.db`select to_jsonb(er) value from allrice_experience_reviews er where memory_id=${rawId}`;
      expect(rawAfter).toEqual(rawBefore);
      const [long] =
        await fixture.db`select * from allrice_memories where id=${longId}`;
      expect(long).toMatchObject({
        content: original,
        summary: '🧑'.repeat(39),
        details: original,
        revision: 2,
      });
      const [migrated] =
        await fixture.db`select metadata from allrice_audit_events where action='memory.migrate_pair' and resource_id=${longId}`;
      expect(migrated!.metadata.pairDigest).toBe(
        memoryPairDigest(legacyPersonalMemoryPair(original)),
      );
      expect(migrated!.metadata.migration).toBe(
        '0236_employee_memory_pairs.sql',
      );
      const [systemRevision] =
        await fixture.db`select reason from allrice_memory_revisions where memory_id=${longId} and revision=2`;
      expect(systemRevision!.reason).toBe(
        'system:0236_employee_memory_pairs from revision 1',
      );
      const [counts] = await fixture.db`select
      (select count(*)::int from allrice_memory_revisions where memory_id=any(${[shortId, longId, archivedId]}::uuid[])) revisions,
      (select count(*)::int from allrice_audit_events where action='memory.migrate_pair' and actor_id is null) migrations,
      (select count(*)::int from allrice_audit_events where action='memory.delete') deletes`;
      expect(counts).toEqual({ revisions: 6, migrations: 3, deletes: 0 });
      expect(
        (
          await fixture.db`select memory_context_state from allrice_employee_runs where run_id=${f.rootRunId}`
        )[0],
      ).toEqual(runState);
      await assertRunMemoryContextCurrent(auth.scope);
      for (const pin of frozen.memories)
        expect(
          (await readRunExperienceSource(auth, pin.sourceHandle!)).items[0],
        ).toMatchObject({ memory: { content: pin.content } });
      expect(
        (
          await fixture.db`select memory_context_state from allrice_employee_runs where run_id=${f.rootRunId}`
        )[0],
      ).not.toEqual(runState);
      // Source reads spend the existing budget. Migration itself left its frozen state untouched.
    });
    it('keeps post-migration create/edit/delete/candidate writes and old revisions during forward recovery; stale compensation cannot overwrite an edit', async () => {
      // Only this fully migrated runtime phase needs public's pgvector types.
      // Preflight, migration and historical assertions retain the own-only pool.
      const [owned] =
        await fixture.db`select current_schema() schema,current_schemas(false) path,
        array_agg(c.relname::text order by c.relname) names,array_agg(c.oid order by c.relname) oids
        from pg_class c where c.relnamespace=current_schema()::regnamespace and c.relkind in ('r','p','v','m','f')`;
      expect(owned!.schema).toMatch(/^p25_[a-f0-9]{32}$/);
      expect(owned!.path).toEqual([owned!.schema]);
      expect(owned!.names).toContain('allrice_memories');
      expect(owned!.names).toContain('allrice_rag_chunks');
      const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
      assertRuntimeFixtureDatabase(url);
      url.searchParams.set('options', `-csearch_path=${owned!.schema},public`);
      runtimeDb = postgres(url.toString(), {
        max: 1,
        connect_timeout: 5,
        onnotice: () => {},
        connection: {
          application_name: `memory-pair-recovery-${owned!.schema}`,
        },
      });
      const [visible] =
        await runtimeDb`select current_schema() schema,current_schemas(false) path,
        array(select to_regclass(r.name)::oid from unnest(${owned!.names}::text[]) with ordinality r(name,ord) order by ord) oids,
        to_regtype('vector')::oid vector_type,
        (select atttypid from pg_attribute where attrelid='allrice_rag_chunks'::regclass and attname='embedding') embedding_type`;
      expect(visible).toMatchObject({
        schema: owned!.schema,
        path: [owned!.schema, 'public'],
        oids: owned!.oids,
        vector_type: expect.any(Number),
      });
      expect(visible!.vector_type).toBe(visible!.embedding_type);
      vi.spyOn(client, 'getDatabase').mockReturnValue(runtimeDb);
      const created = await createPersonalEmployeeMemory(context, {
        workspaceId: f.workspace,
        instanceId: f.assignment,
        idempotencyKey: randomUUID(),
        summary: '迁移后新增',
        details: '新数据不得丢失',
      });
      const edited = await correctPersonalEmployeeMemory(
        context,
        f.workspace,
        created.id,
        {
          instanceId: f.assignment,
          expectedRevision: created.revision,
          pairDigest: created.pairDigest,
          idempotencyKey: randomUUID(),
          summary: '迁移后本人修改',
          details: created.details,
          reason: '本人修改',
        },
      );
      await expect(
        correctPersonalEmployeeMemory(context, f.workspace, created.id, {
          instanceId: f.assignment,
          expectedRevision: created.revision,
          pairDigest: created.pairDigest,
          idempotencyKey: randomUUID(),
          summary: created.summary,
          details: null,
          reason: '过时补偿不得覆盖',
        }),
      ).rejects.toThrow('employee_memory_conflict');
      const candidate = await createTraceableMemory(context, {
        workspaceId: f.workspace,
        instanceId: f.assignment,
        idempotencyKey: randomUUID(),
        sourceType: 'user',
        lifecycleState: 'candidate',
        content: '迁移后待确认',
      });
      await deleteWorkspaceMemory(context, f.workspace, created.id, {
        instanceId: f.assignment,
        expectedRevision: edited.revision,
        contentDigest: memoryContentDigest(
          `${edited.summary}\n${edited.details}`,
        ),
        idempotencyKey: randomUUID(),
      });
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      const [saved] =
        await fixture.db`select summary,details,revision,archived_at from allrice_memories where id=${created.id}`;
      expect(saved).toMatchObject({
        summary: edited.summary,
        details: edited.details,
        revision: 3,
        archived_at: expect.any(Date),
      });
      const [pending] =
        await fixture.db`select summary,lifecycle_state,revision from allrice_memories where id=${candidate.id}`;
      expect(pending).toMatchObject({
        summary: '迁移后待确认',
        lifecycle_state: 'candidate',
        revision: 1,
      });
      const [history] =
        await fixture.db`select count(*)::int count from allrice_memory_revisions where memory_id=${created.id}`;
      expect(history!.count).toBe(3);
      await assertRunMemoryContextCurrent(auth.scope);
      for (const pin of frozen.memories)
        expect(
          (await readRunExperienceSource(auth, pin.sourceHandle!)).items[0],
        ).toMatchObject({ memory: { content: pin.content } });
    });
  },
);
