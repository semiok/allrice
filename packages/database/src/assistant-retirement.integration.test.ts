/** Real isolated PostgreSQL structure/data upgrade; synthetic legacy child rows
 * are explicit here. Actual before APIs/Worker histories live in p25 retirement. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRuntimeFixtureDatabase,
  runtimeTaskFixture,
  runtimeFixtureStorage,
} from './runtime.fixture.ts';
import type { RuntimeTaskRef } from '@allrice/contracts';
import { createLocalCommandFixture } from './local-command.fixture.ts';
import { registerToolBrokerExport } from './execution/tool-broker.ts';
import { listWorkbenchArtifacts } from './artifact-review.ts';
import { artifactForDownloadLink } from '../../../apps/web/lib/chatflow/artifact-download-link.ts';
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
  vi.unstubAllEnvs();
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
type Database = Awaited<ReturnType<typeof database>>['db'];
async function stoppedChild(
  db: Database,
  f: {
    task: RuntimeTaskRef;
    worker: { jobId: string; workerId: string };
    owner: string;
  },
) {
  const child = randomUUID();
  await db`update allrice_jobs set status='succeeded',completed_at=clock_timestamp() where id=${f.worker.jobId}`;
  await db`insert into allrice_assistant_roots(root_run_id,configuration,worker_job_id,worker_id,worker_lease_digest,generation) values(${f.task.runId},'{"allowAssistants":true}',${f.worker.jobId},${f.worker.workerId},${'sha256:' + 'a'.repeat(64)},1)`;
  const insert = async (runId: string, parent: string | null, depth: number) =>
    db`insert into allrice_assistant_instances(run_id,root_run_id,parent_run_id,native_session_id,delegation_id,creation_digest,label,depth,allowed_tools,artifact_namespace,status,stopped_at) values(${runId},${f.task.runId},${parent},${'legacy-' + runId},${randomUUID()},'synthetic','old fixture',${depth},'[]',${'legacy/' + runId},'canceled',clock_timestamp())`;
  await insert(f.task.runId, null, 0);
  await db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input) values(${child},${f.task.scope.organizationId},${f.task.scope.workspaceId},${f.owner},'canceled','{}','{}')`;
  await db`insert into allrice_runtime_run_links(run_id,root_run_id,parent_run_id,organization_id,workspace_id,task) values(${child},${f.task.runId},${f.task.runId},${f.task.scope.organizationId},${f.task.scope.workspaceId},${db.json({ ...f.task, runId: child, parentRunId: f.task.runId })})`;
  await insert(child, f.task.runId, 1);
  return child;
}
async function oldChild(db: Database) {
  const f = await runtimeTaskFixture(db),
    child = await stoppedChild(db, { ...f, owner: f.context.actor.id });
  const removed = await f.artifact(child),
    retained = await f.artifact(f.task.runId, 'ordinary result remains');
  await db`insert into allrice_assistant_artifacts(run_id,relative_path,artifact_id,digest) values(${child},'legacy.txt',${removed.artifactId},${removed.digest})`;
  return { ...f, child, removed, retained };
}
async function publishedChild(db: Database) {
  vi.stubEnv('ALLRICE_LOCAL_COMMAND_ENABLED', '1');
  const f = await createLocalCommandFixture(db, 'allow'),
    child = await stoppedChild(db, { ...f, owner: f.user });
  const bytes = Buffer.from(
    JSON.stringify({
      version: 1,
      kind: 'assistant_generated',
      rootRunId: f.rootRunId,
      childRunId: child,
      content: 'Frozen old report',
    }),
  );
  const object = {
    id: randomUUID(),
    organizationId: f.org,
    workspaceId: f.workspace,
    ownerId: f.user,
    key: `organizations/${f.org}/workspaces/${f.workspace}/owners/${f.user}/exports/${randomUUID()}`,
    checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    sizeBytes: bytes.length,
    mediaType: 'application/json',
    immutable: true,
    retentionUntil: null,
    deletedAt: null,
  };
  const storage = runtimeFixtureStorage(db);
  await storage.put(object, new Blob([bytes]).stream());
  // The same generic publisher used by old publishAssistantOutput creates the
  // parent-session file_reference itself. Only legacy provenance rows are SQL.
  await registerToolBrokerExport(
    {
      context: f.context,
      sessionId: f.session,
      fileName: 'old-report.json',
      format: 'json',
      object,
    },
    db,
  );
  const [version] =
    await db`select id from allrice_deliverable_versions where object_id=${object.id}`;
  await db`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,request_id,request_digest)
    values(${version!.id},${f.org},${f.workspace},${f.user},${child},'document',${db.json({ kind: 'model_proposal', runId: child, operationId: null, stepId: randomUUID() })},${'assistant-output:' + randomUUID()},${object.checksum})`;
  await db`insert into allrice_assistant_artifacts(run_id,relative_path,artifact_id,digest) values(${child},'old-report.json',${version!.id},${object.checksum})`;
  await db`update allrice_runs set state='succeeded' where id=${f.rootRunId}`;
  await db`update allrice_employee_runs set status='succeeded' where run_id=${f.rootRunId}`;
  await db`update allrice_jobs set worker_id=null,lease_token=null,lease_expires_at=null,claimed_at=null,heartbeat_at=null where id=${f.worker.jobId}`;
  return {
    ...f,
    child,
    object,
    bytes,
    storage,
    version: version!.id as string,
  };
}
async function snapshot(db: Database) {
  const tables = [
    'allrice_messages',
    'allrice_runs',
    'allrice_jobs',
    'allrice_workbench_artifacts',
    'allrice_storage_objects',
    'allrice_deliverable_versions',
    'allrice_file_references',
    'allrice_runtime_run_links',
    ...retired,
  ];
  return {
    rows: await Promise.all(
      tables.map(
        (table) =>
          db`select to_jsonb(r) value from ${db(table)} r order by to_jsonb(r)::text`,
      ),
    ),
    guards:
      await db`select tgrelid::regclass::text relation,tgname,tgenabled from pg_trigger where not tgisinternal and tgrelid in(select oid from pg_class where relnamespace=current_schema()::regnamespace) order by 1,2`,
  };
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
  it('retains automatically published parent-chat files and original generic provenance, without retaining old execution or creating a Job', async () => {
    vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
    const { db } = await database(),
      f = await publishedChild(db),
      ancestor = randomUUID();
    // A stopped intermediate child is required by the existing run-link FK.
    await db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
      select ${ancestor},organization_id,workspace_id,owner_id,'succeeded',execution_spec,input from allrice_runs where id=${f.child}`;
    await db`insert into allrice_runtime_run_links(run_id,root_run_id,parent_run_id,organization_id,workspace_id,task)
      values(${ancestor},${f.rootRunId},${f.rootRunId},${f.org},${f.workspace},${db.json({ ...f.task, runId: ancestor, parentRunId: f.rootRunId })})`;
    await db`insert into allrice_assistant_instances(run_id,root_run_id,parent_run_id,native_session_id,delegation_id,creation_digest,label,depth,allowed_tools,artifact_namespace,status,stopped_at)
      values(${ancestor},${f.rootRunId},${f.rootRunId},${'legacy-' + ancestor},${randomUUID()},'synthetic','old ancestor',1,'[]',${'legacy/' + ancestor},'completed',clock_timestamp())`;
    await db`update allrice_assistant_instances set parent_run_id=${ancestor},depth=2 where run_id=${f.child}`;
    await db`update allrice_runtime_run_links set parent_run_id=${ancestor},task=jsonb_set(task,'{parentRunId}',to_jsonb(${ancestor}::text)) where run_id=${f.child}`;
    await db`update allrice_assistant_instances set status='unknown' where run_id=${f.rootRunId}`;
    const generic = [
      'allrice_storage_objects',
      'allrice_deliverable_versions',
      'allrice_file_references',
      'allrice_workbench_artifacts',
      'allrice_runs',
      'allrice_runtime_run_links',
      'allrice_jobs',
      'allrice_messages',
    ];
    const rows = () =>
      Promise.all(
        generic.map(
          (table) =>
            db`select to_jsonb(r) value from ${db(table)} r order by to_jsonb(r)::text`,
        ),
      );
    const before = await rows();
    expect(
      await db`select object_id from allrice_file_references where object_id=${f.object.id} and session_id=${f.session}`,
    ).toHaveLength(1);
    const read = () =>
      listWorkbenchArtifacts(f.requestContext, f.session, undefined, db);
    const artifacts = await read();
    expect(artifacts.artifacts.map((a) => a.version.id)).toContain(f.version);
    await db.begin(async (tx) => tx.unsafe(await migration()));
    expect(await rows()).toEqual(before);
    expect(await read()).toEqual(artifacts);
    expect(
      Buffer.from(
        await new Response(await f.storage.get(f.object)).arrayBuffer(),
      ),
    ).toEqual(f.bytes);
    expect(
      await db`select id from allrice_jobs where run_id in (${f.child},${ancestor})`,
    ).toHaveLength(0);
    expect(
      await db`select id from allrice_runs where id in (${f.child},${ancestor}) and state not in ('succeeded','failed','canceled')`,
    ).toHaveLength(0);
    for (const name of retired)
      expect(
        (
          await db`select to_regclass(format('%I.%I',current_schema(),${name}::text)) relation`
        )[0]!.relation,
      ).toBeNull();
  }, 120000);
  it.each(['run', 'queued-job', 'leased-terminal-job'] as const)(
    'blocks runnable preserved provenance (%s) without changing its state or manufacturing a stop',
    async (mode) => {
      const { db } = await database(),
        f = await publishedChild(db);
      if (mode === 'run')
        await db`update allrice_runs set state='running' where id=${f.child}`;
      else {
        const jobId = randomUUID();
        await db`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload)
        values(${jobId},${f.org},${f.workspace},${f.user},${f.child},'queued',${randomUUID()},clock_timestamp()+interval '10 minutes','{"schemaVersion":1,"type":"allrice.employee.run","input":{}}')`;
        if (mode === 'leased-terminal-job')
          await db`update allrice_jobs set status='succeeded',worker_id=${randomUUID()},lease_token=${randomUUID()},claimed_at=clock_timestamp(),heartbeat_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '10 minutes',completed_at=clock_timestamp() where id=${jobId}`;
      }
      const before = await snapshot(db);
      const error = await db
        .begin(async (tx) => tx.unsafe(await migration()))
        .catch((e) => e);
      expect(error).toMatchObject({
        code: '55000',
        message:
          mode === 'queued-job'
            ? 'MET210_OLD_WRITERS_ACTIVE'
            : 'MET210_PRESERVED_SOURCE_ACTIVE',
      });
      expect(error.detail).toContain(f.child);
      expect(await snapshot(db)).toEqual(before);
    },
    120000,
  );
  it('does not treat a file reference without an ordinary parent source as approved preservation', async () => {
    const { db } = await database(),
      f = await oldChild(db);
    const [object] =
      await db`select object_id from allrice_deliverable_versions where id=${f.removed.artifactId}`;
    // Same ownership, but no ordinary parent Run/session source relationship.
    await db`insert into allrice_file_references(organization_id,workspace_id,object_id,session_id,owner_id,file_name)
      values(${f.task.scope.organizationId},${f.task.scope.workspaceId},${object!.object_id},${f.task.chatSessionId},${f.context.actor.id},'not-published-by-parent.txt')`;
    const before = await snapshot(db);
    const error = await db
      .begin(async (tx) => tx.unsafe(await migration()))
      .catch((e) => e);
    expect(error).toMatchObject({
      code: '23503',
      message: 'MET210_SHARED_REFERENCE',
    });
    expect(error.detail).toContain(object!.object_id);
    expect(error.detail).toContain('allrice_file_references');
    expect(await snapshot(db)).toEqual(before);
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
    const normalizedUrls = [
      `//current.example${path}`,
      `.${path}`,
      `..${path}`,
      path.slice(1),
      `/other/..${path}`,
      `https://current.example/other/%2e%2e${path}`,
    ];
    for (const href of normalizedUrls) {
      expect(
        artifactForDownloadLink(href, [
          { object: { id: objectId }, version: { fileName: 'evidence.txt' } },
        ])?.object.id,
      ).toBe(objectId);
      texts.push(`[已支持的链接](${href})`);
    }
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
    await db`update allrice_runs set result=${db.json({ answer: normalizedUrls.map((href) => `[原件](${href})`).join('\n') })} where id=${f.task.runId}`;
    const before = await snapshot(db);
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
    expect(await snapshot(db)).toEqual(before);
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
            ? 'MET210_OLD_STOP_UNCONFIRMED'
            : 'MET210_OLD_WRITERS_ACTIVE',
      });
      expect(error.detail).toBeTypeOf('string');
      expect(
        await db`select run_id from allrice_assistant_instances where run_id=${f.child}`,
      ).toHaveLength(1);
    },
    120000,
  );
  it.each(['root', 'child'] as const)(
    'blocks every terminal %s without its actual stop receipt even when the Job failed',
    async (target) => {
      const { db } = await database(),
        f = await oldChild(db),
        runId = target === 'root' ? f.task.runId : f.child;
      await db`update allrice_jobs set status='failed' where id=${f.worker.jobId}`;
      for (const status of [
        'completed',
        'partial',
        'failed',
        'canceled',
        'unknown',
      ]) {
        await db`update allrice_assistant_instances set status=${status},stopped_at=null where run_id=${runId}`;
        const before = await snapshot(db);
        const error = await db
          .begin(async (tx) => tx.unsafe(await migration()))
          .catch((e) => e);
        expect(error).toMatchObject({
          code: '55000',
          message: 'MET210_OLD_STOP_UNCONFIRMED',
        });
        expect(JSON.parse(error.detail)).toContainEqual({
          runId,
          rootRunId: f.task.runId,
          jobId: f.worker.jobId,
          status,
          stoppedAt: null,
        });
        expect(await snapshot(db)).toEqual(before);
      }
    },
    120000,
  );
});
