/** Actual HTTP handlers, login/session/membership checks and PostgreSQL in a
 * migrated random schema. Only Next's cookie transport is substituted. No
 * model, Worker loop, Dev account or external publication is involved. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BrandMediaReadResultSchema,
  EmployeeDefinitionSchema,
  allRiceToolManifest,
  brandMediaModule,
  brandMediaRelease,
  brandMediaModuleV010,
  brandMediaTools,
  brandMediaUsage,
  cloudProjectCapabilityId,
  EmployeeExecutionSnapshotSchema,
  EmployeeExecutionSnapshotV1Schema,
  BrandMediaCandidatesResultSchema,
  BrandMediaArticleResultSchema,
  type ExecutionContext,
  type StoragePort,
  type RunSnapshot,
  type BrandMediaInvocation,
  makeObjectKey,
  type BrandMediaArticle,
  type BrandMediaMutationResult,
  type BrandMediaReadResult,
  type BrandMediaTopic,
} from '@allrice/contracts';
import * as client from '../../../packages/database/src/core/client.ts';
import {
  createStorageMetadata,
  markStorageReady,
  abandonStorageMetadata,
} from '../../../packages/database/src/data.ts';
import { createReadPathProbe } from '../../../packages/database/src/read-path-probe.fixture.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
  runtimeTaskFixture,
} from '../../../packages/database/src/runtime.fixture.ts';
import {
  authenticateSession,
  createSession,
} from '../../../packages/database/src/identity.ts';
import {
  createEmployeeInstance,
  ensureGeneralEmployeeInstance,
  getEmployeeInstance,
} from '../../../packages/database/src/employees/employee-instances.ts';
import { isBaseRiceInstance } from '../../../packages/database/src/employees/employee-instance-policy.ts';
import { createEmployeeAdministrationFixture } from '../../../packages/database/src/employee-administration.fixture.ts';
import { approveSyntheticCurrentEmployeeExecution } from '../../../packages/database/src/current-execution.fixture.ts';
import {
  savePlatformEmployeeDraft,
  assignPublishedPlatformEmployeeToWorkspace,
} from '../../../packages/database/src/employees/platform-employees.ts';
import {
  createChatSession,
  sendChatMessage,
  getEmployeeWorkspace,
} from '../../../packages/database/src/workspace/service.ts';
import {
  EmployeeModuleError,
  requireEmployeeModuleBinding,
} from '../../../packages/database/src/employees/employee-module-bindings.ts';
import { employeeManifestChecksum } from '../../../packages/database/src/employees/employee-config.ts';
import {
  assertEmployeeContentContext,
  prepareEmployeeContentContext,
  EmployeeRuntimeContentError,
} from '../../../packages/database/src/employees/employee-runtime-content.ts';
import { acquireConversationRuntime } from '../../../packages/database/src/conversation/conversation-runtime.ts';
import { resolveEmployeeExecution } from '../../../packages/database/src/employees/employeehub.ts';
import { updateUserPreferences } from '../../../packages/database/src/user-preferences.ts';
import {
  publishReference,
  changeReferencePublication,
} from '../../../packages/database/src/reference-library.ts';
import {
  claimReferenceProcessing,
  finishReferenceProcessing,
} from '../../../packages/database/src/reference-processing.ts';
import {
  readBrandMedia,
  readBrandMediaRuns,
  freezeBrandMediaModule,
} from '../../../packages/database/src/brand-media/server-wiring.ts';
import {
  startClaimedJob,
  cancelRun,
  completeJob,
} from '../../../packages/database/src/execution/queue.ts';
import { readFrozenSkillResource } from '../../../packages/database/src/skill-bundles.ts';
import * as runtimeStorage from './storage/runtime';
import * as uploadHttp from '../app/api/v1/workbench/files/route';
import * as catalog from '../app/api/v1/employee-instances/[id]/modules/route';
import * as business from '../app/api/v1/employee-instances/[id]/brand-media/route';

const browser = vi.hoisted(() => ({ token: '' }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (key: string) =>
      key === 'allrice_session' && browser.token
        ? { value: browser.token }
        : undefined,
  }),
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
type Fixture = Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
type Actor = Awaited<ReturnType<typeof actor>>;
let f: Fixture;

async function actor() {
  const base = await runtimeTaskFixture(f.db),
    currentVersionId = randomUUID();
  const [assignment] = await f.db<
    { id: string; employee_version_id: string; manifest: unknown }[]
  >`
    select a.id,a.employee_version_id,v.manifest from allrice_employee_assignments a
    join allrice_employee_versions v on v.id=a.employee_version_id where a.user_id=${base.context.actor.id}`;
  const manifest = EmployeeDefinitionSchema.parse(assignment!.manifest);
  // Preserve the historical fixture publication. A separate valid publication
  // supports the real frozen configuration resolver in the installation test.
  await f.db`insert into allrice_employee_versions
    (id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
    select ${currentVersionId},organization_id,workspace_id,employee_id,version+1,name,model,system_prompt,capabilities,
      ${employeeManifestChecksum(manifest)},manifest,provider_snapshot
    from allrice_employee_versions where id=${assignment!.employee_version_id}`;
  await f.db`update allrice_employee_assignments set employee_version_id=${currentVersionId} where id=${assignment!.id}`;
  await ensureGeneralEmployeeInstance(f.db, assignment!.id);
  const login = await createSession(base.context.actor.id);
  const context = (await authenticateSession(login.token, {
    organizationId: base.context.organizationId,
    workspaceId: base.context.workspaceId!,
  }))!;
  if (!context) throw Error('Fixture requires a real login');
  const um = randomUUID(),
    am = randomUUID();
  await f.db`insert into allrice_messages(id,organization_id,workspace_id,owner_id,session_id,role,content,status)
    values(${um},${context.organizationId},${context.workspaceId!},${context.actor.id},${base.task.chatSessionId},'user','{"text":"给这条选题开始写","citations":[]}','completed'),
      (${am},${context.organizationId},${context.workspaceId!},${context.actor.id},${base.task.chatSessionId},'assistant','{"text":"合成候选","citations":[]}','completed')`;
  await f.db`insert into allrice_employee_runs
    (run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot)
    values(${base.task.runId},${context.organizationId},${context.workspaceId!},${context.actor.id},${assignment!.id},
      ${currentVersionId},${base.task.chatSessionId},${um},${am},${f.db.json(manifest.provider)},
      ${f.db.json({ systemPrompt: 'Synthetic frozen prompt', conversation: [], memories: [], userRequest: '合成候选' })})`;
  return {
    base,
    context,
    token: login.token,
    assignmentId: assignment!.id,
    scope: { workspaceId: context.workspaceId!, instanceId: assignment!.id },
    manifest,
    currentVersionId,
  };
}
function request(
  a: Actor,
  path: 'modules' | 'brand-media',
  input?: unknown,
  query = '',
  target = a.scope.instanceId,
) {
  browser.token = a.token;
  return new Request(
    `https://example.test/api/v1/employee-instances/${target}/${path}${query}`,
    {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        host: 'example.test',
        origin: 'https://example.test',
        'Content-Type': 'application/json',
        'x-allrice-organization-id': a.context.organizationId,
        'x-allrice-workspace-id': a.scope.workspaceId,
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    },
  );
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
function installInput(a: Actor, requestId = randomUUID()) {
  return { ...a.scope, release: brandMediaRelease, requestId };
}
async function install(a: Actor, input = installInput(a)) {
  const response = await catalog.POST(
    request(a, 'modules', input),
    params(a.scope.instanceId),
  );
  expect(response.status).toBe(200);
  return response.json();
}
async function command(a: Actor, input: object, expectedStatus = 200) {
  const response = await business.POST(
    request(a, 'brand-media', {
      ...a.scope,
      requestId: randomUUID(),
      ...input,
    }),
    params(a.scope.instanceId),
  );
  expect(response.status).toBe(expectedStatus);
  return response.json() as Promise<{
    result: BrandMediaMutationResult;
    replayed: boolean;
  }>;
}
async function read(
  a: Actor,
  query: Record<string, string>,
  expectedStatus = 200,
): Promise<BrandMediaReadResult> {
  const response = await business.GET(
    request(a, 'brand-media', undefined, '?' + new URLSearchParams(query)),
    params(a.scope.instanceId),
  );
  expect(response.status).toBe(expectedStatus);
  const body = await response.json();
  return expectedStatus === 200 ? BrandMediaReadResultSchema.parse(body) : body;
}
const topicInput = (a: Actor) => ({
  operation: 'topic.add',
  requestId: randomUUID(),
  candidate: { title: '冬季新品', summary: '面向老客户的新品故事' },
  direction: '引用已选择的资料，说明产品规格',
  references: [] as BrandMediaTopic['references'],
  sourceRunId: a.base.task.runId,
});
async function topic(a: Actor, patch: object = {}) {
  const response = await command(a, { ...topicInput(a), ...patch });
  if (response.result.kind !== 'topic') throw Error('Expected topic');
  return response.result.topic;
}
async function draft(a: Actor, references: BrandMediaTopic['references'] = []) {
  const selected = await topic(a, { references });
  const response = await command(a, {
    operation: 'article.start',
    topicId: selected.id,
    expectedRevision: selected.revision,
    requirements: '写一篇纯文本草稿',
    references,
  });
  if (response.result.kind !== 'article') throw Error('Expected draft');
  return response.result.article;
}
async function articleRead(a: Actor, id: string) {
  const result = await read(a, { view: 'article', articleId: id });
  if (result.view !== 'article') throw Error('Expected article');
  return result.article;
}
async function publication(
  a: Actor,
  article: BrandMediaArticle,
  change: object,
) {
  const response = await command(a, {
    operation: 'article.publication',
    articleId: article.id,
    expectedRevision: article.revision,
    change,
  });
  if (response.result.kind !== 'article') throw Error('Expected article');
  return response.result.article;
}
async function file(a: Actor) {
  const artifact = await a.base.artifact(
    a.base.task.runId,
    '合成正文与不可变文件',
  );
  const [version] = await f.db<
    { object_id: string }[]
  >`select object_id from allrice_deliverable_versions where id=${artifact.artifactId}`;
  return {
    objectId: version!.object_id,
    versionId: artifact.artifactId,
    checksum: artifact.digest,
  };
}
async function pictureFile(a: Actor) {
  const imageId = randomUUID(),
    versionId = randomUUID();
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64',
  );
  const checksum = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  const key = makeObjectKey({
    organizationId: a.context.organizationId,
    workspaceId: a.scope.workspaceId,
    ownerId: a.context.actor.id,
    category: 'artifacts',
    objectId: imageId,
  });
  const imageFile = { objectId: imageId, versionId, checksum };
  await runtimeFixtureStorage(f.db)!.put(
    {
      id: imageId,
      organizationId: a.context.organizationId,
      workspaceId: a.scope.workspaceId,
      ownerId: a.context.actor.id,
      key,
      checksum,
      mediaType: 'image/png',
      sizeBytes: bytes.length,
      immutable: true,
      deletedAt: null,
      retentionUntil: null,
    },
    new Blob([bytes]).stream(),
  );
  // The file authority uses the real immutable delivery/session records.
  // No image operation or provider is invoked by this synthetic fixture.
  await f.db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,state,immutable)
  values(${imageId},${a.context.organizationId},${a.scope.workspaceId},${a.context.actor.id},${key},'artifacts','image/png',${bytes.length},${checksum},'ready',true)`;
  await f.db`insert into allrice_deliverable_versions(id,organization_id,workspace_id,owner_id,object_id,series_id,version,session_id,file_name,format)
  values(${versionId},${a.context.organizationId},${a.scope.workspaceId},${a.context.actor.id},${imageId},${randomUUID()},1,${a.base.task.chatSessionId},'合成封面.png','png')`;
  await f.db`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,request_id,request_digest)
  values(${versionId},${a.context.organizationId},${a.scope.workspaceId},${a.context.actor.id},${a.base.task.runId},'file',
    ${f.db.json({ kind: 'tool_result', runId: a.base.task.runId, operationId: null, stepId: null })},${randomUUID()},${imageFile.checksum})`;
  return imageFile;
}
async function reference(a: Actor) {
  const text = '合成产品规格：A5，48张。';
  const saved = await publishReference(
    a.context,
    {
      workspaceId: a.scope.workspaceId,
      requestId: randomUUID(),
      origin: 'upload',
      fileName: '规格.txt',
      mediaType: 'text/plain',
      contentBase64: Buffer.from(text).toString('base64'),
      audience: { scope: 'personal', departmentIds: [] },
    },
    runtimeFixtureStorage(f.db)!,
  );
  const claim = await claimReferenceProcessing();
  expect(claim?.revisionId).toBe(saved.revisionId);
  await finishReferenceProcessing(
    claim!,
    [{ content: text, start: 0, end: text.length }],
    {
      text,
      kind: 'text',
      warnings: [],
      units: [{ label: '正文', start: 0, end: text.length }],
    },
  );
  return {
    origin: 'reference' as const,
    sourceId: saved.sourceId,
    revisionId: saved.revisionId,
  };
}
async function filePolicyCase(kind: 'pin' | 'body' | 'image' | 'replay') {
  const a = await actor(),
    b = await actor();
  await install(a);
  const pinned = kind === 'image' ? await pictureFile(a) : await file(a);
  await f.db`insert into allrice_workbench_file_policies
    (object_id,organization_id,workspace_id,owner_id,file_name,scope)
    values(${pinned.objectId},${a.context.organizationId},${a.scope.workspaceId},${a.context.actor.id},'当前文件权限','personal')`;
  let input: object;
  if (kind === 'pin')
    input = {
      ...topicInput(a),
      references: [{ origin: 'file', file: pinned }],
    };
  else {
    const article = await draft(a);
    if (kind === 'image')
      input = {
        operation: 'article.image.add',
        requestId: randomUUID(),
        articleId: article.id,
        expectedRevision: article.revision,
        image: { file: pinned, source: 'uploaded' },
      };
    else {
      await f.db`update allrice_brand_media_articles set body_file=${f.db.json(pinned)},revision=revision+1
        where id=${article.id} and revision=${article.revision}`;
      input = {
        operation: 'article.publication',
        requestId: randomUUID(),
        articleId: article.id,
        expectedRevision: article.revision + 1,
        change: { action: 'schedule', schedule },
      };
      // No file in this input: replay must validate the retained response body.
      if (kind === 'replay') await command(a, input);
    }
  }
  return { a, b, pinned, input };
}
async function expectBlocked(waiter: number, blocker: number) {
  await expect
    .poll(async () => {
      const [row] =
        await f.db`select ${blocker}::int=any(pg_blocking_pids(${waiter}::int)) blocked`;
      return row!.blocked;
    })
    .toBe(true);
}
async function businessState(a: Actor) {
  return Promise.all([
    f.db`select * from allrice_brand_media_topics where instance_id=${a.scope.instanceId} order by id`,
    f.db`select * from allrice_brand_media_articles where instance_id=${a.scope.instanceId} order by id`,
    f.db`select * from allrice_brand_content_requests where instance_id=${a.scope.instanceId} order by request_id`,
  ]);
}
const schedule = {
  plannedAt: '2026-11-24T20:00:00+08:00',
  timezone: 'Asia/Shanghai',
};

suite(
  'MET-224 P2 human module and business API, real session and persistence',
  () => {
    beforeAll(async () => {
      approveSyntheticCurrentEmployeeExecution();
      vi.stubEnv('ALLRICE_PORTAL_AUTH_ENABLED', '0');
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
      f = await createRuntimeFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      vi.spyOn(runtimeStorage, 'getStorageAdapter').mockReturnValue(
        runtimeFixtureStorage(f.db),
      );
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      browser.token = '';
      await f?.close();
    }, 30000);

    it('“添加品牌自媒体，选入这个选题，开始写并排周二晚上，发布后改回排期” persists the human chain', async () => {
      const a = await actor();
      const before = await catalog.GET(
        request(a, 'modules'),
        params(a.scope.instanceId),
      );
      expect(before.headers.get('Cache-Control')).toBe('private, no-store');
      expect((await before.json()).modules[0]).toMatchObject({
        binding: null,
        available: true,
        enabled: false,
      });
      await read(a, { view: 'topics' }, 403);
      const added = await install(a);
      expect(added.binding).toMatchObject({
        ...a.scope,
        ownerId: a.context.actor.id,
        organizationId: a.context.organizationId,
        release: brandMediaRelease,
        revision: 1,
        revokedAt: null,
      });
      let article = await draft(a);
      expect(article.body).toBeNull();
      expect(await read(a, { view: 'topics' })).toMatchObject({ items: [] });
      article = await publication(a, article, { action: 'schedule', schedule });
      const plannedAt = article.publication.schedule!.plannedAt;
      article = await publication(a, article, {
        action: 'publish',
        links: {
          wechat: 'https://mp.weixin.qq.com/s/synthetic',
          xiaohongshu: null,
        },
      });
      expect(article.publication.state).toBe('published');
      article = await publication(a, article, { action: 'unpublish' });
      expect(article.publication).toEqual({
        state: 'scheduled',
        schedule: { ...schedule, plannedAt },
        links: null,
      });
      article = await publication(a, article, { action: 'unschedule' });
      expect(article.publication).toEqual({
        state: 'draft',
        schedule: null,
        links: null,
      });
      await command(a, {
        operation: 'article.delete',
        articleId: article.id,
        expectedRevision: article.revision,
      });
      expect(
        await f.db`select id from allrice_brand_media_articles where id=${article.id}`,
      ).toEqual([]);
      expect(
        await f.db`select id from allrice_brand_media_topics where id=${article.topicId}`,
      ).toEqual([]);
      const [evidence] = await f.db`select
      (select count(*)::int from allrice_brand_content_requests where instance_id=${a.scope.instanceId} and request_id like 'brand-media:%') requests,
      (select count(*)::int from allrice_audit_events where resource_id=${a.scope.instanceId} and action like 'brand.media.%') audit`;
      expect(evidence).toEqual({ requests: 8, audit: 8 });
    });

    it('permits existing general and new instances without changing their published configuration, frozen admission or native tool directory', async () => {
      const a = await actor();
      const [before] =
        await f.db`select manifest,capabilities,config_checksum from allrice_employee_versions where id=${a.currentVersionId}`;
      const frozen = {
        organizationId: a.context.organizationId,
        workspaceId: a.scope.workspaceId,
        ownerId: a.context.actor.id,
        runId: a.base.task.runId,
      };
      const admittedBefore = await resolveEmployeeExecution(frozen);
      const nativeModule = new URL(
        '../../worker/src/harness/dsh/native-tools.ts',
        import.meta.url,
      ).href;
      // Runtime import keeps Worker Node ambient types out of Next compilation
      // while exercising the real native directory selector with old config.
      const { selectDshNativeTools } = (await import(nativeModule)) as {
        selectDshNativeTools(names: readonly string[]): Promise<string[]>;
      };
      const nativeBefore = await selectDshNativeTools(
        a.manifest.capabilityBindings.toolNames,
      );
      await install(a);
      const instance = await createEmployeeInstance(a.context, {
        workspaceId: a.scope.workspaceId,
        assignmentId: a.assignmentId,
        requestId: randomUUID(),
        profile: { name: '新建写作员工' },
      });
      const newer = { ...a, scope: { ...a.scope, instanceId: instance.id } };
      const catalogBefore = await catalog.GET(
        request(newer, 'modules'),
        params(instance.id),
      );
      expect((await catalogBefore.json()).modules[0].binding).toBeNull();
      await install(newer);
      const [after] =
        await f.db`select manifest,capabilities,config_checksum from allrice_employee_versions where id=${a.currentVersionId}`;
      expect(after).toEqual(before);
      expect(await resolveEmployeeExecution(frozen)).toEqual(admittedBefore);
      const actualNative = await selectDshNativeTools(
        EmployeeDefinitionSchema.parse(after!.manifest).capabilityBindings
          .toolNames,
      );
      expect(actualNative).toEqual(nativeBefore);
      const known = new Set<string>(
        allRiceToolManifest.map((t) => t.canonicalName),
      );
      expect(actualNative.every((name) => known.has(name))).toBe(true);
      expect(brandMediaModule.tools).toEqual(
        brandMediaTools.map((tool) => tool.canonicalName),
      );
      expect(brandMediaModule.skills).toEqual(['brand-media']);
    });

    it('allows the real published platform Rice to self-add without preinstallation or changed capabilities', async () => {
      const a = await actor(),
        source = await createEmployeeAdministrationFixture(f.db);
      const [rice] = await f.db<
        { id: string }[]
      >`select id from allrice_platform_employees where employee_key='rice'`;
      expect(rice).toBeDefined();
      await savePlatformEmployeeDraft(rice!.id, {
        definition: {
          ...source.definition,
          key: 'rice',
          name: 'Platform Rice',
        },
      });
      await source.preview(rice!.id);
      expect((await source.publish(rice!.id)).valid).toBe(true);
      await assignPublishedPlatformEmployeeToWorkspace(
        'rice',
        a.scope.workspaceId,
      );
      const assigned = (
        await getEmployeeWorkspace(a.context, a.scope.workspaceId)
      ).employees.find((e) => e.employeeKey === 'default-assistant')!;
      expect(assigned).toBeDefined();
      await ensureGeneralEmployeeInstance(f.db, assigned.id);
      const instance = await getEmployeeInstance(a.context, assigned.id);
      expect(await isBaseRiceInstance(instance, f.db)).toBe(true);
      const target = {
        ...a,
        assignmentId: assigned.id,
        scope: { ...a.scope, instanceId: instance.id },
      };
      const [before] =
        await f.db`select manifest,capabilities,config_checksum from allrice_employee_versions where id=${instance.source.employeeVersionId}`;
      const entries = await catalog.GET(
        request(target, 'modules'),
        params(instance.id),
      );
      expect((await entries.json()).modules[0]).toMatchObject({
        binding: null,
        enabled: false,
        available: true,
      });
      const added = await install(target);
      expect(added.binding).toMatchObject({
        ...target.scope,
        release: brandMediaRelease,
        revision: 1,
      });
      expect(await read(target, { view: 'articles' })).toMatchObject({
        items: [],
        nextCursor: null,
      });
      const [after] =
        await f.db`select manifest,capabilities,config_checksum from allrice_employee_versions where id=${instance.source.employeeVersionId}`;
      expect(after).toEqual(before);
    });

    it('deduplicates simultaneous add and request replay into one full-scope binding and an existing ledger row', async () => {
      const a = await actor(),
        input = installInput(a);
      const [first, concurrent] = await Promise.all([
        install(a, input),
        install(a, input),
      ]);
      expect(concurrent.binding).toEqual(first.binding);
      expect([first.replayed, concurrent.replayed].sort()).toEqual([
        false,
        true,
      ]);
      expect((await install(a)).binding).toEqual(first.binding);
      const [count] =
        await f.db`select count(*)::int n from allrice_employee_module_bindings where instance_id=${a.scope.instanceId}`;
      expect(count!.n).toBe(1);
      const [requests] =
        await f.db`select count(*)::int n from allrice_brand_content_requests
      where instance_id=${a.scope.instanceId} and request_id=${'brand-media:' + input.requestId}`;
      expect(requests!.n).toBe(1);
      await command(a, { ...topicInput(a), requestId: input.requestId }, 409);
      expect(
        await f.db`select id from allrice_brand_media_topics where instance_id=${a.scope.instanceId}`,
      ).toEqual([]);
    });

    it('rejects uninstalled access, name/version/digest substitutions and browser authorization facts without creating a binding', async () => {
      const a = await actor();
      await command(a, topicInput(a), 403);
      for (const release of [
        { ...brandMediaRelease, moduleId: '品牌自媒体' },
        { ...brandMediaRelease, contentVersion: '99.0.0' },
        { ...brandMediaRelease, digest: 'sha256:' + '0'.repeat(64) },
      ]) {
        const response = await catalog.POST(
          request(a, 'modules', { ...installInput(a), release }),
          params(a.scope.instanceId),
        );
        expect(response.status).toBe(409);
      }
      for (const injected of [
        { organizationId: a.context.organizationId },
        { actor: a.context.actor },
        { enabled: true },
        { authority: 'workflow' },
      ]) {
        const response = await catalog.POST(
          request(a, 'modules', { ...installInput(a), ...injected }),
          params(a.scope.instanceId),
        );
        expect(response.status).toBe(422);
      }
      expect(
        await f.db`select module_id from allrice_employee_module_bindings where instance_id=${a.scope.instanceId}`,
      ).toEqual([]);
      await install(a);
      for (const injected of [
        { body: { text: '浏览器正文' } },
        { authority: 'workflow' },
        { actor: a.context.actor },
      ])
        await command(a, { ...topicInput(a), ...injected }, 422);
      await command(
        a,
        {
          operation: 'article.submit',
          articleId: randomUUID(),
          expectedRevision: 1,
          title: '浏览器不得提交',
          body: await file(a),
        },
        422,
      );
    });

    it('does not let another tenant, owner or instance borrow a binding or private article', async () => {
      const a = await actor(),
        b = await actor();
      await install(a);
      await install(b);
      const article = await draft(a);
      expect(
        (
          await business.GET(
            request(
              b,
              'brand-media',
              undefined,
              '?view=articles',
              a.scope.instanceId,
            ),
            params(a.scope.instanceId),
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await catalog.POST(
            request(b, 'modules', {
              ...installInput(b),
              instanceId: a.scope.instanceId,
            }),
            params(a.scope.instanceId),
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await business.POST(
            request(
              a,
              'brand-media',
              { ...a.scope, ...topicInput(a) },
              '',
              b.scope.instanceId,
            ),
            params(b.scope.instanceId),
          )
        ).status,
      ).toBe(403);
      await read(b, { view: 'article', articleId: article.id }, 404);
      await command(
        b,
        {
          operation: 'article.delete',
          articleId: article.id,
          expectedRevision: article.revision,
        },
        404,
      );
      const second = await createEmployeeInstance(a.context, {
        workspaceId: a.scope.workspaceId,
        assignmentId: a.assignmentId,
        requestId: randomUUID(),
        profile: { name: '同用户另一个员工' },
      });
      const other = { ...a, scope: { ...a.scope, instanceId: second.id } };
      await read(other, { view: 'articles' }, 403);
      await install(other);
      await read(other, { view: 'article', articleId: article.id }, 404);
      await command(
        other,
        {
          operation: 'article.delete',
          articleId: article.id,
          expectedRevision: article.revision,
        },
        404,
      );
      expect(
        (
          await business.GET(
            request(
              a,
              'brand-media',
              undefined,
              '?view=topics&workspaceId=' + b.scope.workspaceId,
            ),
            params(a.scope.instanceId),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await f.db`select revision from allrice_brand_media_articles where id=${article.id}`
        )[0]!.revision,
      ).toBe(1);
    });

    it('checks binding revocation/version and frozen revision again on cold reads and cached receipts', async () => {
      const a = await actor(),
        input = installInput(a);
      await install(a, input);
      const add = topicInput(a);
      await command(a, add);
      await f.db`update allrice_employee_module_bindings set revision=revision+1,revoked_at=clock_timestamp() where instance_id=${a.scope.instanceId}`;
      await read(a, { view: 'topics' }, 403);
      await command(a, add, 403);
      expect(
        (
          await catalog.POST(
            request(a, 'modules', input),
            params(a.scope.instanceId),
          )
        ).status,
      ).toBe(403);
      // A later explicit core revision is simulated; P2 offers no reactivation UI/API.
      await f.db`update allrice_employee_module_bindings set revision=revision+1,revoked_at=null,
      digest=${'sha256:' + 'f'.repeat(64)} where instance_id=${a.scope.instanceId}`;
      await read(a, { view: 'topics' }, 409);
      await command(a, add, 409);
      await expect(
        f.db.begin((tx) =>
          requireEmployeeModuleBinding(
            tx,
            {
              ...a.scope,
              organizationId: a.context.organizationId,
              ownerId: a.context.actor.id,
            },
            brandMediaRelease,
            1,
          ),
        ),
      ).rejects.toBeInstanceOf(EmployeeModuleError);
      const currentCatalog = await catalog.GET(
        request(a, 'modules'),
        params(a.scope.instanceId),
      );
      expect((await currentCatalog.json()).modules[0]).toMatchObject({
        enabled: false,
        available: false,
      });
    });

    it('checks real current login and membership before reading persisted records or replaying a request', async () => {
      const a = await actor();
      await install(a);
      const add = topicInput(a);
      await command(a, add);
      const cold = await readBrandMedia(
        a.context,
        { ...a.scope, view: 'topics' },
        f.db,
      );
      expect(cold.view === 'topics' && cold.items.length).toBe(1);
      await f.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${a.context.sessionId}`;
      await read(a, { view: 'topics' }, 401);
      await command(a, add, 401);
      await expect(
        readBrandMedia(a.context, { ...a.scope, view: 'topics' }, f.db),
      ).rejects.toMatchObject({ code: 'authority_denied' });
      const b = await actor();
      await install(b);
      const old = topicInput(b);
      await command(b, old);
      await f.db`update allrice_memberships set active=false where user_id=${b.context.actor.id}`;
      await read(b, { view: 'topics' }, 403);
      await command(b, old, 403);
    });

    it('does not authorize a source Run merely from its UUID, another tenant or another instance of the same owner', async () => {
      const a = await actor(),
        b = await actor();
      await install(a);
      await command(a, { ...topicInput(a), sourceRunId: randomUUID() }, 409);
      await command(
        a,
        { ...topicInput(a), sourceRunId: b.base.task.runId },
        409,
      );
      const second = await createEmployeeInstance(a.context, {
        workspaceId: a.scope.workspaceId,
        assignmentId: a.assignmentId,
        requestId: randomUUID(),
        profile: { name: '另一位写作者' },
      });
      const other = { ...a, scope: { ...a.scope, instanceId: second.id } };
      await install(other);
      await command(other, topicInput(other), 409);
      expect(
        await f.db`select id from allrice_brand_media_topics where owner_id=${a.context.actor.id}`,
      ).toEqual([]);
    });

    it('keeps one article per topic, prevents direct used-topic deletion and rejects changed request inputs', async () => {
      const a = await actor();
      await install(a);
      const add = topicInput(a),
        first = await command(a, add),
        replay = await command(a, add);
      expect(replay).toEqual({ ...first, replayed: true });
      await command(a, { ...add, direction: '请求ID不得复用于别的内容' }, 409);
      if (first.result.kind !== 'topic') throw Error('Expected topic');
      const selected = first.result.topic;
      const start = {
        operation: 'article.start',
        requestId: randomUUID(),
        topicId: selected.id,
        expectedRevision: selected.revision,
        requirements: '',
        references: [],
      };
      expect((await command(a, start)).result.kind).toBe('article');
      expect((await command(a, start)).replayed).toBe(true);
      await command(a, { ...start, requestId: randomUUID() }, 409);
      await command(
        a,
        {
          operation: 'topic.delete',
          topicId: selected.id,
          expectedRevision: selected.revision,
        },
        409,
      );
      expect(
        (
          await f.db`select count(*)::int n from allrice_brand_media_articles where topic_id=${selected.id}`
        )[0]!.n,
      ).toBe(1);
      const unused = await topic(a);
      await command(
        a,
        {
          operation: 'topic.delete',
          topicId: unused.id,
          expectedRevision: unused.revision + 1,
        },
        409,
      );
      await command(a, {
        operation: 'topic.delete',
        topicId: unused.id,
        expectedRevision: unused.revision,
      });
    });

    it('makes concurrent revisions compete atomically without overwriting the first committed result', async () => {
      const a = await actor();
      await install(a);
      const article = await draft(a);
      const commands = ['2026-11-24T12:00:00Z', '2026-11-25T12:00:00Z'].map(
        (plannedAt) => ({
          ...a.scope,
          requestId: randomUUID(),
          operation: 'article.publication',
          articleId: article.id,
          expectedRevision: 1,
          change: {
            action: 'schedule',
            schedule: { plannedAt, timezone: 'Asia/Shanghai' },
          },
        }),
      );
      const responses = await Promise.all(
        commands.map((input) =>
          business.POST(
            request(a, 'brand-media', input),
            params(a.scope.instanceId),
          ),
        ),
      );
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      const [winner] =
        await f.db`select revision,planned_at from allrice_brand_media_articles where id=${article.id}`;
      expect(winner!.revision).toBe(2);
      const receipts = await Promise.all(responses.map((r) => r.json()));
      const saved =
        receipts[responses.findIndex((r) => r.status === 200)].result.article;
      expect(winner!.planned_at.toISOString()).toBe(
        new Date(saved.publication.schedule.plannedAt).toISOString(),
      );
      await command(
        a,
        {
          operation: 'article.references',
          articleId: article.id,
          expectedRevision: 1,
          references: [],
        },
        409,
      );
    });

    it('preserves microsecond schedule time through publish/correction and keeps published content read-only', async () => {
      const a = await actor();
      await install(a);
      let article = await draft(a);
      const body = await file(a);
      await f.db`update allrice_brand_media_articles set body_file=${f.db.json(body)},revision=revision+1 where id=${article.id} and revision=1`;
      article = await articleRead(a, article.id);
      const precise = {
        plannedAt: '2026-11-24T20:00:00.123456+08:00',
        timezone: 'Asia/Shanghai',
      };
      article = await publication(a, article, {
        action: 'schedule',
        schedule: precise,
      });
      expect(article.publication.schedule!.plannedAt).toBe(
        '2026-11-24T12:00:00.123456Z',
      );
      article = await publication(a, article, {
        action: 'publish',
        links: { wechat: null, xiaohongshu: null },
      });
      for (const input of [
        { operation: 'article.delete' },
        { operation: 'article.references', references: [] },
        {
          operation: 'article.publication',
          change: { action: 'schedule', schedule },
        },
        {
          operation: 'article.publication',
          change: {
            action: 'publish',
            links: { wechat: 'https://example.test/new', xiaohongshu: null },
          },
        },
      ])
        await command(
          a,
          {
            articleId: article.id,
            expectedRevision: article.revision,
            ...input,
          },
          409,
        );
      const corrected = await publication(a, article, { action: 'unpublish' });
      expect(corrected).toMatchObject({
        body,
        references: article.references,
        images: article.images,
        publication: {
          state: 'scheduled',
          schedule: article.publication.schedule,
          links: null,
        },
      });
      expect(corrected.publication.schedule!.plannedAt).toBe(
        '2026-11-24T12:00:00.123456Z',
      );
    });

    it('validates exact immutable delivery versions, checksums and current ACLs again on read and receipt replay', async () => {
      const a = await actor(),
        b = await actor();
      await install(a);
      const pinned = await file(a),
        foreign = await file(b);
      for (const invalid of [
        foreign,
        { ...pinned, versionId: randomUUID() },
        { ...pinned, checksum: 'sha256:' + '0'.repeat(64) },
      ])
        await command(
          a,
          { ...topicInput(a), references: [{ origin: 'file', file: invalid }] },
          409,
        );
      const input = {
        ...topicInput(a),
        references: [{ origin: 'file', file: pinned }],
      };
      await command(a, input);
      await command(a, input);
      // Immutable bytes cannot be tombstoned in-place. Change the current file
      // ACL instead, so both read and cached replay must see that denial.
      await f.db`insert into allrice_workbench_file_policies
        (object_id,organization_id,workspace_id,owner_id,file_name,scope)
        values(${pinned.objectId},${a.context.organizationId},${a.scope.workspaceId},${b.context.actor.id},'已撤权文件.txt','personal')`;
      await command(a, input, 403);
      await read(a, { view: 'topics' }, 403);
      const [count] =
        await f.db`select count(*)::int n from allrice_brand_content_requests
      where instance_id=${a.scope.instanceId} and request_id=${'brand-media:' + input.requestId}`;
      expect(count!.n).toBe(1);
    });

    it('validates exact reference source/revision pairs and current permission after a publication is revoked', async () => {
      const a = await actor(),
        b = await actor();
      await install(a);
      const selected = await reference(a),
        foreign = await reference(b);
      await command(
        a,
        {
          ...topicInput(a),
          references: [{ ...selected, sourceId: randomUUID() }],
        },
        409,
      );
      await command(a, { ...topicInput(a), references: [foreign] }, 409);
      const input = { ...topicInput(a), references: [selected] };
      await command(a, input);
      await command(a, input);
      const [policy] =
        await f.db`select revision from allrice_workbench_file_policies where reference_source_id=${selected.sourceId}`;
      await changeReferencePublication(a.context, selected.sourceId, {
        workspaceId: a.scope.workspaceId,
        requestId: randomUUID(),
        action: 'delete',
        expectedRevision: policy!.revision,
      });
      await read(a, { view: 'topics' }, 409);
      await command(a, input, 409);
    });

    it('preserves deliverables when removing an image or deleting an article and rejects fabricated image generation receipts', async () => {
      const a = await actor();
      await install(a);
      let article = await draft(a);
      const imageFile = await pictureFile(a),
        imageId = imageFile.objectId,
        versionId = imageFile.versionId;
      const image = {
        file: { ...imageFile, objectId: imageId, versionId },
        source: 'uploaded',
      };
      const added = await command(a, {
        operation: 'article.image.add',
        articleId: article.id,
        expectedRevision: article.revision,
        image,
      });
      if (added.result.kind !== 'article') throw Error('Expected article');
      article = added.result.article;
      expect(article.images).toEqual([image]);
      await command(
        a,
        {
          operation: 'article.image.add',
          articleId: article.id,
          expectedRevision: article.revision,
          image: { ...image, source: 'generated', operationId: randomUUID() },
        },
        409,
      );
      const removed = await command(a, {
        operation: 'article.image.remove',
        articleId: article.id,
        expectedRevision: article.revision,
        versionId,
      });
      if (removed.result.kind !== 'article') throw Error('Expected article');
      article = removed.result.article;
      expect(article.images).toEqual([]);
      await command(a, {
        operation: 'article.delete',
        articleId: article.id,
        expectedRevision: article.revision,
      });
      expect(
        (
          await f.db`select deleted_at from allrice_storage_objects where id=${imageId}`
        )[0]!.deleted_at,
      ).toBeNull();
      expect(
        await f.db`select id from allrice_deliverable_versions where id=${versionId}`,
      ).toHaveLength(1);
    });

    it('reads a complete local DST month beyond 201 and paginates tied/sub-millisecond creation times without loss', async () => {
      const a = await actor();
      await install(a);
      await f.db`with topics as (
      insert into allrice_brand_media_topics
        (id,organization_id,workspace_id,owner_id,instance_id,candidate,direction,source_run_id,created_at)
      select gen_random_uuid(),${a.context.organizationId},${a.scope.workspaceId},${a.context.actor.id},${a.scope.instanceId},
        jsonb_build_object('title','月排期'||n,'summary','合成月历'),'月历验收',${a.base.task.runId},
        '2026-11-10T12:00:00.123Z'::timestamptz+(n%103)*interval '1 microsecond'
      from generate_series(1,209) n returning id,candidate,created_at
    ) insert into allrice_brand_media_articles(id,organization_id,workspace_id,owner_id,instance_id,topic_id,title,created_at)
      select gen_random_uuid(),${a.context.organizationId},${a.scope.workspaceId},${a.context.actor.id},${a.scope.instanceId},id,candidate->>'title',created_at from topics`;
      await f.db`update allrice_brand_media_articles set state='scheduled',revision=revision+1,
      planned_at='2026-03-20T12:00:00Z',timezone='America/Los_Angeles' where instance_id=${a.scope.instanceId} and revision=1`;
      const edges = [
        '2026-03-01T07:59:59Z',
        '2026-03-01T08:00:00Z',
        '2026-04-01T06:59:59Z',
        '2026-04-01T07:00:00Z',
      ];
      const rows = await f.db<
        { id: string }[]
      >`select id from allrice_brand_media_articles where instance_id=${a.scope.instanceId} order by id limit 4`;
      for (let i = 0; i < edges.length; i++)
        await f.db`update allrice_brand_media_articles set planned_at=${edges[i]!},revision=revision+1
      where id=${rows[i]!.id} and revision=2`;
      const month = await read(a, {
        view: 'calendar',
        month: '2026-03',
        timezone: 'America/Los_Angeles',
      });
      if (month.view !== 'calendar') throw Error('Expected calendar');
      expect(month.items).toHaveLength(207);
      const ids = month.items.map((x) => x.id);
      expect(ids).toContain(rows[1]!.id);
      expect(ids).toContain(rows[2]!.id);
      expect(ids).not.toContain(rows[0]!.id);
      expect(ids).not.toContain(rows[3]!.id);
      let cursor: { createdAt: string; id: string } | null = null;
      const all: string[] = [],
        sizes: number[] = [];
      do {
        const page = await read(a, {
          view: 'articles',
          state: 'scheduled',
          ...(cursor ? { cursor: JSON.stringify(cursor) } : {}),
        });
        if (page.view !== 'articles') throw Error('Expected article page');
        all.push(...page.items.map((x) => x.id));
        sizes.push(page.items.length);
        cursor = page.nextCursor;
      } while (cursor !== null);
      expect(sizes).toEqual([100, 100, 9]);
      expect(new Set(all).size).toBe(209);
      const ordered = await f.db<
        { id: string }[]
      >`select id from allrice_brand_media_articles where instance_id=${a.scope.instanceId} order by created_at desc,id desc`;
      expect(all).toEqual(ordered.map((x) => x.id));
      expect(await read(a, { view: 'topics' })).toMatchObject({
        items: [],
        nextCursor: null,
      });
    });

    it('reads populated module/topic/article/reference/file paths without row locks while human writes still hold the binding gate', async () => {
      const a = await actor();
      await install(a);
      const pinned = await file(a),
        selected = await reference(a);
      const references: BrandMediaTopic['references'] = [
        { origin: 'file', file: pinned },
        selected,
      ];
      await topic(a, { references });
      const article = await draft(a, references);
      await f.db`update allrice_brand_media_articles set body_file=${f.db.json(pinned)},revision=revision+1
        where id=${article.id} and revision=1`;
      const reader = createReadPathProbe(f.db);
      const database = vi.mocked(client.getDatabase);
      database.mockReturnValue(reader.db);
      try {
        expect(
          (await catalog.GET(request(a, 'modules'), params(a.scope.instanceId)))
            .status,
        ).toBe(200);
        const queries: Record<string, string>[] = [
          { view: 'topics' },
          { view: 'articles' },
          { view: 'article', articleId: article.id },
          { view: 'calendar', month: '2026-11', timezone: 'Asia/Shanghai' },
        ];
        for (const query of queries) await read(a, query);
        reader.expectNoRowLocks();
        expect(reader.transactions).toHaveLength(5);
      } finally {
        database.mockReturnValue(f.db);
      }
      const writer = createReadPathProbe(f.db, {
        beforeCommit: async () => {
          await expect(
            f.db.begin(async (tx) => {
              await tx`select module_id from allrice_employee_module_bindings
            where organization_id=${a.context.organizationId} and workspace_id=${a.scope.workspaceId}
              and owner_id=${a.context.actor.id} and instance_id=${a.scope.instanceId}
              and module_id=${brandMediaRelease.moduleId} for update nowait`;
            }),
          ).rejects.toMatchObject({ code: '55P03' });
        },
      });
      database.mockReturnValue(writer.db);
      try {
        await command(a, topicInput(a));
        expect(writer.transactions.some((t) => t.xid !== null)).toBe(true);
      } finally {
        database.mockReturnValue(f.db);
      }
    });

    it.each(['pin', 'body', 'image', 'replay'] as const)(
      'holds the existing %s file policy through final validation and commit, then denies the revoked request',
      async (kind) => {
        const { a, b, pinned, input } = await filePolicyCase(kind);
        let revocation: Promise<void> | undefined;
        let revocationError: unknown;
        let revokeCommitted = false;
        const writer = createReadPathProbe(f.db, {
          beforeCommit: async (tx) => {
            const [writerPid] = await tx`select pg_backend_pid() pid`;
            let announce!: (pid: number) => void;
            const started = new Promise<number>((resolve) => {
              announce = resolve;
            });
            revocation = f.db
              .begin(async (other) => {
                const [pid] = await other`select pg_backend_pid() pid`;
                announce(pid!.pid);
                await other`update allrice_workbench_file_policies set owner_id=${b.context.actor.id},revision=revision+1
                where object_id=${pinned.objectId} and organization_id=${a.context.organizationId}
                  and workspace_id=${a.scope.workspaceId} and owner_id=${a.context.actor.id}`;
              })
              .then(
                () => {
                  revokeCommitted = true;
                },
                (error) => {
                  revocationError = error;
                },
              );
            await expectBlocked(await started, writerPid!.pid);
            expect(revokeCommitted).toBe(false);
          },
        });
        const database = vi.mocked(client.getDatabase);
        database.mockReturnValue(writer.db);
        let result;
        try {
          result = await command(a, input);
        } finally {
          database.mockReturnValue(f.db);
          await revocation;
        }
        expect(revocationError).toBeUndefined();
        expect(revokeCommitted).toBe(true);
        expect(result.replayed).toBe(kind === 'replay');
        const before = await businessState(a);
        await command(a, input, 403);
        expect(await businessState(a)).toEqual(before);
      },
    );

    it.each(['pin', 'body', 'image', 'replay'] as const)(
      'waits for an earlier %s policy revocation and rejects the pending write or replay without persistence',
      async (kind) => {
        const { a, b, pinned, input } = await filePolicyCase(kind);
        const before = await businessState(a);
        let announce!: (pid: number) => void;
        const started = new Promise<number>((resolve) => {
          announce = resolve;
        });
        const writer = createReadPathProbe(f.db, {
          afterStart: async (tx) => {
            const [pid] = await tx`select pg_backend_pid() pid`;
            announce(pid!.pid);
          },
        });
        const database = vi.mocked(client.getDatabase);
        let response: Promise<Response> | undefined;
        try {
          await f.db.begin(async (other) => {
            const [revokerPid] = await other`select pg_backend_pid() pid`;
            await other`update allrice_workbench_file_policies set owner_id=${b.context.actor.id},revision=revision+1
              where object_id=${pinned.objectId} and organization_id=${a.context.organizationId}
                and workspace_id=${a.scope.workspaceId} and owner_id=${a.context.actor.id}`;
            database.mockReturnValue(writer.db);
            response = business.POST(
              request(a, 'brand-media', { ...a.scope, ...input }),
              params(a.scope.instanceId),
            );
            await expectBlocked(
              await Promise.race([
                started,
                response.then(() => {
                  throw Error(
                    'request completed before entering its transaction',
                  );
                }),
              ]),
              revokerPid!.pid,
            );
          });
          expect((await response!).status).toBe(403);
        } finally {
          database.mockReturnValue(f.db);
          await response;
        }
        expect(await businessState(a)).toEqual(before);
      },
    );

    it('keeps core-table access out of the business repository', async () => {
      const repo = await readFile(
        new URL(
          '../../../packages/database/src/brand-media/repository.ts',
          import.meta.url,
        ),
        'utf8',
      );
      expect([...new Set(repo.match(/allrice_[a-z_]+/g))].sort()).toEqual([
        'allrice_brand_media_articles',
        'allrice_brand_media_topics',
      ]);
      const imports = [...repo.matchAll(/from ['"]([^'"]+)['"]/g)].map(
        (m) => m[1],
      );
      expect(imports).toEqual([
        'node:crypto',
        'postgres',
        '@allrice/contracts',
        './errors.ts',
      ]);
    });

    async function generationActor(
      tools = [
        'workspace.export.create',
        'workspace.skill.read',
        'workspace.document.read',
      ],
      denied: string[] = [],
    ) {
      const a = await actor(),
        versionId = randomUUID();
      const manifest = EmployeeDefinitionSchema.parse({
        ...a.manifest,
        capabilityBindings: {
          ...a.manifest.capabilityBindings,
          toolNames: tools,
        },
        securityPolicy: {
          ...a.manifest.securityPolicy,
          deniedCapabilities: denied,
        },
      });
      await f.db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
        select ${versionId},organization_id,workspace_id,employee_id,version+1,name,model,system_prompt,capabilities,
          ${employeeManifestChecksum(manifest)},${f.db.json(manifest)},provider_snapshot from allrice_employee_versions where id=${a.currentVersionId}`;
      await f.db`update allrice_employee_assignments set employee_version_id=${versionId} where id=${a.assignmentId}`;
      a.manifest = manifest;
      a.currentVersionId = versionId;
      await install(a);
      return a;
    }
    const candidateIntent = (a: Actor, patch: object = {}) => ({
      ...a.scope,
      requestId: randomUUID(),
      operation: 'candidates',
      direction: '参考已选资料，想几个新品选题',
      references: [],
      ...patch,
    });
    async function generate(
      a: Actor,
      input: Record<string, unknown> = candidateIntent(a),
      status = 200,
    ) {
      const response = await business.POST(
        request(a, 'brand-media', input),
        params(a.scope.instanceId),
      );
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(status);
      return result as {
        run: RunSnapshot;
        userMessage: { id: string; sessionId: string };
        created: boolean;
        delivery: string;
        fallbackRunId: string | null;
        error?: { code: string; message: string };
      };
    }
    async function execution(
      a: Actor,
      sent: Awaited<ReturnType<typeof generate>>,
    ) {
      const workerId = randomUUID(),
        leaseToken = randomUUID();
      const [job] =
        await f.db`update allrice_jobs set status='claimed',worker_id=${workerId},lease_token=${leaseToken},claimed_at=clock_timestamp(),heartbeat_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '5 minutes',available_at=clock_timestamp()
        where run_id=${sent.run.id} returning id`;
      const running = await startClaimedJob(workerId, job!.id, leaseToken);
      expect(running).not.toBeNull();
      const frozen = await resolveEmployeeExecution({
        organizationId: a.context.organizationId,
        workspaceId: a.scope.workspaceId,
        ownerId: a.context.actor.id,
        runId: sent.run.id,
      });
      return {
        context: running!.context,
        sessionId: sent.userMessage.sessionId,
        userMessageId: sent.userMessage.id,
        managedBrowserJobAttempt: running!.job.attempt,
        managedBrowserJobLeaseToken: leaseToken,
        capabilities: frozen.grantedCapabilities,
        nativeSkills: frozen.nativeSkills,
        storageRoot: f.storageRoot,
      };
    }
    async function productionContentGuard(
      a: Actor,
      sent: Awaited<ReturnType<typeof generate>>,
      run: Awaited<ReturnType<typeof execution>>,
    ) {
      const source = await readFile(
        new URL('../../worker/src/jobs/employee-run.ts', import.meta.url),
        'utf8',
      );
      const ast = ts.createSourceFile(
        'employee-run.ts',
        source,
        ts.ScriptTarget.Latest,
        true,
      );
      const initializers: ts.Expression[] = [];
      const visit = (node: ts.Node) => {
        if (
          ts.isVariableDeclaration(node) &&
          node.name.getText(ast) === 'contentGuard' &&
          node.initializer
        )
          initializers.push(node.initializer);
        ts.forEachChild(node, visit);
      };
      visit(ast);
      expect(initializers).toHaveLength(1);
      // The real handler also passes this exact object into HarnessExecutionInput.
      expect(source).toContain('contentGuard,');
      const scope = {
        organizationId: a.context.organizationId,
        workspaceId: a.scope.workspaceId,
        ownerId: a.context.actor.id,
        sessionId: sent.userMessage.sessionId,
        runId: sent.run.id,
      };
      const contentRuntime = await prepareEmployeeContentContext(scope);
      const resolved = await resolveEmployeeExecution(scope);
      await acquireConversationRuntime({
        ...scope,
        workerId: run.context.worker.id,
        configChecksum: employeeManifestChecksum(a.manifest),
        compactThresholdTokens: 40000,
      });
      const code = ts.transpileModule(`(${initializers[0]!.getText(ast)})`, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.None,
        },
      }).outputText;
      const { HandlerError } = await import(
        new URL('../../worker/src/errors.ts', import.meta.url).href
      );
      return runInNewContext(code, {
        contentRuntime,
        resolved,
        execution: { context: run.context },
        contentScope: scope,
        workflowLease: {
          workerId: run.context.worker.id,
          jobId: run.context.jobId,
          leaseToken: run.managedBrowserJobLeaseToken,
        },
        assertEmployeeContentContext,
        EmployeeRuntimeContentError,
        HandlerError,
        appendJobEvent: async () => {},
        contentEvidence: undefined,
      }) as { generationId: string; check: () => Promise<void> };
    }
    async function broker(
      input: Awaited<ReturnType<typeof execution>>,
      name: string,
      args: Record<string, unknown>,
      callId = randomUUID(),
    ) {
      const path = new URL('../../worker/src/tool-broker.ts', import.meta.url)
        .href;
      const { executeRiceTool } = (await import(path)) as {
        executeRiceTool: (
          input: object,
        ) => Promise<{ modelContent: string; summary: string }>;
      };
      return executeRiceTool({
        ...input,
        call: { id: callId, name, arguments: args },
      });
    }
    async function finish(runId: string) {
      const [job] = await f.db<
        { id: string; worker_id: string; lease_token: string }[]
      >`select id,worker_id,lease_token from allrice_jobs where run_id=${runId} and status='running'`;
      expect(job).toBeDefined();
      await completeJob({
        workerId: job!.worker_id,
        jobId: job!.id,
        leaseToken: job!.lease_token,
        result: {},
      });
      expect(
        await f.db`select j.status,j.worker_id,j.lease_token,j.claimed_at,j.heartbeat_at,j.lease_expires_at,r.state,er.status employee_status
          from allrice_jobs j join allrice_runs r on r.id=j.run_id join allrice_employee_runs er on er.run_id=r.id where r.id=${runId}`,
      ).toMatchObject([
        {
          status: 'succeeded',
          worker_id: null,
          lease_token: null,
          claimed_at: null,
          heartbeat_at: null,
          lease_expires_at: null,
          state: 'succeeded',
          employee_status: 'succeeded',
        },
      ]);
    }
    const sampleCandidates = {
      candidates: [
        { title: '下班后的十分钟', summary: '面向通勤上班族' },
        { title: '冬日新品故事', summary: '面向已有客户' },
      ],
    };
    it('“先想几个选题，我来选” crosses login HTTP → frozen Run → real Broker → immutable JSON and only a human adds a topic', async () => {
      const a = await generationActor(),
        input = candidateIntent(a);
      const first = await generate(a, input),
        replay = await generate(a, input);
      expect(replay.run.id).toBe(first.run.id);
      expect(replay.userMessage.id).toBe(first.userMessage.id);
      expect(first.delivery).toBe('immediate');
      const session = (
        await f.db`select * from allrice_chat_sessions where id=${first.userMessage.sessionId}`
      )[0]!;
      expect(session.employee_instance_id).toBe(a.scope.instanceId);
      expect(session.account_capability_snapshot).not.toBeNull();
      const [frozenTools] =
        await f.db`select execution_snapshot from allrice_employee_runs where run_id=${first.run.id}`;
      const names: string[] =
        frozenTools!.execution_snapshot.capabilitySnapshot.bindings.toolNames;
      expect(
        names.filter((name) => name === 'workspace.skill.read'),
      ).toHaveLength(1);
      expect(
        names.filter((name) =>
          [
            'workspace.export.create',
            'workspace.skill.read',
            'workspace.document.read',
          ].includes(name),
        ),
      ).toEqual([
        'workspace.export.create',
        'workspace.skill.read',
        'workspace.document.read',
      ]);
      const run = await execution(a, first),
        callId = randomUUID();
      const result = await broker(
        run,
        'workspace.brand_media.candidates',
        sampleCandidates,
        callId,
      );
      const receipt = BrandMediaCandidatesResultSchema.parse(
        JSON.parse(result.modelContent),
      );
      expect(receipt).toMatchObject({
        ...sampleCandidates,
        runId: first.run.id,
        addedToTopics: false,
      });
      expect(await read(a, { view: 'topics' })).toMatchObject({ items: [] });
      expect(
        BrandMediaCandidatesResultSchema.parse(
          JSON.parse(
            (
              await broker(
                run,
                'workspace.brand_media.candidates',
                sampleCandidates,
                callId,
              )
            ).modelContent,
          ),
        ),
      ).toEqual(receipt);
      await finish(first.run.id);
      const recovered = await business.GET(
        request(a, 'brand-media', undefined, '?view=runs'),
        params(a.scope.instanceId),
      );
      expect(recovered.status).toBe(200);
      const recovery = await recovered.json();
      expect(recovery.runs[0].run).toMatchObject({
        id: first.run.id,
        status: 'succeeded',
      });
      expect(JSON.parse(recovery.runs[0].deliveries[0].content)).toEqual(
        sampleCandidates,
      );
      const add = {
        operation: 'topic.add',
        requestId: randomUUID(),
        candidate: sampleCandidates.candidates[0],
        direction: input.direction,
        references: [],
        sourceRunId: first.run.id,
      };
      const selected = await command(a, add),
        selectedAgain = await command(a, add);
      expect(selectedAgain).toEqual({ ...selected, replayed: true });
      expect(await read(a, { view: 'topics' })).toMatchObject({
        items: [
          {
            candidate: sampleCandidates.candidates[0],
            sourceRunId: first.run.id,
          },
        ],
      });
      if (selected.result.kind !== 'topic')
        throw Error('Expected human selection');
      await command(a, {
        operation: 'article.start',
        topicId: selected.result.topic.id,
        expectedRevision: 1,
        requirements: '',
        references: [],
      });
      const reopened = await business.GET(
        request(a, 'brand-media', undefined, '?view=runs'),
        params(a.scope.instanceId),
      );
      expect(reopened.status).toBe(200);
      expect((await reopened.json()).runs[0].addedCandidates).toEqual([
        sampleCandidates.candidates[0],
      ]);
      expect(await read(a, { view: 'topics' })).toMatchObject({ items: [] });
    });
    it('queues a new fixed article Run behind an active Run without a steer command or mutating the old snapshot, including replay', async () => {
      const a = await generationActor(),
        session = await createChatSession(a.context, {
          workspaceId: a.scope.workspaceId,
          employeeInstanceId: a.scope.instanceId,
          title: '已有对话',
        });
      const first = await generate(
        a,
        candidateIntent(a, { sessionId: session.id }),
      );
      await execution(a, first);
      const [old] =
        await f.db`select execution_snapshot from allrice_employee_runs where run_id=${first.run.id}`;
      // Establish the ordinary native runtime's active turn, as the real Worker does.
      await f.db`insert into allrice_conversation_runtimes(session_id,organization_id,workspace_id,owner_id,thread_id,thread_generation,active_run_id,active_turn_id,state,worker_id,provider,config_checksum)
        values(${session.id},${a.context.organizationId},${a.scope.workspaceId},${a.context.actor.id},${randomUUID()},1,${first.run.id},'active-module-fixture','running',${randomUUID()},'dsh',${employeeManifestChecksum(a.manifest)})
        on conflict(session_id) do update set active_run_id=excluded.active_run_id,active_turn_id=excluded.active_turn_id,state='running'`;
      const article = await draft(a),
        intent = candidateIntent(a, {
          sessionId: session.id,
          operation: 'article',
          articleId: article.id,
          expectedRevision: article.revision,
          instructions: '写正文',
        });
      delete (intent as Record<string, unknown>).direction;
      const next = await generate(a, intent),
        replay = await generate(a, intent);
      expect(next.run.id).not.toBe(first.run.id);
      expect(next.delivery).toBe('follow_up');
      expect(replay.run.id).toBe(next.run.id);
      expect(next.fallbackRunId).toBe(next.run.id);
      expect(
        (
          await f.db`select execution_snapshot from allrice_employee_runs where run_id=${first.run.id}`
        )[0],
      ).toEqual(old);
      const [newer] =
        await f.db`select execution_snapshot from allrice_employee_runs where run_id=${next.run.id}`;
      expect(newer!.execution_snapshot.moduleInvocation.intent).toMatchObject({
        operation: 'article',
        articleId: article.id,
        expectedRevision: article.revision,
      });
      expect(
        await f.db`select * from allrice_conversation_commands where followup_run_id=${next.run.id}`,
      ).toHaveLength(0);
      const beforeConflicts =
        await f.db`select id from allrice_runs where owner_id=${a.context.actor.id} order by id`;
      await generate(
        a,
        { ...intent, expectedRevision: article.revision + 1 },
        409,
      );
      const otherArticle = await draft(a);
      expect(
        (await generate(a, { ...intent, articleId: otherArticle.id }, 409))
          .error,
      ).toMatchObject({
        code: 'CONFLICT',
        message: '相同提交编号已用于另一项生成，请核对原结果。',
      });
      await generate(
        a,
        {
          ...intent,
          references: [
            {
              origin: 'reference',
              sourceId: randomUUID(),
              revisionId: randomUUID(),
            },
          ],
        },
        409,
      );
      expect(
        await f.db`select id from allrice_runs where owner_id=${a.context.actor.id} order by id`,
      ).toEqual(beforeConflicts);
    });
    it('fixed no-chat Session retries once, a new request survives previous module Session archival, and normal chat digests are unchanged', async () => {
      const a = await generationActor(),
        intent = candidateIntent(a);
      const first = await generate(a, intent),
        again = await generate(a, intent);
      expect(again.run.id).toBe(first.run.id);
      expect(
        await f.db`select id from allrice_chat_sessions where id=${first.userMessage.sessionId}`,
      ).toHaveLength(1);
      await f.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${first.userMessage.sessionId}`;
      const next = await generate(a, candidateIntent(a));
      expect(next.userMessage.sessionId).not.toBe(first.userMessage.sessionId);
      const session = await createChatSession(a.context, {
        workspaceId: a.scope.workspaceId,
        employeeInstanceId: a.scope.instanceId,
        title: '普通聊天',
      });
      const { SendChatMessageInputSchema } = await import('@allrice/contracts');
      const message = SendChatMessageInputSchema.parse({
        text: '只读说明',
        clientMessageId: randomUUID(),
      });
      const sent = await sendChatMessage(
        a.context,
        a.scope.workspaceId,
        session.id,
        message,
      );
      const [digest] =
        await f.db`select request_digest from allrice_chat_input_requests where user_message_id=${sent.userMessage.id}`;
      expect(digest!.request_digest).toBe(
        'sha256:' +
          createHash('sha256').update(JSON.stringify(message)).digest('hex'),
      );
      expect(
        (
          await f.db`select execution_snapshot from allrice_employee_runs where run_id=${sent.run.id}`
        )[0]!.execution_snapshot,
      ).not.toHaveProperty('moduleInvocation');
    });
    it('freezes the complete registered tool source through HTTP and preserves the separate 64-tool frozen DTO boundary', async () => {
      // The current source validator knows 56 tools, including this module.
      // An unknown publication is not a way to reach the DTO's 64-slot limit.
      const registered = allRiceToolManifest.map((tool) => tool.canonicalName);
      expect(registered).toHaveLength(56);
      expect(new Set(registered).size).toBe(56);
      const a = await generationActor(registered);
      await updateUserPreferences(a.context, {
        capabilities: {
          [cloudProjectCapabilityId]: { configVersion: 1, enabled: true },
        },
      });
      const sent = await generate(a);
      const frozen = (
        await resolveEmployeeExecution({
          organizationId: a.context.organizationId,
          workspaceId: a.scope.workspaceId,
          ownerId: a.context.actor.id,
          runId: sent.run.id,
        })
      ).executionSnapshot!;
      expect(frozen.schemaVersion).toBe(2);
      if (frozen.schemaVersion !== 2) throw Error('Requires V2 freeze');
      expect(
        EmployeeDefinitionSchema.parse(frozen.employee.definition)
          .capabilityBindings.toolNames,
      ).toEqual(registered);
      // Owner fixture has no connected Bridge. The general-instance policy
      // also withholds the custom-only brand-content reader. All other exact
      // published names, including existing module/Skill names, remain once.
      const unavailable = new Set([
        'workspace.brand_content.read',
        'local.fs.list',
        'local.fs.search',
        'local.fs.read',
        'local.fs.write',
        'local.fs.mkdir',
        'local.git.status',
        'local.git.diff',
        'local.process.execute',
        'local.process.status',
        'local.process.stop',
        'local.file.inspect',
        'local.file.derive',
        'local.file.save',
        'local.preview.open',
        'local.browser.workspace',
      ]);
      const names = frozen.capabilitySnapshot.bindings.toolNames;
      expect(names).toHaveLength(40);
      expect(new Set(names).size).toBe(40);
      expect([...names].sort()).toEqual(
        registered.filter((name) => !unavailable.has(name)).sort(),
      );
      const additions = [
        ...brandMediaTools.map((tool) => tool.canonicalName),
        'workspace.skill.read',
      ];
      // Synthetic names are confined to the existing frozen DTO reader. This
      // asserts its unchanged base capacity, not an admitted employee source.
      const original = Array.from(
        { length: 64 },
        (_, index) => `fixture.frozen.${index}`,
      );
      expect(original).toHaveLength(64);
      const boundary = EmployeeExecutionSnapshotSchema.parse({
        ...frozen,
        capabilitySnapshot: {
          ...frozen.capabilitySnapshot,
          bindings: {
            ...frozen.capabilitySnapshot.bindings,
            toolNames: [...original, ...additions],
          },
        },
      });
      expect(boundary.capabilitySnapshot.bindings.toolNames).toEqual([
        ...original,
        ...additions,
      ]);
      const plain = JSON.parse(JSON.stringify(boundary));
      delete plain.modules;
      delete plain.moduleInvocation;
      plain.capabilitySnapshot.bindings.toolNames = original;
      expect(JSON.stringify(EmployeeExecutionSnapshotSchema.parse(plain))).toBe(
        JSON.stringify(plain),
      );
      for (const candidate of [
        {
          ...plain,
          capabilitySnapshot: {
            ...plain.capabilitySnapshot,
            bindings: {
              ...plain.capabilitySnapshot.bindings,
              toolNames: [...original, 'fixture.overflow'],
            },
          },
        },
        {
          ...boundary,
          capabilitySnapshot: {
            ...boundary.capabilitySnapshot,
            bindings: {
              ...boundary.capabilitySnapshot.bindings,
              toolNames: [
                ...original,
                ...additions.slice(1),
                'fixture.overflow',
              ],
            },
          },
        },
        {
          ...boundary,
          modules: frozen.modules!.map((module) => ({
            ...module,
            release: { ...module.release, digest: 'sha256:' + '0'.repeat(64) },
          })),
        },
      ])
        expect(
          EmployeeExecutionSnapshotSchema.safeParse(candidate).success,
        ).toBe(false);
      expect(
        EmployeeExecutionSnapshotV1Schema.shape.capabilitySnapshot.shape.bindings.safeParse(
          {
            ...plain.capabilitySnapshot.bindings,
            toolNames: [...original, 'fixture.overflow'],
          },
        ).success,
      ).toBe(false);
      expect(
        EmployeeDefinitionSchema.safeParse({
          ...a.manifest,
          capabilityBindings: {
            ...a.manifest.capabilityBindings,
            toolNames: Array.from(
              { length: 65 },
              (_, index) => `fixture.${index}`,
            ),
          },
        }).success,
      ).toBe(false);
    });
    it('rejects an unknown tool source through HTTP without admitting any Run', async () => {
      const a = await generationActor([
        'workspace.export.create',
        'fixture.unknown.source',
      ]);
      const before =
        await f.db`select id from allrice_runs where owner_id=${a.context.actor.id} order by id`;
      expect((await generate(a, candidateIntent(a), 500)).error).toMatchObject({
        code: 'INTERNAL_ERROR',
      });
      expect(
        await f.db`select id from allrice_runs where owner_id=${a.context.actor.id} order by id`,
      ).toEqual(before);
      expect(
        await f.db`select run_id from allrice_employee_runs where owner_id=${a.context.actor.id} and run_id<>${a.base.task.runId}`,
      ).toHaveLength(0);
    });
    it.each([
      { tools: [] },
      { tools: ['workspace.document.read'] },
      { tools: ['workspace.export.create'] },
    ])(
      'adds no grants from module tools or Skill for original selected tools $tools',
      async ({ tools }) => {
        const a = await actor(),
          scope = {
            ...a.scope,
            organizationId: a.context.organizationId,
            ownerId: a.context.actor.id,
          };
        await install(a);
        const original = tools.includes('workspace.export.create')
          ? (['storage:read', 'storage:write'] as const)
          : (['storage:read'] as const);
        const frozen = await freezeBrandMediaModule(scope, original);
        expect(frozen?.binding.release).toEqual(brandMediaRelease);
        expect(frozen?.tools.includes('workspace.brand_media.candidates')).toBe(
          original.includes('storage:write' as never),
        );
        expect(frozen?.skill?.requiredToolRefs).toEqual([
          'workspace.skill.read',
        ]);
        expect(original).toEqual(
          tools.includes('workspace.export.create')
            ? ['storage:read', 'storage:write']
            : ['storage:read'],
        );
        const resource = readFrozenSkillResource(
          [frozen!.skill!],
          'brand-media',
          brandMediaUsage.path,
        );
        expect(Buffer.from(resource.contentBase64, 'base64').toString()).toBe(
          brandMediaUsage.content,
        );
        expect(resource.checksum).toBe(brandMediaUsage.checksum);
      },
    );
    it('read-only and explicit denied write employees cannot gain write by installing; old 0.1 bindings never hot-upgrade', async () => {
      for (const a of [
        await generationActor(['workspace.document.read']),
        await generationActor(undefined, ['storage:write']),
      ]) {
        const input = candidateIntent(a);
        await generate(a, input, 403);
        const source = (
          await f.db`select manifest from allrice_employee_versions where id=${a.currentVersionId}`
        )[0]!.manifest;
        expect(source.capabilityBindings.toolNames).not.toContain(
          'workspace.brand_media.candidates',
        );
      }
      const moduleOnly = await generationActor([
        'workspace.brand_media.candidates',
      ]);
      await generate(moduleOnly, candidateIntent(moduleOnly), 403);
      const a = await generationActor();
      await f.db`update allrice_employee_module_bindings set content_version='0.1.0',digest=${brandMediaModuleV010.digest} where instance_id=${a.scope.instanceId}`;
      expect((await generate(a, candidateIntent(a), 409)).error).toMatchObject({
        code: 'VERSION_CONFLICT',
      });
      expect(
        await f.db`select content_version from allrice_employee_module_bindings where instance_id=${a.scope.instanceId}`,
      ).toMatchObject([{ content_version: '0.1.0' }]);
      const response = await catalog.POST(
        request(a, 'modules', installInput(a)),
        params(a.scope.instanceId),
      );
      expect(response.status).toBe(409);
    });
    it.each(['same', 'distinct'] as const)(
      'counts stable module dependencies rather than Run identities across 129 %s-input Runs',
      async (dependencies) => {
        const a = await generationActor();
        const firstFile = await file(a);
        const pins: BrandMediaTopic['references'] = [
          { origin: 'file', file: firstFile },
        ];
        if (dependencies === 'same')
          pins.push({ origin: 'file', file: await file(a) });
        const sent = await generate(
          a,
          candidateIntent(a, { references: pins }),
        );
        const worker = await execution(a, sent);
        const guard = await productionContentGuard(a, sent, worker);
        await guard.check();
        const [initial] =
          await f.db`select content_generation_id,execution_snapshot::text frozen from allrice_employee_runs where run_id=${sent.run.id}`;
        expect(initial!.content_generation_id).toEqual(expect.any(String));
        const scope = {
          organizationId: a.context.organizationId,
          workspaceId: a.scope.workspaceId,
          ownerId: a.context.actor.id,
          sessionId: sent.userMessage.sessionId,
        };
        for (let index = 1; index < 129; index++) {
          const references: BrandMediaTopic['references'] =
            dependencies === 'distinct'
              ? [{ origin: 'file', file: await file(a) }]
              : index % 2
                ? [...pins].reverse()
                : pins;
          const next = await generate(
            a,
            candidateIntent(a, {
              sessionId: scope.sessionId,
              direction: '独立请求 ' + index,
              references,
            }),
          );
          const runtime = await prepareEmployeeContentContext({
            ...scope,
            runId: next.run.id,
          });
          expect(runtime?.generationId).toBe(initial!.content_generation_id);
        }
        const [counts] =
          await f.db`select count(distinct er.run_id)::int runs,count(distinct er.execution_snapshot#>>'{moduleInvocation,intent,requestId}')::int requests,
            count(distinct pin#>>'{file,versionId}')::int files
          from allrice_employee_runs er cross join lateral jsonb_array_elements(er.execution_snapshot#>'{moduleInvocation,intent,references}') pin
          where er.content_generation_id=${initial!.content_generation_id}`;
        expect(counts).toMatchObject({
          runs: 129,
          requests: 129,
          files: dependencies === 'same' ? 2 : 129,
        });
        expect(
          (
            await f.db`select execution_snapshot::text frozen from allrice_employee_runs where run_id=${sent.run.id}`
          )[0]!.frozen,
        ).toBe(initial!.frozen);
        if (dependencies === 'distinct') {
          await expect(guard.check()).rejects.toMatchObject({
            code: 'EMPLOYEE_CONTENT_UNAVAILABLE',
          });
          return;
        }
        await expect(guard.check()).resolves.toBeUndefined();
        // The same normalized dependency set still locks its actual source Session.
        let entered!: (pid: number) => void, release!: () => void;
        const acquired = new Promise<number>((resolve) => {
          entered = resolve;
        });
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const holder = f.db.begin(async (tx) => {
          const [backend] = await tx`select pg_backend_pid() pid`;
          await tx`select id from allrice_chat_sessions where id=${a.base.task.chatSessionId} for update`;
          entered(backend!.pid);
          await held;
        });
        const holderPid = await acquired;
        const checking = guard.check().then(
          () => true,
          (error: unknown) => error,
        );
        try {
          await expect
            .poll(
              async () =>
                (
                  await f.db`select count(*)::int n from pg_stat_activity where ${holderPid}::int=any(pg_blocking_pids(pid))`
                )[0]!.n,
              { timeout: 5000 },
            )
            .toBeGreaterThan(0);
        } finally {
          release();
          await holder;
        }
        expect(await checking).toBe(true);
        // Archive preserves owner read access; only an actual file-policy
        // withdrawal below revokes the fixed input at this same model gate.
        await f.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${a.base.task.chatSessionId}`;
        await expect(guard.check()).resolves.toBeUndefined();
        const other = await actor();
        await f.db`insert into allrice_workbench_file_policies
          (object_id,organization_id,workspace_id,owner_id,file_name,scope)
          values(${firstFile.objectId},${a.context.organizationId},${a.scope.workspaceId},${other.context.actor.id},'已撤权固定参考.txt','personal')`;
        await expect(guard.check()).rejects.toMatchObject({
          code: 'EMPLOYEE_CONTENT_UNAVAILABLE',
        });
      },
      120000,
    );

    it('rebuilds the exact selected candidate summary, direction and optional requirements for a fresh article Session without trusting client facts', async () => {
      const a = await generationActor(),
        direction = '面向通勤族，写下班后十分钟的真实体验';
      const candidates = await generate(a, candidateIntent(a, { direction }));
      const firstRun = await execution(a, candidates);
      await broker(
        firstRun,
        'workspace.brand_media.candidates',
        sampleCandidates,
      );
      await finish(candidates.run.id);
      const selected = await command(a, {
        operation: 'topic.add',
        candidate: sampleCandidates.candidates[0],
        direction,
        sourceRunId: candidates.run.id,
        references: [],
      });
      if (selected.result.kind !== 'topic') throw Error('Expected topic');
      const started = await command(a, {
        operation: 'article.start',
        topicId: selected.result.topic.id,
        expectedRevision: 1,
        requirements: '',
        references: [],
      });
      if (started.result.kind !== 'article') throw Error('Expected article');
      expect(await read(a, { view: 'topics' })).toMatchObject({ items: [] });
      const intent = {
        ...a.scope,
        operation: 'article',
        requestId: randomUUID(),
        articleId: started.result.article.id,
        expectedRevision: 1,
        instructions: '根据这个选题和已选资料写正文。',
        references: [],
      };
      const sent = await generate(a, intent);
      expect(sent.userMessage.sessionId).not.toBe(
        candidates.userMessage.sessionId,
      );
      const [row] =
        await f.db`select prompt_snapshot from allrice_employee_runs where run_id=${sent.run.id}`;
      const trusted = JSON.parse(
        row!.prompt_snapshot.userRequest.split(
          '服务端固定选题与写作要求：\n',
        )[1],
      );
      expect(trusted).toEqual({
        candidate: sampleCandidates.candidates[0],
        direction,
        requirements: '',
      });
      await generate(
        a,
        {
          ...intent,
          requestId: randomUUID(),
          candidate: { title: '伪造', summary: '伪造' },
          direction: '伪造',
        },
        422,
      );
    });

    it('isolates a deleted article with revoked references while recovering an unrelated delivery and retaining the native cancel path', async () => {
      const a = await generationActor(),
        pin = await reference(a),
        stale = await draft(a, [pin]);
      const first = await generate(a, {
        ...a.scope,
        operation: 'article',
        requestId: randomUUID(),
        articleId: stale.id,
        expectedRevision: stale.revision,
        instructions: '写完整',
        references: [pin],
      });
      const oldRun = await execution(a, first);
      await broker(oldRun, 'workspace.brand_media.article.submit', {
        articleId: stale.id,
        expectedRevision: 1,
        title: stale.title,
        body: '已保存但不再有来源权限的正文',
      });
      const saved = await articleRead(a, stale.id);
      await command(a, {
        operation: 'article.delete',
        articleId: stale.id,
        expectedRevision: saved.revision,
      });
      const legal = await draft(a),
        second = await generate(a, {
          ...a.scope,
          operation: 'article',
          requestId: randomUUID(),
          articleId: legal.id,
          expectedRevision: legal.revision,
          instructions: '写另一篇',
          references: [],
        });
      const newRun = await execution(a, second);
      await broker(newRun, 'workspace.brand_media.article.submit', {
        articleId: legal.id,
        expectedRevision: legal.revision,
        title: legal.title,
        body: '无关且合法的正文成果',
      });
      await finish(second.run.id);
      const [policy] =
        await f.db`select revision from allrice_workbench_file_policies where reference_source_id=${pin.sourceId}`;
      await changeReferencePublication(a.context, pin.sourceId, {
        workspaceId: a.scope.workspaceId,
        requestId: randomUUID(),
        action: 'delete',
        expectedRevision: policy!.revision,
      });
      const response = await business.GET(
        request(a, 'brand-media', undefined, '?view=runs'),
        params(a.scope.instanceId),
      );
      expect(response.status).toBe(200);
      const rows = (await response.json()).runs;
      expect(
        rows.find((row: { run: RunSnapshot }) => row.run.id === first.run.id),
      ).toMatchObject({
        unavailable: true,
        deliveries: [],
        run: { status: 'running' },
      });
      expect(
        rows.find((row: { run: RunSnapshot }) => row.run.id === second.run.id),
      ).toMatchObject({
        unavailable: false,
        deliveries: [{ content: '无关且合法的正文成果' }],
        submission: { articleUpdated: true },
      });
      await read(a, { view: 'article', articleId: stale.id }, 404);
      expect((await read(a, { view: 'articles' })).view).toBe('articles');
      const storageFailure = Error('synthetic storage outage');
      const brokenStorage: StoragePort = Object.create(
        runtimeFixtureStorage(f.db),
      );
      brokenStorage.get = async () => {
        throw storageFailure;
      };
      await expect(
        readBrandMediaRuns(a.context, a.scope, brokenStorage),
      ).rejects.toBe(storageFailure);
      await cancelRun(a.context, a.scope.workspaceId, first.run.id, {
        reason: '取消失效资料的生成',
      });
      const canceled = await business.GET(
        request(a, 'brand-media', undefined, '?view=runs'),
        params(a.scope.instanceId),
      );
      expect(
        (await canceled.json()).runs.find(
          (row: { run: RunSnapshot }) => row.run.id === first.run.id,
        ),
      ).toMatchObject({
        unavailable: true,
        deliveries: [],
        run: { status: 'running', cancelRequestedAt: expect.any(String) },
      });
    });

    it('“把这篇写完整” submits only the fixed article and preserves an immutable deliverable on late CAS conflicts', async () => {
      const a = await generationActor(),
        article = await draft(a);
      const intent = {
        ...a.scope,
        requestId: randomUUID(),
        operation: 'article',
        articleId: article.id,
        expectedRevision: article.revision,
        instructions: '把这篇写完整',
        references: [],
      };
      const sent = await generate(a, intent),
        run = await execution(a, sent),
        callId = randomUUID();
      const args = {
        articleId: article.id,
        expectedRevision: article.revision,
        title: '完整标题',
        body: '第一段正文。\n第二段正文。',
      };
      await expect(
        broker(run, 'workspace.brand_media.article.submit', {
          ...args,
          articleId: randomUUID(),
        }),
      ).rejects.toThrow();
      const result = await broker(
          run,
          'workspace.brand_media.article.submit',
          args,
          callId,
        ),
        receipt = BrandMediaArticleResultSchema.parse(
          JSON.parse(result.modelContent),
        );
      expect(receipt.articleUpdated).toBe(true);
      const saved = await articleRead(a, article.id);
      expect(saved).toMatchObject({
        title: args.title,
        revision: article.revision + 1,
        body: receipt.file,
      });
      expect(
        BrandMediaArticleResultSchema.parse(
          JSON.parse(
            (
              await broker(
                run,
                'workspace.brand_media.article.submit',
                args,
                callId,
              )
            ).modelContent,
          ),
        ),
      ).toMatchObject({
        articleUpdated: true,
        replayed: true,
        file: receipt.file,
      });
      await finish(sent.run.id);
      const savedRecovery = await business.GET(
        request(a, 'brand-media', undefined, '?view=runs'),
        params(a.scope.instanceId),
      );
      expect(savedRecovery.status).toBe(200);
      expect((await savedRecovery.json()).runs[0].submission).toEqual({
        articleUpdated: true,
        revision: saved.revision,
      });
      const nextIntent = {
        ...intent,
        requestId: randomUUID(),
        expectedRevision: saved.revision,
      };
      const next = await generate(a, nextIntent),
        nextRun = await execution(a, next);
      await publication(a, saved, { action: 'schedule', schedule });
      const conflict = BrandMediaArticleResultSchema.parse(
        JSON.parse(
          (
            await broker(nextRun, 'workspace.brand_media.article.submit', {
              ...args,
              expectedRevision: saved.revision,
              body: '迟到的改稿',
            })
          ).modelContent,
        ),
      );
      expect(conflict).toMatchObject({
        articleUpdated: false,
        conflict: 'version_conflict',
      });
      expect((await articleRead(a, article.id)).body).toEqual(receipt.file);
      expect(
        await f.db`select version_id from allrice_workbench_artifacts where version_id=${conflict.file.versionId}`,
      ).toHaveLength(1);
      await finish(next.run.id);
      const recovery = await business.GET(
        request(a, 'brand-media', undefined, '?view=runs'),
        params(a.scope.instanceId),
      );
      expect(recovery.status).toBe(200);
      const cold = await recovery.json();
      expect(cold.runs[0].submission).toEqual({
        articleUpdated: false,
        revision: null,
      });
      expect(
        cold.runs.some((row: { deliveries: { content: string }[] }) =>
          row.deliveries.some((delivery) => delivery.content === '迟到的改稿'),
        ),
      ).toBe(true);
    });
    it.each(['lease', 'cancel', 'module', 'instance', 'internal'] as const)(
      'refuses a real Broker call after %s authority loss without a candidate or business write',
      async (kind) => {
        const a = await generationActor(),
          sent = await generate(a),
          run = await execution(a, sent);
        if (kind === 'lease')
          await f.db`update allrice_jobs set lease_token=${randomUUID()} where id=${run.context.jobId}`;
        if (kind === 'cancel')
          await cancelRun(a.context, a.scope.workspaceId, sent.run.id, {
            reason: '真人取消',
          });
        if (kind === 'module')
          await f.db`update allrice_employee_module_bindings set revoked_at=clock_timestamp(),revision=revision+1 where instance_id=${a.scope.instanceId}`;
        if (kind === 'instance')
          await f.db`update allrice_employee_instances set archived_at=clock_timestamp() where id=${a.scope.instanceId}`;
        if (kind === 'internal') {
          // Existing durable automation source predicate; no regex intent or actor impersonation.
          await f.db`insert into allrice_platform_quality_checks(id,request_id,organization_id,workspace_id,owner_id,run_id,job_id,session_id,input_digest,frozen) values(${randomUUID()},${randomUUID()},${a.context.organizationId},${a.scope.workspaceId},${a.context.actor.id},${sent.run.id},${run.context.jobId},${run.sessionId},${'sha256:' + 'b'.repeat(64)},'{}')`;
        }
        await expect(
          broker(run, 'workspace.brand_media.candidates', sampleCandidates),
        ).rejects.toThrow();
        expect(
          await f.db`select * from allrice_workbench_artifacts where run_id=${sent.run.id}`,
        ).toHaveLength(0);
        const recovered = await read(
          a,
          { view: 'topics' },
          kind === 'module' ? 403 : kind === 'instance' ? 409 : 200,
        );
        expect(recovered).toMatchObject(
          kind === 'module'
            ? { error: { code: 'AUTHORIZATION_DENIED' } }
            : kind === 'instance'
              ? { error: { code: 'EMPLOYEE_INSTANCE_ARCHIVED' } }
              : { view: 'topics', items: [] },
        );
      },
    );
    it('rejects browser-forged invocation/steer/actor and cross-origin writes, and gates module Skill resources by current lease/binding', async () => {
      const a = await generationActor();
      for (const forged of [
        { deliveryMode: 'steer' },
        { moduleInvocation: {} },
        { actorId: a.context.actor.id },
      ])
        await generate(a, candidateIntent(a, forged), 422);
      const req = request(a, 'brand-media', candidateIntent(a));
      req.headers.set('origin', 'https://attacker.test');
      expect(
        (await business.POST(req, params(a.scope.instanceId))).status,
      ).toBe(403);
      const moduleRequest = request(a, 'modules', installInput(a));
      moduleRequest.headers.set('origin', 'https://attacker.test');
      expect(
        (await catalog.POST(moduleRequest, params(a.scope.instanceId))).status,
      ).toBe(403);
      for (const malformed of [null, [], { operation: 'candidates' }])
        expect(
          (
            await business.POST(
              request(a, 'brand-media', malformed),
              params(a.scope.instanceId),
            )
          ).status,
        ).toBe(422);
      const sent = await generate(a),
        run = await execution(a, sent);
      const args = { skill: 'brand-media', path: brandMediaUsage.path };
      const resource = JSON.parse(
        (await broker(run, 'workspace.skill.read', args)).modelContent,
      );
      expect(resource.text).toBe(brandMediaUsage.content);
      expect(resource.checksum).toBe(brandMediaUsage.checksum);
      expect(resource.executionPermission).toBe(false);
      await f.db`update allrice_employee_module_bindings set revoked_at=clock_timestamp(),revision=revision+1 where instance_id=${a.scope.instanceId}`;
      await expect(broker(run, 'workspace.skill.read', args)).rejects.toThrow();
    });
    it('uploads a real JPG privately, freezes its upload pin and uses the existing native image attachment path without publication', async () => {
      const a = await generationActor();
      browser.token = a.token;
      // Two-pixel deterministic JPEG fixture, no image/model service is called.
      const input = {
        workspaceId: a.scope.workspaceId,
        requestId: randomUUID(),
        fileName: '品牌参考.jpg',
        mediaType: 'image/jpeg',
        contentBase64:
          '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAABAAAAAgAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAgACAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A/Neiiiv1A/Oz/9k=',
      };
      const http = (url: string, body: unknown) =>
        new Request(url, {
          method: 'POST',
          headers: {
            host: 'example.test',
            origin: 'https://example.test',
            'content-type': 'application/json',
            'x-allrice-organization-id': a.context.organizationId,
            'x-allrice-workspace-id': a.scope.workspaceId,
          },
          body: JSON.stringify(body),
        });
      const first = await uploadHttp.POST(
        http('https://example.test/api/v1/workbench/files', input),
      );
      expect(first.status).toBe(201);
      const file = await first.json();
      const replay = await uploadHttp.POST(
        http('https://example.test/api/v1/workbench/files', input),
      );
      expect(await replay.json()).toEqual(file);
      const owned = await uploadHttp.GET(
        new Request(
          `https://example.test/api/v1/workbench/files?view=deliverables&objectId=${file.objectId}&workspaceId=${a.scope.workspaceId}`,
          { headers: http('https://example.test', {}).headers },
        ),
      );
      expect(owned.status).toBe(200);
      const uploaded = (await owned.json()).files[0];
      expect(uploaded).toMatchObject({
        objectId: file.objectId,
        origin: 'user-upload',
        ownedByMe: true,
        reference: null,
      });
      const pin = {
        origin: 'upload',
        file: { objectId: file.objectId, checksum: uploaded.checksum },
      };
      const intent = candidateIntent(a, { references: [pin] }),
        sent = await generate(a, intent),
        again = await generate(a, intent);
      expect(again.run.id).toBe(sent.run.id);
      const [frozen] =
        await f.db`select execution_snapshot,execution_snapshot::text frozen_bytes,prompt_snapshot from allrice_employee_runs where run_id=${sent.run.id}`;
      expect(
        frozen!.execution_snapshot.moduleInvocation.intent.references,
      ).toEqual([pin]);
      expect(frozen!.prompt_snapshot.imageAttachments).toMatchObject([
        {
          fileName: input.fileName,
          object: {
            id: file.objectId,
            mediaType: 'image/jpeg',
            checksum: uploaded.checksum,
          },
        },
      ]);
      expect(
        await f.db`select * from allrice_message_attachments where message_id=${sent.userMessage.id} and object_id=${file.objectId}`,
      ).toHaveLength(1);
      expect(
        await f.db`select id from allrice_knowledge_sources where organization_id=${a.context.organizationId} and publication_kind is not null`,
      ).toHaveLength(0);
      const worker = await execution(a, sent);
      const guard = await productionContentGuard(a, sent, worker);
      await guard.check();
      const imageModulePath = new URL(
        '../../worker/src/harness/prompt-images.ts',
        import.meta.url,
      ).href;
      const { loadHarnessImages } = await import(imageModulePath);
      const imageBytes = async () =>
        loadHarnessImages(frozen!.prompt_snapshot.imageAttachments, {
          storage: runtimeFixtureStorage(f.db)!,
        });
      expect(await imageBytes()).toMatchObject([
        { mediaType: 'image/jpeg', data: input.contentBase64 },
      ]);
      // Model an existing old upload: expiry follows creation and has already
      // elapsed. Neither wall-clock waits nor invalid storage rows are needed.
      await f.db`update allrice_storage_objects set created_at=clock_timestamp()-interval '2 days',retention_until=clock_timestamp()-interval '1 day' where id=${file.objectId}`;
      // Immutable storage bytes still exist; the real production check denies their use.
      expect(await imageBytes()).toMatchObject([{ data: input.contentBase64 }]);
      await expect(guard.check()).rejects.toMatchObject({
        code: 'EMPLOYEE_CONTENT_UNAVAILABLE',
      });
      await f.db`update allrice_storage_objects set retention_until=null where id=${file.objectId}`;
      await guard.check();
      const [unchanged] =
        await f.db`select * from allrice_storage_objects where id=${file.objectId}`;
      expect(unchanged).toMatchObject({
        state: 'ready',
        immutable: true,
        deleted_at: null,
        checksum: uploaded.checksum,
      });
      // A ready immutable upload cannot be deleted or made mutable in place.
      // Exercise that actual storage contract instead of seeding an impossible
      // transition and calling it a mid-Run authorization loss.
      for (const mutation of [
        () =>
          f.db`update allrice_storage_objects set state='deleted',deleted_at=clock_timestamp() where id=${file.objectId}`,
        () =>
          f.db`update allrice_storage_objects set immutable=false where id=${file.objectId}`,
      ])
        await expect(mutation()).rejects.toMatchObject({
          code: 'P0001',
          message: 'ready immutable storage objects cannot be mutated',
        });
      expect(
        (
          await f.db`select * from allrice_storage_objects where id=${file.objectId}`
        )[0],
      ).toEqual(unchanged);
      expect(
        (
          await f.db`select execution_snapshot::text frozen_bytes from allrice_employee_runs where run_id=${sent.run.id}`
        )[0]!.frozen_bytes,
      ).toBe(frozen!.frozen_bytes);
      expect(await imageBytes()).toMatchObject([{ data: input.contentBase64 }]);
      await guard.check();
      await f.db`update allrice_employee_module_bindings set revoked_at=clock_timestamp() where instance_id=${a.scope.instanceId}`;
      await expect(guard.check()).rejects.toMatchObject({
        code: 'EMPLOYEE_CONTENT_UNAVAILABLE',
      });
      await f.db`update allrice_employee_module_bindings set revoked_at=null where instance_id=${a.scope.instanceId}`;
      await guard.check();
      await generate(
        a,
        candidateIntent(a, {
          references: [
            {
              ...pin,
              file: { ...pin.file, checksum: 'sha256:' + '0'.repeat(64) },
            },
          ],
        }),
        409,
      );
      const other = await generationActor();
      await generate(other, candidateIntent(other, { references: [pin] }), 409);
      for (const kind of ['deleted', 'mutable'] as const) {
        // Independent legal initial states, not a mutation of the frozen Run:
        // pending uploads may be abandoned; mutable objects may become ready.
        const bytes = Buffer.from(input.contentBase64, 'base64');
        const invalid = await createStorageMetadata(
          a.context,
          {
            id: randomUUID(),
            workspaceId: a.scope.workspaceId,
            category: 'uploads',
            mediaType: input.mediaType,
            sizeBytes: bytes.length,
            checksum: uploaded.checksum,
            visibility: 'private',
            retentionUntil: null,
            immutable: kind === 'deleted',
          },
          f.db,
        );
        await runtimeFixtureStorage(f.db)!.put(
          invalid.object,
          new Blob([bytes]).stream(),
        );
        if (kind === 'deleted')
          await abandonStorageMetadata(a.context, invalid.object.id, f.db);
        else await markStorageReady(a.context, invalid.object.id, f.db);
        expect(
          (
            await f.db`select state,immutable,deleted_at is not null deleted from allrice_storage_objects where id=${invalid.object.id}`
          )[0],
        ).toEqual({
          state: kind === 'deleted' ? 'deleted' : 'ready',
          immutable: kind === 'deleted',
          deleted: kind === 'deleted',
        });
        const runsBefore =
          await f.db`select id from allrice_runs where owner_id=${a.context.actor.id} order by id`;
        expect(
          (
            await generate(
              a,
              candidateIntent(a, {
                references: [
                  {
                    origin: 'upload',
                    file: {
                      objectId: invalid.object.id,
                      checksum: uploaded.checksum,
                    },
                  },
                ],
              }),
              409,
            )
          ).error,
        ).toMatchObject({ code: 'CONFLICT' });
        expect(
          await f.db`select id from allrice_runs where owner_id=${a.context.actor.id} order by id`,
        ).toEqual(runsBefore);
      }
    });
  },
);
