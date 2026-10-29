/** Real isolated PostgreSQL structure/data upgrade; synthetic legacy child rows
 * are explicit here. Actual before APIs/Worker histories live in p25 retirement. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRuntimeFixtureDatabase,
  runtimeTaskFixture,
} from './runtime.fixture.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const retired = [
  'assistant_roots',
  'assistant_instances',
  'assistant_messages',
  'assistant_results',
  'assistant_usage',
  'assistant_artifacts',
  'assistant_model_admissions',
  'assistant_price_snapshots',
  'assistant_cost_receipts',
  'development_heads',
  'development_assignments',
  'development_proposals',
  'development_merges',
  'development_merge_sources',
  'development_verifiers',
  'development_reviews',
  'development_deliveries',
].map((n) => 'allrice_' + n);
const migration = () =>
  readFile(
    new URL('../migrations/0229_retire_legacy_assistants.sql', import.meta.url),
    'utf8',
  );
const fixtures: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function database(fresh = false) {
  const f = await createRuntimeFixtureDatabase(
    fresh ? {} : { throughMigration: '0228_repository_review_jobs.sql' },
  );
  fixtures.push(f);
  return f;
}
async function oldChild(db: Awaited<ReturnType<typeof database>>['db']) {
  const f = await runtimeTaskFixture(db),
    child = randomUUID();
  await db`update allrice_jobs set status='succeeded',completed_at=clock_timestamp() where id=${f.worker.jobId}`;
  await db`insert into allrice_assistant_roots(root_run_id,configuration,worker_job_id,worker_id,worker_lease_digest,generation) values(${f.task.runId},'{"allowAssistants":true}',${f.worker.jobId},${f.worker.workerId},${'sha256:' + 'a'.repeat(64)},1)`;
  const insert = async (runId: string, parent: string | null, depth: number) =>
    db`insert into allrice_assistant_instances(run_id,root_run_id,parent_run_id,native_session_id,delegation_id,creation_digest,label,depth,allowed_tools,artifact_namespace,status,stopped_at) values(${runId},${f.task.runId},${parent},${'legacy-' + runId},${randomUUID()},'synthetic','old fixture',${depth},'[]',${'legacy/' + runId},'canceled',clock_timestamp())`;
  await insert(f.task.runId, null, 0);
  await db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input) values(${child},${f.task.scope.organizationId},${f.task.scope.workspaceId},${f.context.actor.id},'canceled','{}','{}')`;
  await db`insert into allrice_runtime_run_links(run_id,root_run_id,parent_run_id,organization_id,workspace_id,task) values(${child},${f.task.runId},${f.task.runId},${f.task.scope.organizationId},${f.task.scope.workspaceId},${db.json({ ...f.task, runId: child, parentRunId: f.task.runId })})`;
  await insert(child, f.task.runId, 1);
  const removed = await f.artifact(child),
    retained = await f.artifact(f.task.runId, 'ordinary result remains');
  await db`insert into allrice_assistant_artifacts(run_id,relative_path,artifact_id,digest) values(${child},'legacy.txt',${removed.artifactId},${removed.digest})`;
  return { ...f, child, removed, retained };
}
suite('0229 bounded legacy retirement', () => {
  it('new database has no retired tables, preserves shared guards and ordinary reviewer Run FKs', async () => {
    const { db } = await database(true);
    for (const name of retired)
      expect(
        (await db`select to_regclass(${name}) relation`)[0]!.relation,
      ).toBeNull();
    for (const name of [
      'allrice_reject_assistant_pricing_mutation()',
      'allrice_guard_development_record()',
    ])
      expect(
        (await db`select to_regprocedure(${name}) function`)[0]!.function,
      ).not.toBeNull();
    const fks =
      await db`select c.conrelid::regclass::text relation,c.confrelid::regclass::text target from pg_constraint c where c.contype='f' and c.connamespace=current_schema()::regnamespace and c.conname in ('allrice_repository_reviews_reviewer_run_id_fkey','allrice_repository_review_facts_reviewer_run_id_fkey')`;
    expect(fks).toHaveLength(2);
    expect(fks.every((f) => f.target === 'allrice_runs')).toBe(true);
  }, 120000);
  it('deletes only explicit old child/version/object rows and leaves ordinary roots/results/preferences unchanged', async () => {
    const { db } = await database(),
      f = await oldChild(db);
    const [ordinary] =
      await db`select to_jsonb(v) value from allrice_deliverable_versions v where id=${f.retained.artifactId}`;
    const roots =
      await db`select * from allrice_runtime_roots where root_run_id=${f.task.runId}`;
    const budgets =
      await db`select * from allrice_runtime_budgets where root_run_id=${f.task.runId} order by metric`;
    await db`insert into allrice_member_work_automation(organization_id,workspace_id,user_id,revision,settings) values(${f.task.scope.organizationId},${f.task.scope.workspaceId},${f.context.actor.id},7,'{"assistants":true,"cloud":false,"computer":true}')`;
    await db.begin(async (tx) => tx.unsafe(await migration()));
    expect(
      await db`select id from allrice_runs where id=${f.child}`,
    ).toHaveLength(0);
    expect(
      await db`select id from allrice_deliverable_versions where id=${f.removed.artifactId}`,
    ).toHaveLength(0);
    expect(
      (
        await db`select to_jsonb(v) value from allrice_deliverable_versions v where id=${f.retained.artifactId}`
      )[0],
    ).toEqual(ordinary);
    expect(
      await db`select * from allrice_runtime_roots where root_run_id=${f.task.runId}`,
    ).toEqual(roots);
    expect(
      await db`select * from allrice_runtime_budgets where root_run_id=${f.task.runId} order by metric`,
    ).toEqual(budgets);
    expect(
      (
        await db`select revision,settings from allrice_member_work_automation where user_id=${f.context.actor.id}`
      )[0],
    ).toEqual({ revision: 7, settings: { cloud: false, computer: true } });
    expect(
      await db`select run_id from allrice_runtime_run_links where run_id=${f.task.runId}`,
    ).toHaveLength(1);
  }, 120000);
  it('a retained ordinary feedback reference blocks deletion with its exact identity and rolls back all drops', async () => {
    const { db } = await database(),
      f = await oldChild(db),
      feedback = randomUUID();
    await db`insert into allrice_artifact_feedback(id,organization_id,workspace_id,actor_id,artifact_id,checksum,revision,comments,state) values(${feedback},${f.task.scope.organizationId},${f.task.scope.workspaceId},${f.context.actor.id},${f.removed.artifactId},${f.removed.digest},1,'[{}]','draft')`;
    const error = await db
      .begin(async (tx) => tx.unsafe(await migration()))
      .catch((e) => e);
    expect(error).toMatchObject({
      code: '23503',
      message: 'MET210_SHARED_REFERENCE',
    });
    expect(error.detail).toContain(feedback);
    expect(error.detail).toContain('allrice_artifact_feedback');
    expect(
      await db`select run_id from allrice_assistant_instances where run_id=${f.child}`,
    ).toHaveLength(1);
    expect(
      await db`select id from allrice_deliverable_versions where id=${f.removed.artifactId}`,
    ).toHaveLength(1);
  }, 120000);
  it('ordinary queued null/false/disabled fields are stripped without blocking or losing queued jobs', async () => {
    const { db } = await database();
    const ids: string[] = [];
    for (const config of [
      null,
      false,
      {
        version: 1,
        mode: 'daily',
        allowAssistants: false,
        maxConcurrent: 2,
        maxDepth: 1,
        maxChildren: 4,
      },
    ]) {
      const f = await runtimeTaskFixture(db);
      ids.push(f.worker.jobId);
      await db`update allrice_jobs set status='queued',worker_id=null,lease_token=null,lease_expires_at=null,payload=${db.json({ schemaVersion: 1, type: 'allrice.employee.run', input: { assistantConfiguration: config, ordinary: 'keep' } })} where id=${f.worker.jobId}`;
      await db`update allrice_runs set state='queued',input=${db.json({ assistantConfiguration: config, ordinary: 'keep' })} where id=${f.task.runId}`;
    }
    await db.begin(async (tx) => tx.unsafe(await migration()));
    const jobs =
      await db`select status,payload from allrice_jobs where id=any(${ids}::uuid[])`;
    expect(jobs).toHaveLength(3);
    for (const job of jobs)
      expect(job).toMatchObject({
        status: 'queued',
        payload: { input: { ordinary: 'keep' } },
      });
    expect(
      jobs.every(
        (j) => !Object.hasOwn(j.payload.input, 'assistantConfiguration'),
      ),
    ).toBe(true);
  }, 120000);
  it.each(['queued-configuration', 'old-root', 'unconfirmed-child'] as const)(
    'blocks actual old execution: %s',
    async (kind) => {
      const { db } = await database(),
        f = await oldChild(db);
      if (kind === 'queued-configuration') {
        const other = await runtimeTaskFixture(db);
        await db`update allrice_jobs set status='queued',payload=jsonb_set(payload,'{input}','{"assistantConfiguration":{"allowAssistants":true}}') where id=${other.worker.jobId}`;
      } else if (kind === 'old-root')
        await db`update allrice_jobs set status='running',completed_at=null where id=${f.worker.jobId}`;
      else
        await db`update allrice_assistant_instances set status='running',stopped_at=null where run_id=${f.child}`;
      const error = await db
        .begin(async (tx) => tx.unsafe(await migration()))
        .catch((e) => e);
      expect(error).toMatchObject({
        code: '55000',
        message:
          kind === 'unconfirmed-child'
            ? 'MET210_CHILD_STOP_UNCONFIRMED'
            : 'MET210_OLD_WRITERS_ACTIVE',
      });
      expect(error.detail).toBeTypeOf('string');
      expect(
        await db`select run_id from allrice_assistant_instances where run_id=${f.child}`,
      ).toHaveLength(1);
    },
    120000,
  );
});
