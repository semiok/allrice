import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Sql } from 'postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createCompletedRunFixture } from './completed-run.fixture.ts';
import { createEmployeeAdministrationFixture } from './employee-administration.fixture.ts';
import { runtimePolicyDigest } from './runtime-policy-digest.ts';
import * as client from './core/client.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
const retirement = '0244_retire_legacy_memory_experience.sql';
const sqlFor = (file: string) =>
  readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
const snapshot = (db: Sql, table: string) =>
  db.unsafe(
    `select to_jsonb(t) value from ${table} t order by to_jsonb(t)::text`,
  );
const dropped = [
  'allrice_experience_reviews',
  'allrice_experience_coverage_reassessments',
  'allrice_brand_content_experiences',
  'allrice_brand_content_experience_uses',
  'allrice_rag_chunks',
];
async function historical() {
  const f = await createRuntimeFixtureDatabase({
    ownSchemaOnly: true,
    throughMigration: '0239_workbench_file_favorites.sql',
  });
  const mock = vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
  try {
    for (const name of [
      '0240_memory_source_storage.sql',
      '0241_retire_legacy_tools_skills.sql',
    ])
      await f.db.begin(async (tx) => {
        await tx.unsafe(await sqlFor(name));
      });
    const current = await createCompletedRunFixture(f.db);
    await f.db`update allrice_employee_runs set memory_context_state=null where run_id=${current.run}`;
    // Read the real persisted binding; session response shapes do not supply authority.
    const [bound] =
      await f.db`select a.employee_id,i.id instance_id from allrice_employee_runs r
      join allrice_employee_assignments a on a.id=r.employee_assignment_id
      join allrice_employee_instances i on i.assignment_id=a.id and i.owner_id=r.owner_id where r.run_id=${current.run}`;
    if (!bound) throw Error('synthetic current instance missing');
    return {
      ...f,
      current,
      employeeId: bound.employee_id as string,
      instanceId: bound.instance_id as string,
      async close() {
        mock.mockRestore();
        await f.close();
      },
    };
  } catch (error) {
    mock.mockRestore();
    await f.close();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof historical>>;
async function memory(
  f: Fixture,
  kind: 'v1' | 'backfill' | 'reconfirmed' | 'v2' | 'ambiguous' | 'legacy_api',
) {
  const db = f.db,
    id = randomUUID(),
    c = f.current;
  const summary = kind === 'v1' ? null : `Synthetic ${kind}`,
    details = null;
  const revision = kind === 'backfill' ? 2 : kind === 'reconfirmed' ? 3 : 1;
  await db`insert into allrice_memories(id,organization_id,workspace_id,owner_id,employee_id,instance_id,content,summary,details,
    visibility,source_type,lifecycle_state,memory_class,revision,trust_level,confidence)
    values(${id},${c.org},${c.workspace},${c.user},${f.employeeId},${f.instanceId},'Synthetic stored body',${summary},${details},
      'private','user','durable','work_note',${revision},'user_confirmed',1)`;
  for (let r = 1; r <= revision; r++) {
    const pairSummary =
      r === revision ? summary : r === 2 ? 'Synthetic backfill' : null;
    await db`insert into allrice_memory_revisions(organization_id,workspace_id,memory_id,revision,content,summary,details,
      trust_level,lifecycle_state,memory_class,confidence,reason,changed_by)
      values(${c.org},${c.workspace},${id},${r},'Synthetic stored body',${pairSummary},null,'user_confirmed','durable','work_note',1,
        ${r === 2 ? 'system:0236_employee_memory_pairs from revision 1' : 'Synthetic owner revision'},${c.user})`;
    if (r === 2)
      await db`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
      values(${c.org},${c.workspace},null,'memory.migrate_pair','memory',${id},'recorded','system_backfill',
        ${db.json({
          migration: '0236_employee_memory_pairs.sql',
          previousRevision: 1,
          revision: 2,
          pairDigest: runtimePolicyDigest({
            version: 2,
            summary: pairSummary,
            details: null,
          }),
        })})`;
  }
  if (['v2', 'reconfirmed', 'legacy_api'].includes(kind)) {
    const response =
      kind === 'legacy_api'
        ? {
            id,
            revision,
            content: 'Synthetic stored body',
            contentDigest: runtimePolicyDigest('old'),
          }
        : {
            id,
            revision,
            ownerId: c.user,
            instanceId: f.instanceId,
            summary,
            details,
            pairDigest: runtimePolicyDigest({ version: 2, summary, details }),
          };
    await db`insert into allrice_employee_memory_operations(organization_id,workspace_id,owner_id,instance_id,operation_key,operation,
      request_digest,memory_id,response) values(${c.org},${c.workspace},${c.user},${f.instanceId},${id},${kind === 'reconfirmed' ? 'correct' : 'create'},
        ${runtimePolicyDigest(response)},${id},${db.json(response)})`;
  }
  return id;
}
async function brand(f: Fixture, memoryId: string) {
  const db = f.db,
    c = f.current,
    brandId = randomUUID(),
    contextId = randomUUID(),
    feedbackId = randomUUID(),
    reportId = randomUUID();
  await db.begin(async (tx) => {
    await tx`insert into allrice_brand_content_brands(id,organization_id,workspace_id,owner_id,instance_id,name,revision,current_context_id)
      values(${brandId},${c.org},${c.workspace},${c.user},${f.instanceId},'Synthetic brand',1,${contextId})`;
    await tx`insert into allrice_brand_content_contexts(id,organization_id,workspace_id,owner_id,instance_id,brand_id,number,brand_name,content,digest)
      values(${contextId},${c.org},${c.workspace},${c.user},${f.instanceId},${brandId},1,'Synthetic brand','{}',${runtimePolicyDigest({})})`;
  });
  await db`insert into allrice_brand_content_feedback(id,organization_id,workspace_id,owner_id,instance_id,brand_id,context_id,content,digest,publication_key)
    values(${feedbackId},${c.org},${c.workspace},${c.user},${f.instanceId},${brandId},${contextId},'{}',${runtimePolicyDigest({})},${feedbackId})`;
  await db`insert into allrice_brand_content_retrospectives(id,organization_id,workspace_id,owner_id,instance_id,brand_id,context_id,platform,feedback_ids,
    output,source_text,run_id,session_id,workflow) values(${reportId},${c.org},${c.workspace},${c.user},${f.instanceId},${brandId},${contextId},'Synthetic',
      ${[feedbackId]},'{}','Synthetic review result',${c.run},${c.session.id},'{}')`;
  await db`insert into allrice_brand_content_experiences(memory_id,organization_id,workspace_id,owner_id,instance_id,brand_id,retrospective_id,context_id,platform)
    values(${memoryId},${c.org},${c.workspace},${c.user},${f.instanceId},${brandId},${reportId},${contextId},'Synthetic')`;
  await db`insert into allrice_brand_content_experience_uses(organization_id,workspace_id,owner_id,instance_id,brand_id,entity_id,memory_id,revision,digest,reason)
    values(${c.org},${c.workspace},${c.user},${f.instanceId},${brandId},${randomUUID()},${memoryId},1,${runtimePolicyDigest('synthetic')},'Synthetic use')`;
}
async function migrate(db: Sql) {
  await db.begin(async (tx) => {
    await tx.unsafe(await sqlFor(retirement));
  });
}
suite(
  '0244 legacy memory/experience deletion with current V2 and A1 preservation',
  () => {
    let f: Fixture | undefined;
    afterEach(async () => {
      await f?.close();
      f = undefined;
    });
    it('deletes proven V1/backfilled/brand records and old Runs, retaining exact current pairs, receipts, sources and brand feedback', async () => {
      f = await historical();
      const db = f.db,
        c = f.current;
      const old = await memory(f, 'v1'),
        backfill = await memory(f, 'backfill'),
        oldApi = await memory(f, 'legacy_api');
      const retained = [
        await memory(f, 'v2'),
        await memory(f, 'reconfirmed'),
        await memory(f, 'ambiguous'),
      ];
      await brand(f, old);
      await db`insert into allrice_experience_reviews(memory_id,organization_id,workspace_id,owner_id,client_request_id,request_digest,run_id,session_id,
      message_id,source_excerpt,source_digest,proposed_digest,requested_scope,share_acknowledged)
      values(${old},${c.org},${c.workspace},${c.user},${randomUUID()},${runtimePolicyDigest('request')},${c.run},${c.session.id},${c.message},
        'Synthetic legacy source',${runtimePolicyDigest('source')},${runtimePolicyDigest('memory')},'private',false)`;
      const legacy = await createCompletedRunFixture(db);
      const platform = await createEmployeeAdministrationFixture(db),
        validationId = randomUUID();
      await db`insert into allrice_platform_employee_test_runs(id,employee_id,revision_id,requested_by_label,status,input,purpose,experience_binding)
      values(${validationId},${platform.employeeId},${platform.revisionId},'Synthetic historical validation','failed','{}','experience_validation','{"schemaVersion":1}')`;
      const automationId = randomUUID(),
        occurrenceId = randomUUID();
      await db`insert into allrice_automations(id,organization_id,workspace_id,owner_id,name,prompt,trigger_type,schedule,status,conversation_mode,
      employee_assignment_id,next_run_at,experience_binding) select ${automationId},${c.org},${c.workspace},${c.user},'Synthetic legacy automation','Synthetic',
      'schedule','{"frequency":"weekly","weekday":1,"time":"10:00","timezone":"UTC"}','enabled','new_each_run',employee_assignment_id,clock_timestamp(),
      ${db.json({ schemaVersion: 1, instanceId: f.instanceId, policyDigest: runtimePolicyDigest('policy') })} from allrice_employee_runs where run_id=${c.run}`;
      await db`insert into allrice_automation_runs(id,organization_id,workspace_id,automation_id,scheduled_for,status)
      values(${occurrenceId},${c.org},${c.workspace},${automationId},clock_timestamp(),'succeeded')`;
      const sourceId = randomUUID();
      await db`insert into allrice_memory_sources(id,organization_id,workspace_id,owner_id,employee_id,instance_id,capture_run_id,run_id,session_id,message_id,
      source_key,source_excerpt,source_digest,evidence) values(${sourceId},${c.org},${c.workspace},${c.user},${f.employeeId},${f.instanceId},${c.run},${c.run},
      ${c.session.id},${c.message},${runtimePolicyDigest('key')},'Synthetic current unconfirmed material',${runtimePolicyDigest('source')},'{"schemaVersion":2}')`;
      await db`insert into allrice_settings(scope_type,scope_id,key,value) values('organization',${c.org},'employee_memory_source_policy','{"schemaVersion":2,"enabled":false}')`;
      const preserved = [
        'allrice_memory_sources',
        'allrice_brand_content_brands',
        'allrice_brand_content_contexts',
        'allrice_brand_content_feedback',
        'allrice_brand_content_retrospectives',
        'allrice_knowledge_sources',
        'allrice_knowledge_chunks',
      ];
      const before = await Promise.all(preserved.map((t) => snapshot(db, t)));
      const pairs =
        await db`select to_jsonb(m) value from allrice_memories m where id in ${db(retained)} order by id`;
      const revisions =
        await db`select to_jsonb(r) value from allrice_memory_revisions r where memory_id in ${db(retained)} order by id`;
      const operations =
        await db`select to_jsonb(o) value from allrice_employee_memory_operations o where memory_id in ${db(retained)} order by memory_id`;
      const monthly =
        await db`select proname,pg_get_functiondef(p.oid) definition from pg_proc p where pronamespace=current_schema()::regnamespace and proname like 'allrice_ordinary_monthly_%' order by proname`;
      await migrate(db);
      expect(
        await db`select id from allrice_memories where id in ${db([old, backfill, oldApi])}`,
      ).toEqual([]);
      expect(
        await db`select to_jsonb(m) value from allrice_memories m where id in ${db(retained)} order by id`,
      ).toEqual(pairs);
      expect(
        await db`select to_jsonb(r) value from allrice_memory_revisions r where memory_id in ${db(retained)} order by id`,
      ).toEqual(revisions);
      expect(
        await db`select to_jsonb(o) value from allrice_employee_memory_operations o where memory_id in ${db(retained)} order by memory_id`,
      ).toEqual(operations);
      expect(await Promise.all(preserved.map((t) => snapshot(db, t)))).toEqual(
        before,
      );
      expect(
        await db`select id from allrice_runs where id=${legacy.run}`,
      ).toEqual([]);
      expect(
        await db`select run_id from allrice_employee_runs where run_id=${legacy.run}`,
      ).toEqual([]);
      expect(
        await db`select id from allrice_platform_employee_test_runs where id=${validationId}`,
      ).toEqual([]);
      await expect(db`insert into allrice_platform_employee_test_runs(id,employee_id,revision_id,requested_by_label,status,input,purpose)
      values(${randomUUID()},${platform.employeeId},${platform.revisionId},'Retired writer','failed','{}','experience_validation')`).rejects.toMatchObject(
        { code: '23514' },
      );
      expect(
        await db`select id from allrice_automations where id=${automationId}`,
      ).toEqual([]);
      expect(
        await db`select id from allrice_automation_runs where id=${occurrenceId}`,
      ).toEqual([]);
      for (const table of dropped)
        expect(
          (await db`select to_regclass(${table}) relation`)[0]!.relation,
        ).toBeNull();
      expect(
        await db`select proname,pg_get_functiondef(p.oid) definition from pg_proc p where pronamespace=current_schema()::regnamespace and proname like 'allrice_ordinary_monthly_%' order by proname`,
      ).toEqual(monthly);
      expect(
        (
          await db`select count(*)::int count from pg_trigger where tgrelid='allrice_native_recurring_occurrences'::regclass and tgname='native_calendar_dispatch_fence' and tgenabled='O'`
        )[0]!.count,
      ).toBe(1);
      expect(
        (
          await db`select count(*)::int count from pg_trigger where tgrelid='allrice_native_calendar_periods'::regclass and tgname='native_calendar_period_plan_fence' and tgenabled='O'`
        )[0]!.count,
      ).toBe(1);
      expect(
        (
          await db`select allrice_native_calendar_business_handoff_proved(${randomUUID()}::uuid) valid`
        )[0]!.valid,
      ).toBe(false);
      expect(
        (await db`select to_regclass('allrice_knowledge_chunks') relation`)[0]!
          .relation,
      ).not.toBeNull();
      expect(
        (await db`select 1 from pg_extension where extname='vector'`).length,
      ).toBe(1);
      expect(
        await db`select key from allrice_settings where key='employee_experience_policy'`,
      ).toEqual([]);
      expect(
        await db`select value from allrice_settings where scope_id=${c.org} and key='employee_memory_source_policy'`,
      ).toEqual([{ value: { schemaVersion: 2, enabled: false } }]);
    }, 120000);
    it('rolls back all table drops and restores history guards when a shared FK still uses a retired memory', async () => {
      f = await historical();
      const db = f.db,
        id = await memory(f, 'v1');
      await db`create table current_shared_reference(memory_id uuid references allrice_memories(id))`;
      await db`insert into current_shared_reference values(${id})`;
      const before = await snapshot(db, 'allrice_memories');
      await expect(migrate(db)).rejects.toMatchObject({ code: '23503' });
      expect(await snapshot(db, 'allrice_memories')).toEqual(before);
      for (const table of dropped)
        expect(
          (await db`select to_regclass(${table}) relation`)[0]!.relation,
        ).not.toBeNull();
      expect(
        (
          await db`select tgenabled from pg_trigger where tgrelid='allrice_employee_runs'::regclass and tgname='allrice_employee_runs_no_delete'`
        )[0]!.tgenabled,
      ).toBe('O');
    }, 120000);
    it('applies the complete migration chain on an empty isolated schema', async () => {
      const empty = await createRuntimeFixtureDatabase({ ownSchemaOnly: true });
      try {
        for (const table of dropped)
          expect(
            (await empty.db`select to_regclass(${table}) relation`)[0]!
              .relation,
          ).toBeNull();
        for (const table of [
          'allrice_memories',
          'allrice_memory_revisions',
          'allrice_employee_memory_operations',
          'allrice_memory_sources',
          'allrice_knowledge_chunks',
        ])
          expect(
            (await empty.db`select to_regclass(${table}) relation`)[0]!
              .relation,
          ).not.toBeNull();
        expect(
          (
            await empty.db`select allrice_native_calendar_control_valid('{"dispatch":{"consumer":"experience-consolidation-v1"}}') valid`
          )[0]!.valid,
        ).toBe(false);
        expect(
          (
            await empty.db`select count(*)::int count from information_schema.columns where table_schema=current_schema() and
        ((table_name='allrice_memories' and column_name in ('content','summary','details','expires_at','supersedes_memory_id'))
          or (table_name='allrice_employee_runs' and column_name in ('memory_context_state','experience_reads','memory_source_capture_state')))`
          )[0]!.count,
        ).toBe(8);
      } finally {
        await empty.close();
      }
    }, 120000);
  },
);
