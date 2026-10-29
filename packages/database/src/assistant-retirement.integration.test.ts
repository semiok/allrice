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
    fresh
      ? { ownSchemaOnly: true }
      : { throughMigration: '0228_repository_review_jobs.sql' },
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
      await db`select c.conrelid::regclass::text relation,c.confrelid::regclass::text target from pg_constraint c where c.contype='f' and c.connamespace=current_schema()::regnamespace and c.conrelid in ('allrice_platform_repository_review_subjects'::regclass,'allrice_platform_repository_reviews'::regclass) and c.conkey=array[(select a.attnum from pg_attribute a where a.attrelid=c.conrelid and a.attname='reviewer_run_id')]`;
    expect(fks).toHaveLength(2);
    expect(fks.every((f) => f.target === 'allrice_runs')).toBe(true);
  }, 120000);
  it('disables only the built-in retired skill and preserves historical content and unrelated skills', async () => {
    const { db } = await database();
    const builtin = 'd78b3556-821a-5550-bf13-d9dd84b9bbe0',
      custom = randomUUID();
    for (const [id, name] of [
      [builtin, 'development-cooperation'],
      [custom, 'custom-development'],
    ])
      await db`insert into allrice_platform_dsh_skills(id,name,description,content,checksum,source_ref,version,license,review_status) values(${id!},${name!},'Synthetic retained skill','Frozen historical instructions',${'sha256:' + 'd'.repeat(64)},'https://example.test/synthetic','1.0.0','Apache-2.0','draft')`;
    const before =
      await db`select id,content,checksum from allrice_platform_dsh_skills where id in (${builtin},${custom}) order by id`;
    await db.begin(async (tx) => tx.unsafe(await migration()));
    expect(
      await db`select id,content,checksum from allrice_platform_dsh_skills where id in (${builtin},${custom}) order by id`,
    ).toEqual(before);
    expect(
      (
        await db`select enabled from allrice_platform_dsh_skills where id=${builtin}`
      )[0]!.enabled,
    ).toBe(false);
    expect(
      (
        await db`select enabled from allrice_platform_dsh_skills where id=${custom}`
      )[0]!.enabled,
    ).toBe(true);
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
  it('ordinary final file links block deletion without a foreign key and preserve every row and trigger', async () => {
    const { db } = await database(),
      f = await oldChild(db),
      messageId = randomUUID();
    const [object] =
      await db`select object_id from allrice_deliverable_versions where id=${f.removed.artifactId}`;
    const objectId = String(object!.object_id);
    const text = `[下载旧成果](/api/v1/files/${objectId}/download?name=evidence.txt)`;
    await db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,status,content)
      values(${messageId},${f.task.scope.organizationId},${f.task.scope.workspaceId},${f.task.chatSessionId},${f.context.actor.id},'assistant','completed',${db.json({ text, citations: [] })})`;
    const tables = [
      'allrice_messages',
      'allrice_runs',
      'allrice_jobs',
      'allrice_workbench_artifacts',
      'allrice_storage_objects',
      'allrice_deliverable_versions',
      ...retired,
    ];
    const rows = () =>
      Promise.all(
        tables.map(
          (table) =>
            db`select to_jsonb(r) value from ${db(table)} r order by to_jsonb(r)::text`,
        ),
      );
    const guards = () =>
      db`select tgrelid::regclass::text relation,tgname,tgenabled from pg_trigger where not tgisinternal and tgrelid in(select oid from pg_class where relnamespace=current_schema()::regnamespace) order by 1,2`;
    const before = await rows(),
      beforeGuards = await guards();
    const error = await db
      .begin(async (tx) => tx.unsafe(await migration()))
      .catch((e) => e);
    // With only the old FK preflight this transaction succeeds: the message
    // keeps this exact URL while its object is gone. No UUID/name inference.
    expect(error).toMatchObject({
      code: '23503',
      message: 'MET210_SHARED_FILE_REFERENCE',
    });
    expect(error.detail).toContain(messageId);
    expect(error.detail).toContain(objectId);
    expect(await rows()).toEqual(before);
    expect(await guards()).toEqual(beforeGuards);
  }, 120000);
  it('recognizes renderer-supported managed paths and structured file citations in retained messages/results', async () => {
    const { db } = await database(),
      f = await oldChild(db);
    const [object] =
      await db`select object_id from allrice_deliverable_versions where id=${f.removed.artifactId}`;
    const objectId = String(object!.object_id),
      path = `/api/v1/files/${objectId}/download`;
    const texts = [
      `[原件](/api/v1/files/${objectId})`,
      `[绝对链接](https://invented.invalid${path}?name=evidence.txt#download)`,
      `[转义链接](${path.replaceAll('/', '\\/')})`,
      `[双重转义](${path.replaceAll('/', '\\\\/')})`,
      `[引用式链接][file]\n\n[file]: <${path}>`,
      `<a href="${path}">原件</a>`,
    ];
    const messages: string[] = [];
    for (const text of texts) {
      const id = randomUUID();
      messages.push(id);
      await db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
        values(${id},${f.task.scope.organizationId},${f.task.scope.workspaceId},${f.task.chatSessionId},${f.context.actor.id},'assistant',${db.json({ text, citations: [] })})`;
    }
    const citation = randomUUID();
    messages.push(citation);
    await db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
      values(${citation},${f.task.scope.organizationId},${f.task.scope.workspaceId},${f.task.chatSessionId},${f.context.actor.id},'assistant',${db.json({ text: '见文件引用', citations: [{ type: 'file', id: objectId, label: '原件' }] })})`;
    await db`update allrice_runs set result=${db.json({ answer: `[原件](${path})` })} where id=${f.task.runId}`;
    const error = await db
      .begin(async (tx) => tx.unsafe(await migration()))
      .catch((e) => e);
    expect(error).toMatchObject({
      code: '23503',
      message: 'MET210_SHARED_FILE_REFERENCE',
    });
    const blockers = JSON.parse(error.detail);
    expect(
      blockers
        .map((b: { messageId: string | null }) => b.messageId)
        .filter(Boolean)
        .sort(),
    ).toEqual(messages.sort());
    expect(blockers).toContainEqual({
      table: 'allrice_runs',
      messageId: null,
      runId: f.task.runId,
      objectId,
    });
    expect(
      blockers.every((b: { objectId: string }) => b.objectId === objectId),
    ).toBe(true);
  }, 120000);
  it('does not treat bare UUIDs, names, unrelated paths or retired delegation results as ordinary file references', async () => {
    const { db } = await database(),
      f = await oldChild(db),
      messageId = randomUUID();
    const [object] =
      await db`select object_id from allrice_deliverable_versions where id=${f.removed.artifactId}`;
    const objectId = String(object!.object_id);
    const content = {
      text: `历史标识 ${objectId}，evidence.txt；[其他](https://example.test/other/${objectId})；[子路径](/api/v1/files/${objectId}/different)；[其他根路径](/other/api/v1/files/${objectId})`,
      citations: [],
    };
    await db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
      values(${messageId},${f.task.scope.organizationId},${f.task.scope.workspaceId},${f.task.chatSessionId},${f.context.actor.id},'assistant',${db.json(content)})`;
    const oldResult = {
      answer: `[旧子任务成果](/api/v1/files/${objectId}/download)`,
    };
    await db`update allrice_runs set result=${db.json(oldResult)} where id=${f.child}`;
    await db`insert into allrice_assistant_results(delivery_id,run_id,root_run_id,payload,payload_digest)
      values(${randomUUID()},${f.child},${f.task.runId},${db.json(oldResult)},${'sha256:' + 'b'.repeat(64)})`;
    await db.begin(async (tx) => tx.unsafe(await migration()));
    expect(
      await db`select id from allrice_storage_objects where id=${objectId}`,
    ).toHaveLength(0);
    expect(
      (await db`select content from allrice_messages where id=${messageId}`)[0]!
        .content,
    ).toEqual(content);
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
      await db`update allrice_jobs set status='queued',worker_id=null,lease_token=null,lease_expires_at=null,claimed_at=null,heartbeat_at=null,payload=${db.json({ schemaVersion: 1, type: 'allrice.employee.run', input: { assistantConfiguration: config, ordinary: 'keep' } })} where id=${f.worker.jobId}`;
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
