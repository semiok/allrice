import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TransactionSql } from 'postgres';
import * as client from './core/client.ts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createRunAuthorityFixture } from './run-authority.fixture.ts';
import { ensureGeneralEmployeeInstance } from './employees/employee-instances.ts';
import {
  memoryContentDigest,
  memoryPairDigest,
} from './workspace/employee-memory.ts';

// Oracle for the immutable 0236 migration; this is not a runtime compatibility adapter.
const historicalPair = (content: string) => ({
  summary: Array.from(content)
    .slice(0, 40)
    .join('')
    .replace(/[\r\n\u2028\u2029]/gu, ' ')
    .trim(),
  details: Array.from(content).length > 40 ? content : null,
});
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const migration = await readFile(
  new URL('../migrations/0236_employee_memory_pairs.sql', import.meta.url),
  'utf8',
);
async function personaCompatibility(
  db: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>['db'],
) {
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
    let f: Awaited<ReturnType<typeof createRunAuthorityFixture>>;
    let shortId: string, longId: string, archivedId: string, rawId: string;
    let before: Record<string, unknown>[];
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
      await fixture.db`update allrice_employee_runs set status='running',memory_context_state='{"schemaVersion":1,"pending":true}' where run_id=${f.rootRunId}`;
      [runState] =
        await fixture.db`select memory_context_state from allrice_employee_runs where run_id=${f.rootRunId}`;
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      await fixture?.close();
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
            historicalPair(saved.content as string),
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
        memoryPairDigest(historicalPair(original)),
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
    });
  },
);
