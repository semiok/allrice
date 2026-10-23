/** Actual PostgreSQL and temporary LocalStorage; every person, company, file
 * and publication input is synthetic. No provider, Dev account or real media
 * publishing is involved. Execute only with the existing dedicated DB gate. */
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ExecutionContextSchema,
  BrandContentWorkflowInvocationSchema,
  brandContentWorkflowTemplates,
  makeObjectKey,
  type BrandContentBoard,
  type BrandContentFileRef,
  type BrandContentMutationReceipt,
  type BrandContentVersionRef,
  type WorkbenchArtifact,
  type EmployeeContentReceipt,
  type WorkflowPackage,
} from '@allrice/contracts';
import {
  AssistantFixtureCleanupError,
  assistantFixture,
  assistantFixtureStorage,
  createAssistantFixtureDatabase,
} from '../assistant-runtime.fixture.ts';
import * as client from '../core/client.ts';
import { authenticateSession, createSession } from '../identity.ts';
import { createEmployeeInstance } from '../employees/employee-instances.ts';
import {
  createChatSession,
  getChatSessionHistory,
} from '../workspace/service.ts';
import {
  createToolBrokerExportObject,
  registerToolBrokerExport,
} from '../execution/tool-broker.ts';
import {
  getWorkbenchArtifact,
  readArtifact,
  readArtifactBytes,
} from '../artifact-review.ts';
import {
  createStorageMetadata,
  completeStorageDelete,
  getStoredFile,
  markStorageReady,
  prepareStorageDelete,
} from '../data.ts';
import {
  getEffectiveEmployeeContent,
  mutateEmployeeContent,
} from '../employees/employee-content.ts';
import {
  registerWorkflowPackage,
  setWorkflowPackageBinding,
} from '../capabilities/workflow-packages.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { runAutomationNow } from '../execution/automation.ts';
import { getWorkAutomation, updateWorkAutomation } from '../work-automation.ts';
import {
  cancelOnceTask,
  dispatchNextNativeOnceOccurrence,
  initializeNativeOncePartition,
  listOnceTasks,
  lockNativeOnceAdmissions,
} from '../native-schedule-once-product.ts';
import { createNativeOnceSqlStore } from '../native-schedule-once-sql.ts';
import {
  nativeOnceDigest,
  type NativeOnceControl,
  type NativeOnceMutation,
  type NativeOnceReference,
  type NativeOnceSnapshot,
  type NativeOnceTask,
  type NativeOnceWriter,
} from '../native-schedule-once-state.ts';
import { getBrandContentBoard, listBrandContentBrands } from './reads.ts';
import {
  mutateBrandContent,
  mutateBrandContentInTransaction,
} from './service.ts';
import type { PlanRow, Tx } from './types.ts';
import { brandContentDigest } from './rules.ts';
import {
  assertBrandContentWorkflowStart,
  brandContentStageInput,
} from './workflow-start.ts';
import {
  registerBrandContentReminder,
  lockBrandContentReminder,
  completeBrandContentReminder,
  type BrandContentReminderRegistration,
} from './scheduling.ts';
import { reconcileBrandNativeReminderAttempt } from './native-reminder.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
type Fixture = Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
type Actor = Awaited<ReturnType<typeof prepareActor>>;
type Brand = Awaited<ReturnType<typeof prepareBrand>>;
let fixture: Fixture;

const digest = (bytes: Uint8Array) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
const ref = (artifact: WorkbenchArtifact): BrandContentVersionRef => ({
  objectId: artifact.object.id,
  versionId: artifact.version.id,
  checksum: artifact.object.checksum,
});
const freshKey = (label: string) => `met194-isolated:${label}:${randomUUID()}`;

async function prepareActor(label: 'A' | 'B') {
  const base = await assistantFixture(fixture.db);
  const org = base.task.scope.organizationId,
    workspace = base.task.scope.workspaceId!;
  const user = base.context.actor.id;
  // Only rows created above, inside this fixture's generated private schema.
  await fixture.db`update allrice_organizations set name=${`MET194 isolated fixture company ${label}`} where id=${org}`;
  await fixture.db`update allrice_workspaces set name=${`MET194 isolated workspace ${label}`} where id=${workspace}`;
  await fixture.db`update allrice_users set display_name=${`MET194 synthetic member ${label}`} where id=${user}`;
  await fixture.db`update allrice_memberships set role='member' where organization_id=${org} and workspace_id=${workspace} and user_id=${user}`;
  const login = await createSession(user);
  const context = await authenticateSession(login.token, {
    organizationId: org,
    workspaceId: workspace,
  });
  if (!context) throw Error('isolated_brand_content_login_failed');
  const [assignment] = await fixture.db<
    { id: string }[]
  >`select id from allrice_employee_assignments
    where organization_id=${org} and workspace_id=${workspace} and user_id=${user} and active`;
  if (!assignment) throw Error('isolated_brand_content_assignment_missing');
  const instance = await createEmployeeInstance(context, {
    workspaceId: workspace,
    assignmentId: assignment.id,
    requestId: randomUUID(),
    profile: { name: `MET194 isolated content employee ${label}` },
  });
  const session = await createChatSession(context, {
    workspaceId: workspace,
    employeeInstanceId: instance.id,
    title: `MET194 isolated content session ${label}`,
  });
  return {
    base,
    context,
    org,
    workspace,
    user,
    assignmentId: assignment.id,
    instance,
    session,
    scope: { workspaceId: workspace, instanceId: instance.id },
  };
}
function execution(actor: Actor) {
  const now = new Date();
  return ExecutionContextSchema.parse({
    executionId: randomUUID(),
    runId: actor.base.task.rootRunId,
    jobId: actor.base.worker.jobId,
    worker: { type: 'worker', id: actor.base.worker.workerId },
    delegatedBy: { type: 'user', id: actor.user },
    organizationId: actor.org,
    workspaceId: actor.workspace,
    policySnapshot: {
      id: randomUUID(),
      organizationId: actor.org,
      subjectId: actor.user,
      version: 1,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 600_000).toISOString(),
      memberships: actor.context.memberships,
      grants: [
        {
          resourceType: 'storage_object',
          action: 'resource:read',
          workspaceId: actor.workspace,
        },
      ],
    },
    startedAt: now.toISOString(),
  });
}
async function prepareBrand(
  actor: Actor,
  label: string,
  sourceFiles: BrandContentFileRef[] = [],
) {
  const saved = await mutateBrandContent(
    actor.context,
    {
      ...actor.scope,
      operation: 'context.save',
      requestId: freshKey('context'),
      expectedRevision: 0,
      name: `MET194 TEST ONLY ${label}`,
      content: {
        audience: '合成纸品用户',
        tone: '温和具体',
        requirements: '仅用提供的演示事实，不编造销量或优惠。',
        visualBrief: '浅绿与米白概念图，合成测试素材。',
        sourceFiles,
        facts: [
          { id: 'paper_size', text: 'A5，148 × 210 毫米。' },
          { id: 'pages', text: '48 张，96 页。' },
        ],
        strategies: [
          {
            key: 'daily',
            name: '合成日常策略',
            brief: '从桌面记录小练习切入。',
          },
        ],
        campaign: {
          key: 'desk',
          name: '合成桌面栏目',
          brief: '每天先写三件小事。',
        },
      },
    },
    { db: fixture.db },
  );
  return {
    actor,
    brandId: saved.result.brandId,
    contextRevisionId: saved.result.contextRevisionId!,
  };
}
function candidate(title = '桌面上的三件小事') {
  return {
    title,
    angle: '纸笔安排一天的小事',
    outline: '用一页随记列三件事，引用产品规格。',
    audience: '合成纸品用户',
    rationale: '来源于本品牌固定上下文的 A5 和页数事实。',
    factIds: ['paper_size', 'pages'],
  };
}
async function propose(brand: Brand, title?: string) {
  return mutateBrandContent(
    brand.actor.context,
    {
      ...brand.actor.scope,
      brandId: brand.brandId,
      operation: 'topics.propose',
      requestId: freshKey('topics'),
      contextRevisionId: brand.contextRevisionId,
      platform: '小红书',
      candidates: [candidate(title)],
    },
    { db: fixture.db },
  );
}
async function accept(brand: Brand, batch: BrandContentMutationReceipt) {
  await mutateBrandContent(
    brand.actor.context,
    {
      ...brand.actor.scope,
      brandId: brand.brandId,
      operation: 'topics.decide',
      requestId: freshKey('accept'),
      batchId: batch.result.entityId,
      expectedRevision: batch.result.revision,
      choices: [
        {
          topicId: batch.result.topicIds![0]!,
          decision: 'accepted',
          reason: '真人测试成员明确采纳这条 ID。',
        },
      ],
    },
    { db: fixture.db },
  );
  return batch.result.topicIds![0]!;
}
async function board(brand: Brand): Promise<BrandContentBoard> {
  return getBrandContentBoard(
    brand.actor.context,
    { ...brand.actor.scope, brandId: brand.brandId },
    { db: fixture.db },
  );
}
async function seedDocument(
  actor: Actor,
  text: string,
  options: {
    parent?: WorkbenchArtifact;
    sessionId?: string;
    registered?: (tx: Tx, artifact: WorkbenchArtifact) => Promise<void>;
  } = {},
) {
  const bytes = Buffer.from(text, 'utf8'),
    context = execution(actor);
  const object = {
    ...createToolBrokerExportObject({
      context,
      mediaType: 'text/plain',
      sizeBytes: bytes.length,
      checksum: digest(bytes),
    }),
    immutable: true,
  };
  const storage = assistantFixtureStorage(fixture.db);
  await storage.put(object, new Blob([Uint8Array.from(bytes)]).stream());
  const version = await fixture.db
    .begin(async (tx) => {
      const version = await registerToolBrokerExport(
        {
          context,
          sessionId: options.sessionId ?? actor.session.id,
          object,
          fileName: 'met194-isolated-content.txt',
          format: 'text',
          ...(options.parent
            ? {
                parentObjectId: options.parent.object.id,
                changeSummary: 'Synthetic reviewer-directed revision.',
              }
            : {}),
        },
        tx,
      );
      await tx`insert into allrice_workbench_artifacts
      (version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,request_id,request_digest)
      values(${version.id},${actor.org},${actor.workspace},${actor.user},${context.runId},'document',
        ${tx.json({ kind: 'tool_result', runId: context.runId, operationId: null, stepId: null })},${freshKey('artifact')},${digest(bytes)})`;
      if (options.registered)
        await options.registered(
          tx,
          await readArtifact(
            tx,
            actor.context,
            options.sessionId ?? actor.session.id,
            version.id,
          ),
        );
      return version;
    })
    .catch(async (error: unknown) => {
      // This helper owns only its newly generated, rolled-back fixture object.
      await storage.delete({ ...object, immutable: false });
      throw error;
    });
  const artifact = await getWorkbenchArtifact(
    actor.context,
    options.sessionId ?? actor.session.id,
    version.id,
    fixture.db,
  );
  expect(
    Buffer.from(await readArtifactBytes(storage, artifact.object)).toString(
      'utf8',
    ),
  ).toBe(text);
  return artifact;
}
// Deterministic valid one-pixel RGB PNGs; not model-generated image evidence.
function pixelPng(rgb: [number, number, number]) {
  const crc = (bytes: Uint8Array) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++)
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Buffer) => {
    const kind = Buffer.from(name),
      header = Buffer.alloc(4),
      tail = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    tail.writeUInt32BE(crc(Buffer.concat([kind, data])));
    return Buffer.concat([header, kind, data, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, ...rgb]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
async function seedUpload(
  actor: Actor,
  rgb: [number, number, number],
): Promise<BrandContentFileRef> {
  const bytes = pixelPng(rgb),
    source = createToolBrokerExportObject({
      context: execution(actor),
      mediaType: 'image/png',
      sizeBytes: bytes.length,
      checksum: digest(bytes),
    });
  const object = {
    ...source,
    key: makeObjectKey({
      organizationId: actor.org,
      workspaceId: actor.workspace,
      ownerId: actor.user,
      category: 'uploads',
      objectId: source.id,
    }),
    immutable: true,
  };
  const storage = assistantFixtureStorage(fixture.db);
  await storage.put(object, new Blob([Uint8Array.from(bytes)]).stream());
  // Upload metadata is fixture input; business writes below always use APIs.
  await fixture.db`insert into allrice_storage_objects
    (id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,visibility,state,immutable)
    values(${object.id},${actor.org},${actor.workspace},${actor.user},${object.key},'uploads','image/png',${bytes.length},${object.checksum},'private','ready',true)`;
  const stored = await getStoredFile(actor.context, object.id, fixture.db);
  expect(Buffer.from(await readArtifactBytes(storage, stored.object))).toEqual(
    bytes,
  );
  return { objectId: object.id, checksum: object.checksum };
}
async function prepareDraft(
  actor: Actor,
  label: string,
  sourceFiles: BrandContentFileRef[] = [],
) {
  const brand = await prepareBrand(actor, label, sourceFiles),
    batch = await propose(brand),
    topicId = await accept(brand, batch);
  const document = await seedDocument(
    actor,
    '合成初稿：A5 随记本，48 张、96 页。请先写下三件小事。',
  );
  const submitted = await mutateBrandContent(
    actor.context,
    {
      ...actor.scope,
      brandId: brand.brandId,
      operation: 'article.submit',
      requestId: freshKey('draft'),
      expectedRevision: 0,
      topicId,
      sessionId: actor.session.id,
      content: ref(document),
      changeSummary: '合成初稿入库。',
    },
    { db: fixture.db },
  );
  return { brand, topicId, document, submitted };
}

async function prepareReminderMethod(actor: Actor) {
  const setId = randomUUID(),
    contentId = randomUUID();
  const base = {
    workspaceId: actor.workspace,
    setId,
    ownership: {
      scope: 'personal' as const,
      organizationId: actor.org,
      ownerId: actor.user,
    },
    target: { kind: 'instance' as const, instanceId: actor.instance.id },
    changeSummary: 'Synthetic reminder handoff method only.',
  };
  const draft = await mutateEmployeeContent(actor.context, {
    ...base,
    requestId: randomUUID(),
    expectedRevision: 0,
    operation: 'save_draft',
    textEdits: [
      {
        contentId,
        revisionId: randomUUID(),
        expectedRevision: 0,
        kind: 'procedure',
        title: 'Synthetic approved handoff',
        body: '仅交接已审核图文；站内发布提醒不代表对外发布。',
      },
    ],
    manifest: {
      schemaVersion: 1,
      common: [{ sourceKind: 'draft_text', contentId }],
      scenes: [],
      declaredConflicts: [],
    },
  });
  const next = (
    receipt: EmployeeContentReceipt,
    operation: 'validate' | 'activate',
  ) => ({
    ...base,
    requestId: randomUUID(),
    expectedRevision: receipt.revision,
    operation,
    candidateRevisionId: receipt.candidate.id,
    candidateDigest: receipt.candidate.digest,
  });
  const checked = await mutateEmployeeContent(
    actor.context,
    next(draft, 'validate'),
  );
  expect(checked.validation?.valid).toBe(true);
  await mutateEmployeeContent(actor.context, next(checked, 'activate'));
  const current = await getEffectiveEmployeeContent(
    actor.context,
    actor.instance.id,
  );
  const source = current.sources.find(
    (row) => row.reference.contentId === contentId,
  );
  if (!source?.available || typeof source.body !== 'string')
    throw Error('synthetic_reminder_method_unavailable');
  return {
    reference: { ...source.reference, sourceKind: 'procedure' as const },
    body: source.body,
  };
}
type ReminderMethod = Awaited<ReturnType<typeof prepareReminderMethod>>;
async function prepareReminderPackage(
  actor: Actor,
  method: ReminderMethod,
  previous?: WorkflowPackage,
) {
  const template = brandContentWorkflowTemplates.find(
    (row) => row.stage === 'handoff',
  )!;
  const files = [
    {
      path: 'workflow.json',
      bytes: Buffer.from(JSON.stringify(template.definition)),
    },
    { path: 'method.md', bytes: Buffer.from(method.body) },
  ].map((file) => ({
    path: file.path,
    checksum: digest(file.bytes),
    contentBase64: file.bytes.toString('base64'),
  }));
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, files }));
  const source = await createStorageMetadata(
    actor.context,
    {
      id: randomUUID(),
      workspaceId: actor.workspace,
      category: 'exports',
      mediaType: 'application/json',
      sizeBytes: bytes.length,
      checksum: digest(bytes),
      visibility: 'private',
      retentionUntil: null,
      immutable: true,
    },
    fixture.db,
  );
  await assistantFixtureStorage(fixture.db).put(
    source.object,
    new Blob([Uint8Array.from(bytes)]).stream(),
  );
  await markStorageReady(actor.context, source.object.id, fixture.db);
  const value = await registerWorkflowPackage(
    actor.context,
    {
      workspaceId: actor.workspace,
      instanceId: actor.instance.id,
      sceneId: null,
      requestId: randomUUID(),
      ...(previous ? { workflowId: previous.workflow.workflowId } : {}),
      expectedRevision: previous?.workflow.revision ?? 0,
      slug: 'met194-isolated-reminder-handoff',
      name: 'MET194 synthetic reminder handoff',
      description: 'Only isolated reminder acceptance.',
      definition: template.definition,
      manifest: {
        schemaVersion: 1,
        templateKey: template.templateKey,
        method: method.reference,
        definitionChecksum: runtimePolicyDigest(template.definition),
        source: {
          objectId: source.object.id,
          checksum: source.object.checksum,
        },
        files: files.map(({ path, checksum }) => ({ path, checksum })),
        assets: [],
      },
    },
    { storage: assistantFixtureStorage(fixture.db) },
  );
  const [binding] = await fixture.db<
    { binding_revision: number }[]
  >`select binding_revision from allrice_employee_workflow_bindings
    where instance_id=${actor.instance.id} and workflow_id=${value.workflow.workflowId} and scene_id is null`;
  await setWorkflowPackageBinding(actor.context, {
    workspaceId: actor.workspace,
    instanceId: actor.instance.id,
    sceneId: null,
    workflowRevisionId: value.workflow.id,
    requestId: randomUUID(),
    expectedRevision: binding?.binding_revision ?? 0,
    enabled: true,
  });
  return value;
}
const reminderPin = (value: WorkflowPackage) => ({
  workflowRevisionId: value.workflow.id,
  packageDigest: value.checksum,
});
async function prepareReminderPlan(
  actor: Actor,
  label: string,
  delayMs = 2_000,
  sourceFiles: BrandContentFileRef[] = [],
) {
  const draft = await prepareDraft(actor, label, sourceFiles);
  const reviewed = await mutateBrandContent(
    actor.context,
    {
      ...actor.scope,
      brandId: draft.brand.brandId,
      operation: 'article.review',
      requestId: freshKey('reminder-review'),
      articleId: draft.submitted.result.entityId,
      expectedRevision: draft.submitted.result.revision,
      bundleDigest: draft.submitted.result.bundleDigest!,
      decision: 'approved',
      reason: 'Synthetic human approved this exact bundle for handoff.',
    },
    { db: fixture.db },
  );
  const plannedAt = new Date(Date.now() + delayMs);
  const plan = await mutateBrandContent(
    actor.context,
    {
      ...actor.scope,
      brandId: draft.brand.brandId,
      operation: 'plan.save',
      requestId: freshKey('reminder-plan'),
      expectedRevision: 0,
      articleId: draft.submitted.result.entityId,
      bundleDigest: reviewed.result.bundleDigest!,
      reviewId: reviewed.result.reviewId!,
      platform: '小红书',
      plannedAt: plannedAt.toISOString(),
      timezone: 'Asia/Shanghai',
      publisher: 'MET194 synthetic human publisher',
      notes: 'Fixture only; no external publication.',
    },
    { db: fixture.db },
  );
  const input = {
    ...actor.scope,
    brandId: draft.brand.brandId,
    planId: plan.result.entityId,
    expectedRevision: plan.result.revision,
    requestId: freshKey('register-reminder'),
  };
  return { ...draft, reviewed, plan, plannedAt, input };
}

/** Explicit pre-native history for retention and retired-entry tests only.
 * This is not a production registration or an alternative flag-OFF API. The
 * real approved plan/files/package and all FK/immutable triggers remain intact.
 * No control, journal, occurrence, message or terminal receipt is fabricated. */
async function seedHistoricalLegacyReminder(
  actor: Actor,
  prepared: Awaited<ReturnType<typeof prepareReminderPlan>>,
  workflow: WorkflowPackage,
): Promise<BrandContentReminderRegistration> {
  return fixture.db.begin(async (tx) => {
    const [owned] = await tx<{ owned: boolean }[]>`select
      current_schema() ~ '^p25_[a-f0-9]{32}$'
      and a.relnamespace=to_regnamespace(current_schema())
      and r.relnamespace=to_regnamespace(current_schema()) as owned
      from pg_class a cross join pg_class r
      where a.oid='allrice_automations'::regclass
        and r.oid='allrice_brand_content_reminders'::regclass`;
    expect(owned?.owned).toBe(true);
    const [plan] = await tx<PlanRow[]>`select * from allrice_brand_content_plans
      where id=${prepared.input.planId} and organization_id=${actor.org}
        and workspace_id=${actor.workspace} and owner_id=${actor.user}
        and instance_id=${actor.instance.id} and brand_id=${prepared.brand.brandId}
        and revision=${prepared.input.expectedRevision}
        and state='planned' and reminder_status='not_registered' for update`;
    if (!plan) throw Error('historical_brand_plan_missing');
    expect(plan.bundle_digest).toBe(prepared.reviewed.result.bundleDigest);
    expect(plan.review_id).toBe(prepared.reviewed.result.reviewId);
    expect(plan.planned_at).toEqual(prepared.plannedAt);
    const id = randomUUID(),
      automationId = randomUUID(),
      occurrenceId = randomUUID(),
      messageId = randomUUID();
    const schedule = {
      frequency: 'once',
      runAt: plan.planned_at.toISOString(),
      timezone: plan.timezone,
    };
    await tx`insert into allrice_automations
      (id,organization_id,workspace_id,owner_id,name,description,prompt,trigger_type,schedule,status,
        conversation_mode,employee_assignment_id,session_id,next_run_at,brand_content_binding,clock_owner)
      values(${automationId},${actor.org},${actor.workspace},${actor.user},'Explicit historical brand reminder fixture',
        'Isolated pre-native history only','Deterministic historical private reminder; no model',
        'schedule',${tx.json(schedule)},'enabled','reuse',${actor.assignmentId},${actor.session.id},${plan.planned_at},${id},'legacy')`;
    const requestDigest = brandContentDigest({
      input: prepared.input,
      workflow: reminderPin(workflow),
      authority: 'user',
    });
    await tx`insert into allrice_brand_content_reminders
      (id,organization_id,workspace_id,owner_id,instance_id,assignment_id,brand_id,plan_id,plan_revision,
        article_id,bundle_id,review_id,bundle_digest,session_id,workflow_revision_id,package_digest,
        automation_id,scheduled_for,request_id,request_digest,authority,reserved_occurrence_id,reserved_message_id,created_at)
      values(${id},${actor.org},${actor.workspace},${actor.user},${actor.instance.id},${actor.assignmentId},
        ${prepared.brand.brandId},${plan.id},${plan.revision + 1},${plan.article_id},${plan.bundle_id},
        ${plan.review_id},${plan.bundle_digest},${actor.session.id},${workflow.workflow.id},${workflow.checksum},
        ${automationId},${plan.planned_at},${prepared.input.requestId},${requestDigest},'user',${occurrenceId},${messageId},
        clock_timestamp())`;
    const registered = await mutateBrandContentInTransaction(
      actor.context,
      {
        ...prepared.input,
        operation: 'plan.reminder',
        requestId: `brand-reminder-register:${id}`,
        status: 'registered',
        automationId,
      },
      tx,
      { authority: 'scheduler' },
    );
    expect(registered.result.revision).toBe(plan.revision + 1);
    return {
      automationId,
      planId: plan.id,
      revision: registered.result.revision,
      replayed: false,
      status: 'registered',
      messageId: null,
    };
  });
}

async function waitUntilReminder(at: Date) {
  // The test observes the real database/server clock. It does not rewrite any
  // frozen schedule/plan or mock Date to make an occurrence due.
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, at.getTime() - Date.now()) + 80),
  );
}

async function prepareRevocableBrandSource(
  actor: Actor,
): Promise<BrandContentFileRef> {
  const bytes = Buffer.from(
    'MET194 synthetic revocable source: A5, 48 sheets, 96 pages.',
  );
  const value = await createStorageMetadata(
    actor.context,
    {
      id: randomUUID(),
      workspaceId: actor.workspace,
      category: 'uploads',
      mediaType: 'text/plain',
      sizeBytes: bytes.length,
      checksum: digest(bytes),
      visibility: 'private',
      retentionUntil: null,
      immutable: false,
    },
    fixture.db,
  );
  await assistantFixtureStorage(fixture.db).put(
    value.object,
    new Blob([Uint8Array.from(bytes)]).stream(),
  );
  await markStorageReady(actor.context, value.object.id, fixture.db);
  return { objectId: value.object.id, checksum: value.object.checksum };
}

suite(
  'MET194 native brand business SQL and file lineage — isolated PostgreSQL, no model',
  () => {
    let a: Actor, b: Actor;
    let reminderMethod: ReminderMethod | undefined;
    let activeReminderPackage: WorkflowPackage | undefined;
    const ensureReminderPackage = async () => {
      reminderMethod ??= await prepareReminderMethod(a);
      activeReminderPackage ??= await prepareReminderPackage(a, reminderMethod);
      return activeReminderPackage;
    };
    let alternate: {
      instance: Awaited<ReturnType<typeof createEmployeeInstance>>;
      session: Awaited<ReturnType<typeof createChatSession>>;
    };
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      // Ordinary business fixtures keep once disabled. Native delivery cases below
      // explicitly enable the existing isolated public SQL control fixture.
      vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '0');
      fixture = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
      // Only synthetic business INSERT metadata, never a measured native build.
      vi.stubEnv(
        'ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID',
        'sha256:' + 'b'.repeat(64),
      );
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', 'sha256:' + 'b'.repeat(64));
      a = await prepareActor('A');
      b = await prepareActor('B');
      const instance = await createEmployeeInstance(a.context, {
        workspaceId: a.workspace,
        assignmentId: a.assignmentId,
        requestId: randomUUID(),
        profile: { name: 'MET194 same-owner isolated second instance' },
      });
      const session = await createChatSession(a.context, {
        workspaceId: a.workspace,
        employeeInstanceId: instance.id,
        title: 'MET194 second-instance fixture only',
      });
      alternate = { instance, session };
    }, 120_000);
    afterAll(async () => {
      try {
        if (fixture) {
          const cleanup = await fixture.close();
          console.info('BRAND_SQL_FIXTURE_CLEANUP', JSON.stringify(cleanup));
          expect(cleanup).toMatchObject({
            schemaRemoved: true,
            storageRemoved: true,
            databaseClosed: true,
            adminClosed: true,
          });
        }
      } catch (error) {
        if (error instanceof AssistantFixtureCleanupError)
          console.error(
            'BRAND_SQL_FIXTURE_CLEANUP_FAILED',
            JSON.stringify(error.cleanup),
          );
        throw error;
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }, 30_000);

    it('validates an uncommitted authenticated start and user message on the caller transaction, rejects another owner, and leaves no rows after rollback', async () => {
      const brand = await prepareBrand(a, 'caller-transaction-start');
      const request = {
        workspaceId: a.workspace,
        brandId: brand.brandId,
        requestId: randomUUID(),
        sessionId: a.session.id,
        stage: 'topics' as const,
        platform: '小红书',
        count: 3,
      };
      const invocation = BrandContentWorkflowInvocationSchema.parse({
        schemaVersion: 1,
        startId: randomUUID(),
        instanceId: a.instance.id,
        sceneId: null,
        // This synthetic fixture exercises authenticated-start SQL visibility.
        // Package execution is separately checked by the real Start admission.
        workflowRevisionId: randomUUID(),
        packageDigest: runtimePolicyDigest({ fixture: request.requestId }),
        templateKey: 'brand-content-operations.topics',
        input: brandContentStageInput(await board(brand), request),
      });
      const messageId = randomUUID();
      const rollback = new Error('isolated caller transaction rollback');
      await expect(
        fixture.db.begin(async (tx) => {
          await tx`insert into allrice_brand_content_workflow_starts
            (id,organization_id,workspace_id,owner_id,instance_id,brand_id,
              request_id,request_digest,request,invocation,session_id)
            values (${invocation.startId},${a.org},${a.workspace},${a.user},
              ${a.instance.id},${brand.brandId},${request.requestId},
              ${runtimePolicyDigest(request)},${tx.json(request)},
              ${tx.json(invocation)},${a.session.id})`;
          await tx`insert into allrice_messages
            (id,organization_id,workspace_id,session_id,owner_id,role,content,
              visibility,client_message_id,status,completed_at)
            values (${messageId},${a.org},${a.workspace},${a.session.id},
              ${a.user},'user',${tx.json({ text: 'Synthetic caller transaction topics start.' })},
              'private',${request.requestId},'completed',now())`;

          await expect(
            assertBrandContentWorkflowStart(
              a.context,
              a.session.id,
              messageId,
              invocation,
              tx,
            ),
          ).resolves.toBeUndefined();
          // The default pool is a different real connection. Before COMMIT it
          // must not see this start/message, reproducing the former failure.
          await expect(
            assertBrandContentWorkflowStart(
              a.context,
              a.session.id,
              messageId,
              invocation,
            ),
          ).rejects.toMatchObject({ code: 'authorization_denied' });
          await expect(
            assertBrandContentWorkflowStart(
              { ...a.context, actor: b.context.actor },
              a.session.id,
              messageId,
              invocation,
              tx,
            ),
          ).rejects.toMatchObject({ code: 'authorization_denied' });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      const rows = await fixture.db<{ starts: number; messages: number }[]>`
        select
          (select count(*)::int from allrice_brand_content_workflow_starts
            where id=${invocation.startId}) as starts,
          (select count(*)::int from allrice_messages
            where id=${messageId}) as messages`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!).toMatchObject({ starts: 0, messages: 0 });
    });

    it('persists review-directed native file revisions, a one-slot image revision, approved handoff and a user-provided receipt', async () => {
      const f = await prepareDraft(a, 'full-chain');
      const first = await board(f.brand);
      expect(first.articles[0]).toMatchObject({
        id: f.submitted.result.entityId,
        state: 'awaiting_review',
        topicId: f.topicId,
        topicRevision: first.topics.find((t) => t.id === f.topicId)!.revision,
      });
      const rejected = await mutateBrandContent(
        a.context,
        {
          ...a.scope,
          brandId: f.brand.brandId,
          operation: 'article.review',
          requestId: freshKey('reject'),
          articleId: f.submitted.result.entityId,
          expectedRevision: f.submitted.result.revision,
          bundleDigest: f.submitted.result.bundleDigest!,
          decision: 'rejected',
          reason: '真人退回：开头改为先写下一件小事，保留 A5 与页数。',
        },
        { db: fixture.db },
      );
      const revisedDocument = await seedDocument(
        a,
        '先写下今天最想完成的一件小事。合成产品规格仍为 A5，48 张、96 页。你会写哪件事？',
        { parent: f.document },
      );
      const revised = await mutateBrandContent(
        a.context,
        {
          ...a.scope,
          brandId: f.brand.brandId,
          operation: 'article.submit',
          requestId: freshKey('revision'),
          articleId: f.submitted.result.entityId,
          expectedRevision: rejected.result.revision,
          topicId: f.topicId,
          sessionId: a.session.id,
          content: ref(revisedDocument),
          parentVersionId: f.document.version.id,
          reviewId: rejected.result.reviewId,
          changeSummary: '只改开头与结尾，保留事实；关联真人退回。',
        },
        { db: fixture.db },
      );
      const revisedBoard = await board(f.brand);
      expect(revisedBoard.bundles).toHaveLength(2);
      const secondBundle = revisedBoard.bundles.find(
        (x) => x.digest === revised.result.bundleDigest,
      )!;
      expect(secondBundle).toMatchObject({
        content: ref(revisedDocument),
        sourceReviewId: rejected.result.reviewId,
        parentBundleId: first.bundles[0]!.id,
      });
      expect(revisedBoard.reviews[0]).toMatchObject({
        id: rejected.result.reviewId,
        decidedBy: a.user,
        decision: 'rejected',
      });
      const [bodyBefore] = await fixture.db<
        { n: number }[]
      >`select count(*)::int n from allrice_deliverable_versions where series_id=${f.document.version.seriesId}`;
      expect(bodyBefore?.n).toBe(2);
      const cover = await seedUpload(a, [146, 178, 141]),
        detail = await seedUpload(a, [238, 231, 211]);
      const illustrated = await mutateBrandContent(
        a.context,
        {
          ...a.scope,
          brandId: f.brand.brandId,
          operation: 'article.images',
          requestId: freshKey('images'),
          articleId: f.submitted.result.entityId,
          expectedRevision: revised.result.revision,
          bundleDigest: revised.result.bundleDigest!,
          images: [
            { slotKey: 'cover', file: cover, sourceKind: 'uploaded' },
            { slotKey: 'detail', file: detail, sourceKind: 'uploaded' },
          ],
          changeSummary: '采用两张确定性合成上传图。',
        },
        { db: fixture.db },
      );
      const priorApproval = await mutateBrandContent(
        a.context,
        {
          ...a.scope,
          brandId: f.brand.brandId,
          operation: 'article.review',
          requestId: freshKey('approve-images'),
          articleId: f.submitted.result.entityId,
          expectedRevision: illustrated.result.revision,
          bundleDigest: illustrated.result.bundleDigest!,
          decision: 'approved',
          reason: '真人检查此版文案和两图。',
        },
        { db: fixture.db },
      );
      const newCover = await seedUpload(a, [110, 145, 176]);
      const swapped = await mutateBrandContent(
        a.context,
        {
          ...a.scope,
          brandId: f.brand.brandId,
          operation: 'article.images',
          requestId: freshKey('single-image'),
          articleId: f.submitted.result.entityId,
          expectedRevision: priorApproval.result.revision,
          bundleDigest: illustrated.result.bundleDigest!,
          images: [
            { slotKey: 'cover', file: newCover, sourceKind: 'uploaded' },
          ],
          changeSummary: '仅替换封面，不生成正文。',
        },
        { db: fixture.db },
      );
      const afterSwap = await board(f.brand),
        current = afterSwap.bundles.find(
          (x) => x.digest === swapped.result.bundleDigest,
        )!;
      expect(current.content).toEqual(ref(revisedDocument));
      expect(current.images).toHaveLength(2);
      expect(current.images.find((x) => x.slotKey === 'cover')!.file).toEqual(
        newCover,
      );
      expect(current.images.find((x) => x.slotKey === 'detail')!.file).toEqual(
        detail,
      );
      expect(afterSwap.articles[0]!.state).toBe('awaiting_review');
      const [bodyAfter] = await fixture.db<
        { n: number }[]
      >`select count(*)::int n from allrice_deliverable_versions where series_id=${f.document.version.seriesId}`;
      expect(bodyAfter?.n).toBe(bodyBefore!.n);
      await expect(
        mutateBrandContent(
          a.context,
          {
            ...a.scope,
            brandId: f.brand.brandId,
            operation: 'article.review',
            requestId: freshKey('stale-image-review'),
            articleId: f.submitted.result.entityId,
            expectedRevision: swapped.result.revision,
            bundleDigest: illustrated.result.bundleDigest!,
            decision: 'approved',
            reason: '陈旧图文包审批必须拒绝。',
          },
          { db: fixture.db },
        ),
      ).rejects.toMatchObject({ code: 'version_conflict' });
      const approval = await mutateBrandContent(
        a.context,
        {
          ...a.scope,
          brandId: f.brand.brandId,
          operation: 'article.review',
          requestId: freshKey('approve-current'),
          articleId: f.submitted.result.entityId,
          expectedRevision: swapped.result.revision,
          bundleDigest: swapped.result.bundleDigest!,
          decision: 'approved',
          reason: '真人批准当前准确图文包。',
        },
        { db: fixture.db },
      );
      const planInput = {
        ...a.scope,
        brandId: f.brand.brandId,
        operation: 'plan.save' as const,
        requestId: freshKey('plan'),
        articleId: f.submitted.result.entityId,
        expectedRevision: 0,
        bundleDigest: swapped.result.bundleDigest!,
        reviewId: approval.result.reviewId!,
        platform: '小红书',
        plannedAt: new Date(Date.now() + 3_600_000).toISOString(),
        timezone: 'Asia/Shanghai',
        publisher: 'MET194 synthetic human A',
      };
      await expect(
        mutateBrandContent(
          a.context,
          {
            ...planInput,
            requestId: freshKey('stale-review-plan'),
            reviewId: priorApproval.result.reviewId,
          },
          { db: fixture.db },
        ),
      ).rejects.toMatchObject({ code: 'invalid_state' });
      const plan = await mutateBrandContent(a.context, planInput, {
        db: fixture.db,
      });
      expect(plan.result).toMatchObject({
        state: 'planned',
        bundleDigest: current.digest,
        reminderStatus: 'not_registered',
      });
      expect(
        await mutateBrandContent(a.context, planInput, { db: fixture.db }),
      ).toEqual({ ...plan, replayed: true });
      const publication = {
        ...a.scope,
        brandId: f.brand.brandId,
        operation: 'receipt.record' as const,
        requestId: freshKey('receipt'),
        planId: plan.result.entityId,
        expectedRevision: plan.result.revision,
        bundleDigest: current.digest,
        platform: '小红书',
        publisher: 'MET194 synthetic human A',
        // Synthetic data input only. This URL is never fetched or advertised as
        // a real published demonstration. The stored claim stays "provided".
        publishedUrl: 'https://met194-isolated-fixture.test/publication-input',
        actualPublishedAt: new Date(Date.now() - 60_000).toISOString(),
        sourceType: 'manual_confirmation' as const,
        evidence:
          'ISOLATED POSTGRESQL FIXTURE ONLY: manual input, no external publication occurred.',
      };
      const fence = vi.fn(async () => undefined);
      await expect(
        mutateBrandContent(
          a.context,
          {
            ...publication,
            workflow: {
              workflowRevisionId: randomUUID(),
              packageDigest: 'sha256:' + 'c'.repeat(64),
            },
          },
          { db: fixture.db, authority: 'workflow', beforeCommit: fence },
        ),
      ).rejects.toMatchObject({ code: 'authority_denied' });
      expect(fence).not.toHaveBeenCalled();
      const receipt = await mutateBrandContent(a.context, publication, {
        db: fixture.db,
      });
      expect(
        await mutateBrandContent(a.context, publication, { db: fixture.db }),
      ).toEqual({ ...receipt, replayed: true });
      const final = await board(f.brand);
      expect(final.plans).toHaveLength(1);
      expect(final.receipts).toHaveLength(1);
      expect(final.plans[0]).toMatchObject({
        bundleId: current.id,
        reviewId: approval.result.reviewId,
        reminderStatus: 'not_registered',
        state: 'planned',
        automationId: null,
      });
      expect(final.receipts[0]).toMatchObject({
        recordedBy: a.user,
        verificationState: 'provided',
        bundleDigest: current.digest,
      });
      const historical = await getWorkbenchArtifact(
        a.context,
        a.session.id,
        f.document.version.id,
        fixture.db,
      );
      expect(
        Buffer.from(
          await readArtifactBytes(
            assistantFixtureStorage(fixture.db),
            historical.object,
          ),
        ).toString('utf8'),
      ).toContain('合成初稿');
      expect(
        final.reviews.some(
          (r) => r.id === rejected.result.reviewId && r.decision === 'rejected',
        ),
      ).toBe(true);
    }, 60_000);

    it('serializes identical requests, rejects key reuse with changed input, and retains exact context snapshots', async () => {
      const input = {
        ...a.scope,
        operation: 'context.save',
        requestId: freshKey('concurrent-context'),
        expectedRevision: 0,
        name: `MET194 SQL concurrency ${randomUUID()}`,
        content: {
          audience: 'synthetic audience',
          tone: 'clear',
          requirements: 'fixture only',
          facts: [{ id: 'size', text: 'A5' }],
        },
      };
      const [left, right] = await Promise.all([
        mutateBrandContent(a.context, input, { db: fixture.db }),
        mutateBrandContent(a.context, input, { db: fixture.db }),
      ]);
      expect(left.result.entityId).toBe(right.result.entityId);
      expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
      const [createdCount] = await fixture.db<
        { n: number }[]
      >`select count(*)::int n from allrice_brand_content_brands where organization_id=${a.org} and owner_id=${a.user} and instance_id=${a.instance.id} and name=${input.name}`;
      expect(createdCount?.n).toBe(1);
      await expect(
        mutateBrandContent(
          a.context,
          { ...input, name: 'changed with same key' },
          { db: fixture.db },
        ),
      ).rejects.toMatchObject({ code: 'request_conflict' });
      await mutateBrandContent(
        a.context,
        {
          ...input,
          brandId: left.result.brandId,
          requestId: freshKey('new-context-version'),
          expectedRevision: 1,
          content: { ...input.content, facts: [{ id: 'size', text: 'A6' }] },
        },
        { db: fixture.db },
      );
      const saved = await getBrandContentBoard(
        a.context,
        { ...a.scope, brandId: left.result.brandId },
        { db: fixture.db },
      );
      expect(saved.contexts).toHaveLength(2);
      expect(
        saved.contexts.find((x) => x.id === left.result.contextRevisionId)!
          .content.facts[0]!.text,
      ).toBe('A5');
      expect(
        saved.contexts.find((x) => x.id === saved.brand.contextRevisionId)!
          .content.facts[0]!.text,
      ).toBe('A6');
    });

    it('deduplicates topics across batches and invalidates every affected human selection revision', async () => {
      const f = await prepareBrand(a, 'cross-batch'),
        first = await propose(f, 'Ａ５：今天的三件小事！'),
        second = await propose(f, 'A5 今天的三件小事');
      expect(second.result.topicIds).toEqual(first.result.topicIds);
      expect(second.result.duplicateTopicIds).toEqual(first.result.topicIds);
      const [counts] = await fixture.db<
        { topics: number; links: number }[]
      >`select
      (select count(*)::int from allrice_brand_content_topics where brand_id=${f.brandId}) as topics,
      (select count(*)::int from allrice_brand_content_batch_topics where brand_id=${f.brandId}) as links`;
      expect(counts).toEqual({ topics: 1, links: 2 });
      await accept(f, first);
      const updated = await board(f);
      expect(updated.batches.map((x) => x.revision)).toEqual([2, 2]);
      await expect(
        mutateBrandContent(
          a.context,
          {
            ...a.scope,
            brandId: f.brandId,
            operation: 'topics.decide',
            requestId: freshKey('stale-other-batch'),
            batchId: second.result.entityId,
            expectedRevision: 1,
            choices: [
              {
                topicId: first.result.topicIds![0]!,
                decision: 'rejected',
                reason: 'stale view',
              },
            ],
          },
          { db: fixture.db },
        ),
      ).rejects.toMatchObject({ code: 'version_conflict' });
      expect((await board(f)).topics[0]!.state).toBe('accepted');
    });

    it('checks actual storage checksums, exact native parents, and cross-instance/tenant file ownership before changing a draft', async () => {
      const f = await prepareDraft(a, 'source-boundary'),
        revised = await seedDocument(a, 'Synthetic corrected A5 body.', {
          parent: f.document,
        });
      const edit = {
        ...a.scope,
        brandId: f.brand.brandId,
        operation: 'article.submit',
        requestId: freshKey('bad-parent'),
        articleId: f.submitted.result.entityId,
        expectedRevision: f.submitted.result.revision,
        topicId: f.topicId,
        sessionId: a.session.id,
        content: ref(revised),
        parentVersionId: randomUUID(),
        changeSummary: 'Must not be committed.',
      };
      await expect(
        mutateBrandContent(a.context, edit, { db: fixture.db }),
      ).rejects.toMatchObject({ code: 'parent_mismatch' });
      await expect(
        mutateBrandContent(
          a.context,
          {
            ...edit,
            requestId: freshKey('bad-checksum'),
            parentVersionId: f.document.version.id,
            content: { ...ref(revised), checksum: 'sha256:' + 'd'.repeat(64) },
          },
          { db: fixture.db },
        ),
      ).rejects.toMatchObject({ code: 'source_changed' });
      const otherInstanceDocument = await seedDocument(
        a,
        'Private second instance content.',
        { sessionId: alternate.session.id },
      );
      await expect(
        mutateBrandContent(
          a.context,
          {
            ...edit,
            requestId: freshKey('other-instance-file'),
            content: ref(otherInstanceDocument),
            parentVersionId: f.document.version.id,
          },
          { db: fixture.db },
        ),
      ).rejects.toMatchObject({ code: 'source_unavailable' });
      const otherTenantDocument = await seedDocument(
        b,
        'Private other tenant content.',
      );
      await expect(
        mutateBrandContent(
          a.context,
          {
            ...edit,
            requestId: freshKey('other-tenant-file'),
            content: ref(otherTenantDocument),
            parentVersionId: f.document.version.id,
          },
          { db: fixture.db },
        ),
      ).rejects.toMatchObject({ code: 'source_unavailable' });
      const unchanged = await board(f.brand);
      expect(unchanged.bundles).toHaveLength(1);
      expect(unchanged.articles[0]).toMatchObject({
        revision: f.submitted.result.revision,
        currentBundleId: unchanged.bundles[0]!.id,
      });
    });

    it('denies foreign business IDs to another instance and tenant, including writes and real artifact reads', async () => {
      const f = await prepareDraft(a, 'business-isolation');
      const secondScope = {
        workspaceId: a.workspace,
        instanceId: alternate.instance.id,
      };
      for (const actor of [
        { context: a.context, scope: secondScope },
        { context: b.context, scope: b.scope },
      ]) {
        await expect(
          getBrandContentBoard(
            actor.context,
            { ...actor.scope, brandId: f.brand.brandId },
            { db: fixture.db },
          ),
        ).rejects.toMatchObject({ code: 'not_found' });
        await expect(
          mutateBrandContent(
            actor.context,
            {
              ...actor.scope,
              brandId: f.brand.brandId,
              operation: 'context.save',
              requestId: freshKey('foreign-write'),
              expectedRevision: 1,
              name: 'Must not change A',
              content: {
                audience: 'other',
                tone: 'other',
                requirements: 'other',
                facts: [{ id: 'x', text: 'wrong tenant' }],
              },
            },
            { db: fixture.db },
          ),
        ).rejects.toMatchObject({ code: 'not_found' });
        const listed = await listBrandContentBrands(
          actor.context,
          actor.scope,
          { db: fixture.db },
        );
        expect(listed.brands.some((x) => x.id === f.brand.brandId)).toBe(false);
      }
      await expect(
        getWorkbenchArtifact(
          b.context,
          a.session.id,
          f.document.version.id,
          fixture.db,
        ),
      ).rejects.toThrow();
      const unrelated = await prepareBrand(a, 'other-brand');
      await expect(
        mutateBrandContent(
          a.context,
          {
            ...a.scope,
            brandId: unrelated.brandId,
            operation: 'article.review',
            requestId: freshKey('cross-brand-review'),
            articleId: f.submitted.result.entityId,
            expectedRevision: f.submitted.result.revision,
            bundleDigest: f.submitted.result.bundleDigest!,
            decision: 'approved',
            reason: 'Wrong brand must fail.',
          },
          { db: fixture.db },
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect((await board(f.brand)).articles[0]!.state).toBe('awaiting_review');
    });

    it('rolls back real SQL writes and the request receipt when the trusted commit fence loses authority', async () => {
      const f = await prepareBrand(a, 'commit-fence');
      const input = {
        ...a.scope,
        brandId: f.brandId,
        operation: 'topics.propose',
        requestId: freshKey('fenced-proposal'),
        contextRevisionId: f.contextRevisionId,
        platform: '小红书',
        candidates: [candidate('提交前失权时不可留下的候选')],
      };
      await expect(
        mutateBrandContent(a.context, input, {
          db: fixture.db,
          beforeCommit: async (tx) => {
            const [inside] = await tx<
              { n: number }[]
            >`select count(*)::int n from allrice_brand_content_topics where brand_id=${f.brandId}`;
            expect(inside?.n).toBe(1); // The insert really happened inside this transaction.
            throw Error('isolated_fixture_lease_lost');
          },
        }),
      ).rejects.toThrow('isolated_fixture_lease_lost');
      const [counts] = await fixture.db<
        { topics: number; batches: number; requests: number }[]
      >`select
      (select count(*)::int from allrice_brand_content_topics where brand_id=${f.brandId}) as topics,
      (select count(*)::int from allrice_brand_content_batches where brand_id=${f.brandId}) as batches,
      (select count(*)::int from allrice_brand_content_requests where organization_id=${a.org} and owner_id=${a.user}
        and instance_id=${a.instance.id} and request_id=${input.requestId}) as requests`;
      expect(counts).toEqual({
        topics: 0,
        batches: 0,
        requests: 0,
      });
      const retry = await mutateBrandContent(a.context, input, {
        db: fixture.db,
      });
      expect(retry.replayed).toBe(false);
      expect((await board(f)).topics).toHaveLength(1);
    });

    it('rolls back a newly registered artifact with a rejected composed article submission and preserves the original latest version', async () => {
      const f = await prepareDraft(a, 'artifact-composition');
      const requestId = freshKey('composed-article');
      let attempted: WorkbenchArtifact | undefined;
      const submit = (
        tx: Tx,
        artifact: WorkbenchArtifact,
        expectedRevision: number,
        loseFence: boolean,
      ) =>
        mutateBrandContentInTransaction(
          a.context,
          {
            ...a.scope,
            brandId: f.brand.brandId,
            operation: 'article.submit',
            requestId,
            articleId: f.submitted.result.entityId,
            expectedRevision,
            topicId: f.topicId,
            sessionId: a.session.id,
            content: ref(artifact),
            parentVersionId: f.document.version.id,
            changeSummary: 'Synthetic same-transaction revision.',
          },
          tx,
          {
            beforeCommit: async (current) => {
              expect(current).toBe(tx);
              if (loseFence) {
                const [written] = await tx<
                  { n: number }[]
                >`select count(*)::int n from allrice_brand_content_bundles where article_id=${f.submitted.result.entityId}`;
                expect(written?.n).toBe(2);
                throw Error('isolated_composition_lease_lost');
              }
            },
          },
        );
      for (const failure of ['cas', 'fence'] as const) {
        await expect(
          seedDocument(a, `Synthetic composed revision ${failure}.`, {
            parent: f.document,
            registered: async (tx, artifact) => {
              attempted = artifact;
              await submit(
                tx,
                artifact,
                failure === 'cas' ? 0 : f.submitted.result.revision,
                failure === 'fence',
              );
            },
          }),
        ).rejects.toThrow(
          failure === 'cas'
            ? 'version_conflict'
            : 'isolated_composition_lease_lost',
        );
        expect(attempted).toBeDefined();
        const [remaining] = await fixture.db<
          {
            objects: number;
            versions: number;
            artifacts: number;
            requests: number;
            bundles: number;
          }[]
        >`select
          (select count(*)::int from allrice_storage_objects where id=${attempted!.object.id}) as objects,
          (select count(*)::int from allrice_deliverable_versions where id=${attempted!.version.id}) as versions,
          (select count(*)::int from allrice_workbench_artifacts where version_id=${attempted!.version.id}) as artifacts,
          (select count(*)::int from allrice_brand_content_requests where organization_id=${a.org} and owner_id=${a.user} and instance_id=${a.instance.id} and request_id=${requestId}) as requests,
          (select count(*)::int from allrice_brand_content_bundles where article_id=${f.submitted.result.entityId}) as bundles`;
        expect(remaining).toEqual({
          objects: 0,
          versions: 0,
          artifacts: 0,
          requests: 0,
          bundles: 1,
        });
        const original = await getWorkbenchArtifact(
          a.context,
          a.session.id,
          f.document.version.id,
          fixture.db,
        );
        expect(original.stale).toBe(false);
        const current = await board(f.brand);
        expect(current.articles[0]!.revision).toBe(f.submitted.result.revision);
        expect(current.bundles[0]!.content.versionId).toBe(
          f.document.version.id,
        );
      }
      const committed = await seedDocument(
        a,
        'Synthetic composed revision committed together.',
        {
          parent: f.document,
          registered: async (tx, artifact) => {
            await submit(tx, artifact, f.submitted.result.revision, false);
          },
        },
      );
      const current = await board(f.brand);
      expect(current.articles[0]!.revision).toBe(
        f.submitted.result.revision + 1,
      );
      expect(
        current.bundles.find(
          (row) => row.id === current.articles[0]!.currentBundleId,
        )?.content.versionId,
      ).toBe(committed.version.id);
      const [receipt] = await fixture.db<
        { n: number }[]
      >`select count(*)::int n from allrice_brand_content_requests where organization_id=${a.org} and owner_id=${a.user} and instance_id=${a.instance.id} and request_id=${requestId}`;
      expect(receipt?.n).toBe(1);
    });

    it('rejects a new flag-OFF reminder without changing its approved plan or creating automation, registration or receipt rows', async () => {
      expect(process.env.ALLRICE_NATIVE_ONCE_ENABLED).toBe('0');
      const workflow = await ensureReminderPackage();
      const f = await prepareReminderPlan(
        a,
        'disabled-new-registration',
        60_000,
      );
      const state = async () => {
        const [row] = await fixture.db`select
          (select count(*)::int from allrice_automations) automations,
          (select count(*)::int from allrice_brand_content_reminders) reminders,
          (select count(*)::int from allrice_brand_content_requests) requests,
          (select count(*)::int from allrice_brand_content_receipts) publication_receipts,
          (select count(*)::int from allrice_native_once_controls) controls,
          (select count(*)::int from allrice_brand_native_reminder_targets) targets,
          (select to_jsonb(p) from allrice_brand_content_plans p where id=${f.input.planId}) plan`;
        return row;
      };
      const before = await state();
      await expect(
        registerBrandContentReminder(a.context, f.input, {
          db: fixture.db,
          workflow: reminderPin(workflow),
        }),
      ).rejects.toMatchObject({ code: 'reminder_unavailable' });
      expect(await state()).toEqual(before);
      expect((await board(f.brand)).plans[0]).toMatchObject({
        revision: f.input.expectedRevision,
        reminderStatus: 'not_registered',
        automationId: null,
      });
    });

    describe.sequential(
      'brand native once SQL receipts, not a public Host timer acceptance',
      () => {
        let store: ReturnType<typeof createNativeOnceSqlStore>;
        let writer: NativeOnceWriter;
        let publicTaskSchema: { parse(value: unknown): NativeOnceTask };
        const ready = {
          enabled: true,
          storageReady: true,
          legacyClockExcluded: true,
          controlArtifactApproved: true,
        };
        type NativeIdentity = {
          reminder_id: string;
          plan_revision: number;
          reserved_occurrence_id: string;
          reserved_message_id: string;
          session_id: string;
          scheduled_for: Date;
          business_revision: number;
          reminder_snapshot: unknown;
          plan_snapshot: unknown;
          automation_snapshot: unknown;
        };
        beforeAll(async () => {
          vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '1');
          const reference: NativeOnceReference = {
            artifactId: 'sha256:' + 'a'.repeat(64),
            profileId: 'allrice-once-control-v1',
            storageId: 'isolated-brand-native-sql',
            stateRoot: await realpath(fixture.storageRoot),
          };
          vi.stubEnv(
            'ALLRICE_NATIVE_ONCE_REFERENCE',
            JSON.stringify(reference),
          );
          expect(await initializeNativeOncePartition(reference)).toMatchObject({
            reference,
            activation: ready,
          });
          // Use the installed Worker's public schema without adding a database
          // dependency. Importing this module does not instantiate a Host.
          const workerRequire = createRequire(
            new URL('../../../../apps/worker/package.json', import.meta.url),
          );
          const schedule = await import(
            pathToFileURL(workerRequire.resolve('@deepseek-ai/dsh-schedule'))
              .href
          );
          publicTaskSchema = schedule.scheduleDomain.tables.tasks.valueSchema;
          store = createNativeOnceSqlStore({
            db: fixture.db,
            partitionId: 'allrice-once-v1',
            ownerId: randomUUID(),
            reference,
            ttlMs: 300_000,
            readiness: () => ready,
            decodeTask: (value) => publicTaskSchema.parse(value),
            lockAdmission: lockNativeOnceAdmissions,
            proveClosed: async () => null,
          });
          const grant = await store.acquireWriter();
          expect(grant).not.toBeNull();
          writer = grant!.writer;
        }, 30_000);
        afterAll(() => {
          // Preserve the enclosing fixture's other env stubs until its cleanup.
          vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '0');
        });

        it('rolls back the actual registration and plan writes when the native partition is not ready', async () => {
          const workflow = await ensureReminderPackage();
          const f = await prepareReminderPlan(a, 'partition-not-ready', 60_000);
          const [partition] =
            await fixture.db`select activation from allrice_native_once_partitions
            where partition_id='allrice-once-v1'`;
          const state = async () =>
            (
              await fixture.db`select
            (select count(*)::int from allrice_automations) automations,
            (select count(*)::int from allrice_brand_content_reminders) reminders,
            (select count(*)::int from allrice_brand_content_requests) requests,
            (select count(*)::int from allrice_native_once_controls) controls,
            (select count(*)::int from allrice_native_once_journal) journal,
            (select count(*)::int from allrice_brand_native_reminder_targets) targets,
            (select count(*)::int from allrice_automation_runs) occurrences,
            (select count(*)::int from allrice_runs) runs,
            (select count(*)::int from allrice_jobs) jobs,
            (select to_jsonb(p) from allrice_brand_content_plans p where id=${f.input.planId}) plan`
            )[0];
          const before = await state();
          await fixture.db`update allrice_native_once_partitions set activation=${fixture.db.json({ ...partition!.activation, storageReady: false })}
            where partition_id='allrice-once-v1'`;
          try {
            await expect(
              registerBrandContentReminder(a.context, f.input, {
                db: fixture.db,
                workflow: reminderPin(workflow),
              }),
            ).rejects.toMatchObject({ code: 'reminder_unavailable' });
            expect(await state()).toEqual(before);
          } finally {
            await fixture.db`update allrice_native_once_partitions set activation=${fixture.db.json(partition!.activation)}
              where partition_id='allrice-once-v1'`;
          }
        });

        async function identity(automationId: string) {
          const [row] = await fixture.db<NativeIdentity[]>`
          select r.id as reminder_id,r.plan_revision,r.reserved_occurrence_id,r.reserved_message_id,
            r.session_id,r.scheduled_for,t.business_revision,
            to_jsonb(r)-array['state','automation_run_id','delivery_message_id','delivery_content_digest','completed_at','error_code'] as reminder_snapshot,
            to_jsonb(p)-array['revision','reminder_status','automation_run_id','run_id','reminder_message_id','updated_at'] as plan_snapshot,
            to_jsonb(a)-array['revision','status','next_run_at','last_run_at','updated_at'] as automation_snapshot
          from allrice_brand_content_reminders r
          join allrice_brand_content_plans p on p.id=r.plan_id
          join allrice_automations a on a.id=r.automation_id
          join allrice_brand_native_reminder_targets t on t.reminder_id=r.id
          where r.automation_id=${automationId}`;
          expect(row).toBeDefined();
          return row!;
        }
        async function control(automationId: string) {
          const [row] = await fixture.db<{ snapshot: NativeOnceSnapshot }[]>`
          select snapshot from allrice_native_once_controls
          where automation_id=${automationId} order by revision desc limit 1`;
          expect(row).toBeDefined();
          return row!.snapshot.control;
        }
        async function runJobCounts() {
          const [row] = await fixture.db`select
          (select count(*)::int from allrice_runs) as runs,
          (select count(*)::int from allrice_jobs) as jobs,
          (select count(*)::int from allrice_employee_runs) as employee_runs`;
          return row!;
        }
        async function write(mutation: NativeOnceMutation) {
          expect(await store.renewWriter(writer)).not.toBeNull();
          const value = {
            writeId: randomUUID(),
            digest: nativeOnceDigest(mutation),
            mutation,
          };
          expect(await store.commitMutation(writer, value)).toBe('committed');
          expect(await store.readExactCommit(writer, value)).toBe('committed');
          return value;
        }
        async function enrolled(
          label: string,
          delayMs = 3_000,
          sourceFiles: BrandContentFileRef[] = [],
        ) {
          const workflow = await ensureReminderPackage();
          const f = await prepareReminderPlan(a, label, delayMs, sourceFiles);
          const registered = await registerBrandContentReminder(
            a.context,
            f.input,
            {
              db: fixture.db,
              workflow: reminderPin(workflow),
            },
          );
          return {
            ...f,
            registered,
            original: await identity(registered.automationId),
          };
        }
        type Enrolled = Awaited<ReturnType<typeof enrolled>>;
        async function readySession(c: NativeOnceControl) {
          await write({ kind: 'session_initializing', controlId: c.controlId });
          await write({ kind: 'session_ready', controlId: c.controlId });
        }
        async function preparedClock(f: Enrolled) {
          const c = await control(f.registered.automationId);
          await readySession(c);
          const task = publicTaskSchema.parse({
            sessionId: c.controlSessionId,
            record: {
              id: randomUUID(),
              kind: 'at',
              title: 'AllRice once control',
              prompt:
                'Synthetic schedule control only. Never execute business work.',
              scheduledAt: c.at,
            },
            status: 'active',
            deliveryHistory: { records: [], earlierRecordsUnavailable: false },
          });
          await write({ kind: 'put_task', controlId: c.controlId, task });
          await write({
            kind: 'confirm_command',
            controlId: c.controlId,
            commandId: c.command.id,
            nativeTaskId: task.record.id,
          });
          return { control: c, task };
        }
        /** The public schema validates this synthetic component-boundary receipt.
         * Actual SQL admission/store/dispatcher are exercised. No Host, timer
         * firing, model or filesystem catalog absence is claimed by this fixture. */
        async function delivered(
          clock: Awaited<ReturnType<typeof preparedClock>>,
        ) {
          await waitUntilReminder(new Date(clock.control.at));
          const [now] = await fixture.db<
            { now: Date }[]
          >`select clock_timestamp() now`;
          const receipt = {
            scheduledAt: clock.control.at,
            deliveredAt: now!.now.toISOString(),
            messageId: randomUUID(),
          };
          const task = publicTaskSchema.parse({
            ...clock.task,
            status: 'inactive',
            lastDelivery: receipt,
            deliveryHistory: {
              records: [{ ...receipt, prompt: clock.task.record.prompt }],
              earlierRecordsUnavailable: false,
            },
          });
          return write({
            kind: 'put_task',
            controlId: clock.control.controlId,
            task,
          });
        }

        it('atomically delivers one native private-session reminder without a Run and preserves the original package across rollback and ACK retry', async () => {
          const originalPackage = await ensureReminderPackage();
          const f = await prepareReminderPlan(
            a,
            'actual-native-reminder',
            3_000,
          );
          const [countsBefore] = await fixture.db<
            { runs: number; jobs: number }[]
          >`select
            (select count(*)::int from allrice_runs) as runs,(select count(*)::int from allrice_jobs) as jobs`;
          expect(countsBefore).toBeDefined();
          const registrations = await Promise.all(
            [1, 2].map(() =>
              registerBrandContentReminder(a.context, f.input, {
                db: fixture.db,
                workflow: reminderPin(originalPackage),
              }),
            ),
          );
          expect(
            new Set(registrations.map((row) => row.automationId)).size,
          ).toBe(1);
          expect(registrations.filter((row) => row.replayed)).toHaveLength(1);
          const registered = registrations[0]!;
          expect((await board(f.brand)).plans[0]).toMatchObject({
            reminderStatus: 'registered',
            reminderMessageId: null,
          });
          await expect(
            registerBrandContentReminder(
              a.context,
              { ...f.input, expectedRevision: f.input.expectedRevision + 1 },
              {
                db: fixture.db,
                workflow: reminderPin(originalPackage),
              },
            ),
          ).rejects.toMatchObject({ code: 'request_conflict' });
          activeReminderPackage = await prepareReminderPackage(
            a,
            reminderMethod!,
            originalPackage,
          );
          expect(activeReminderPackage.workflow.id).not.toBe(
            originalPackage.workflow.id,
          );
          const retried = await registerBrandContentReminder(
            a.context,
            f.input,
            {
              db: fixture.db,
              workflow: reminderPin(activeReminderPackage),
            },
          );
          expect(retried).toMatchObject({
            automationId: registered.automationId,
            replayed: true,
          });
          vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '0');
          try {
            const replay = await registerBrandContentReminder(
              a.context,
              f.input,
              {
                db: fixture.db,
                workflow: reminderPin(activeReminderPackage),
              },
            );
            expect(replay).toEqual({ ...registered, replayed: true });
          } finally {
            vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '1');
          }
          const [frozen] = await fixture.db<
            {
              workflow_revision_id: string;
              package_digest: string;
              reserved_message_id: string;
            }[]
          >`
            select workflow_revision_id,package_digest,reserved_message_id from allrice_brand_content_reminders where automation_id=${registered.automationId}`;
          expect(frozen).toMatchObject({
            workflow_revision_id: originalPackage.workflow.id,
            package_digest: originalPackage.checksum,
          });
          // A real ordinary Run cannot be manufactured to bypass message evidence.
          await expect(
            mutateBrandContent(
              a.context,
              {
                ...a.scope,
                brandId: f.brand.brandId,
                planId: f.input.planId,
                operation: 'plan.reminder',
                requestId: freshKey('unconfirmed-message'),
                expectedRevision: registered.revision,
                status: 'reminded',
                automationId: registered.automationId,
                automationRunId: randomUUID(),
                deliveryMessageId: randomUUID(),
              },
              { db: fixture.db, authority: 'scheduler' },
            ),
          ).rejects.toMatchObject({ code: 'reminder_unconfirmed' });
          const nativeFixture = {
            ...f,
            registered,
            original: await identity(registered.automationId),
          };
          const clock = await preparedClock(nativeFixture);
          const receiptWrite = await delivered(clock);
          await expect(
            fixture.db.begin(async (tx) => {
              // Execute the actual claim and sink in real SQL savepoints. The
              // caller's rollback also removes the claim, not just its message.
              const nested = new Proxy(fixture.db, {
                get(target, key, receiver) {
                  if (key !== 'begin')
                    return Reflect.get(target, key, receiver);
                  return (work: (inner: Tx) => Promise<unknown>) =>
                    tx.savepoint(work);
                },
              });
              vi.mocked(client.getDatabase).mockReturnValue(nested);
              try {
                expect(
                  await dispatchNextNativeOnceOccurrence(randomUUID()),
                ).toBe(true);
                const [written] =
                  await tx`select id from allrice_messages where id=${frozen!.reserved_message_id}`;
                expect(written?.id).toBe(frozen!.reserved_message_id);
                throw Error('isolated_after_message_before_commit');
              } finally {
                vi.mocked(client.getDatabase).mockReturnValue(fixture.db);
              }
            }),
          ).rejects.toThrow('isolated_after_message_before_commit');
          const [rolledBack] = await fixture.db<
            { occurrences: number; messages: number; status: string }[]
          >`select
            (select count(*)::int from allrice_automation_runs where automation_id=${registered.automationId}) as occurrences,
            (select count(*)::int from allrice_messages where id=${frozen!.reserved_message_id}) as messages,
            (select status from allrice_automations where id=${registered.automationId}) as status`;
          expect(rolledBack).toEqual({
            occurrences: 0,
            messages: 0,
            status: 'enabled',
          });
          expect((await board(f.brand)).plans[0]!.reminderStatus).toBe(
            'registered',
          );
          let lostDeliveryAck = false;
          const lostAckDatabase = new Proxy(fixture.db, {
            get(target, key, receiver) {
              if (key !== 'begin') return Reflect.get(target, key, receiver);
              return async (work: (tx: Tx) => Promise<unknown>) => {
                let messageWritten = false;
                const result = await fixture.db.begin(async (tx) => {
                  const value = await work(tx);
                  const [written] =
                    await tx`select id from allrice_messages where id=${frozen!.reserved_message_id}`;
                  messageWritten = written?.id === frozen!.reserved_message_id;
                  return value;
                });
                // The real sink transaction COMMIT already happened. Preserve
                // this original unknown ACK and read only its durable identities.
                if (messageWritten) {
                  lostDeliveryAck = true;
                  throw Error('isolated_native_delivery_commit_ack_lost');
                }
                return result;
              };
            },
          });
          vi.mocked(client.getDatabase).mockReturnValue(lostAckDatabase);
          try {
            await expect(
              dispatchNextNativeOnceOccurrence(randomUUID()),
            ).rejects.toThrow('isolated_native_delivery_commit_ack_lost');
          } finally {
            vi.mocked(client.getDatabase).mockReturnValue(fixture.db);
          }
          expect(lostDeliveryAck).toBe(true);
          expect(await store.readExactCommit(writer, receiptWrite)).toBe(
            'committed',
          );
          expect(await dispatchNextNativeOnceOccurrence(randomUUID())).toBe(
            false,
          );
          const current = await board(f.brand),
            plan = current.plans[0]!;
          expect(plan).toMatchObject({
            reminderStatus: 'reminded',
            automationId: registered.automationId,
            runId: null,
          });
          expect(plan.reminderMessageId).toBe(frozen!.reserved_message_id);
          const history = await getChatSessionHistory(
            a.context,
            a.workspace,
            a.session.id,
          );
          const message = history.messages.find(
            (row) => row.id === plan.reminderMessageId,
          );
          expect(message).toMatchObject({
            role: 'assistant',
            status: 'completed',
            runId: null,
            sessionId: a.session.id,
            ownerId: a.user,
          });
          expect(message!.content.text).toContain('发布提醒');
          expect(message!.content.text).toContain(
            `/api/v1/files/${f.document.object.id}/download`,
          );
          expect(message!.content.text).toContain('不表示已对外发布');
          await expect(
            runAutomationNow(a.context, a.workspace, registered.automationId),
          ).rejects.toMatchObject({ code: 'grant_invalid' });
          const [after] = await fixture.db<
            {
              runs: number;
              jobs: number;
              occurrences: number;
              messages: number;
              receipts: number;
            }[]
          >`select
            (select count(*)::int from allrice_runs) as runs,(select count(*)::int from allrice_jobs) as jobs,
            (select count(*)::int from allrice_automation_runs where automation_id=${registered.automationId} and status='succeeded' and run_id is null) as occurrences,
            (select count(*)::int from allrice_messages where id=${plan.reminderMessageId!}) as messages,
            (select count(*)::int from allrice_brand_content_receipts where plan_id=${plan.id}) as receipts`;
          expect(after).toEqual({
            ...countsBefore!,
            occurrences: 1,
            messages: 1,
            receipts: 0,
          });
        }, 30_000);

        it('reschedules and cancels only its dedicated consumer and refuses sibling-instance or cross-tenant registration', async () => {
          const value = await ensureReminderPackage();
          const f = await enrolled('reschedule-reminder', 60_000);
          for (const wrong of [
            {
              context: a.context,
              input: { ...f.input, instanceId: alternate.instance.id },
            },
            {
              context: b.context,
              input: {
                ...f.input,
                workspaceId: b.workspace,
                instanceId: b.instance.id,
              },
            },
          ])
            await expect(
              registerBrandContentReminder(wrong.context, wrong.input, {
                db: fixture.db,
                workflow: reminderPin(value),
              }),
            ).rejects.toThrow();
          const first = f.registered;
          const changed = await mutateBrandContent(
            a.context,
            {
              ...a.scope,
              brandId: f.brand.brandId,
              operation: 'plan.save',
              requestId: freshKey('reschedule'),
              planId: first.planId,
              expectedRevision: first.revision,
              articleId: f.submitted.result.entityId,
              bundleDigest: f.reviewed.result.bundleDigest!,
              reviewId: f.reviewed.result.reviewId!,
              platform: '小红书',
              plannedAt: new Date(Date.now() + 120_000).toISOString(),
              timezone: 'Asia/Shanghai',
              publisher: 'MET194 synthetic human publisher',
              notes: 'Synthetic reschedule.',
            },
            { db: fixture.db },
          );
          expect(changed.result.reminderStatus).toBe('not_registered');
          const second = await registerBrandContentReminder(
            a.context,
            {
              ...f.input,
              expectedRevision: changed.result.revision,
              requestId: freshKey('rescheduled-registration'),
            },
            { db: fixture.db, workflow: reminderPin(value) },
          );
          await mutateBrandContent(
            a.context,
            {
              ...a.scope,
              brandId: f.brand.brandId,
              operation: 'plan.cancel',
              planId: first.planId,
              requestId: freshKey('cancel-reminder'),
              expectedRevision: second.revision,
              reason: 'Synthetic human cancellation.',
            },
            { db: fixture.db },
          );
          const rows = await fixture.db<
            {
              state: string;
              status: string;
              next_run_at: Date | null;
              deliveries: number;
            }[]
          >`
            select r.state,a.status,a.next_run_at,(select count(*)::int from allrice_automation_runs o where o.automation_id=a.id) as deliveries
            from allrice_brand_content_reminders r join allrice_automations a on a.id=r.automation_id where r.plan_id=${first.planId}`;
          expect(rows).toHaveLength(2);
          for (const row of rows)
            expect(row).toEqual({
              state: 'superseded',
              status: 'paused',
              next_run_at: null,
              deliveries: 0,
            });
          expect((await board(f.brand)).plans[0]).toMatchObject({
            state: 'cancelled',
            reminderStatus: 'not_registered',
            reminderMessageId: null,
          });
          await expect(
            runAutomationNow(a.context, a.workspace, first.automationId),
          ).rejects.toMatchObject({ code: 'grant_invalid' });
        });

        it('persists a real failed occurrence with no message when current owner, cloud, source, approval or package authority is lost before native receipt consumption', async () => {
          const value = await ensureReminderPackage();
          const failures = [
            'membership',
            'cloud',
            'source',
            'bundle',
            'package',
          ] as const;
          const preparedCases: Array<{
            failure: (typeof failures)[number];
            revocable: BrandContentFileRef | undefined;
            f: Enrolled;
            clock: Awaited<ReturnType<typeof preparedClock>>;
          }> = [];
          // Arm all five legitimate controls first. Their existing >=15s lower
          // bound overlaps; the original 45s case timeout is not extended.
          for (const failure of failures) {
            const revocable =
              failure === 'source'
                ? await prepareRevocableBrandSource(a)
                : undefined;
            const f = await enrolled(
              `blocked-reminder-${failure}`,
              2_000,
              revocable ? [revocable] : [],
            );
            preparedCases.push({
              failure,
              revocable,
              f,
              clock: await preparedClock(f),
            });
          }
          const countsBefore = await runJobCounts();
          for (const { failure, revocable, f, clock } of preparedCases) {
            const registered = f.registered;
            let restore = async () => {};
            if (failure === 'membership') {
              const memberships = await fixture.db<
                { id: string }[]
              >`select id from allrice_memberships where organization_id=${a.org} and user_id=${a.user} and active`;
              const ids = memberships.map((row) => row.id);
              await fixture.db`update allrice_memberships set active=false where id in ${fixture.db(ids)}`;
              restore = async () => {
                await fixture.db`update allrice_memberships set active=true where id in ${fixture.db(ids)}`;
              };
            } else if (failure === 'cloud') {
              const work = await getWorkAutomation(
                a.context,
                a.workspace,
                fixture.db,
              );
              await updateWorkAutomation(
                a.context,
                a.workspace,
                {
                  capability: 'cloud',
                  enabled: false,
                  expectedRevision: work.revision,
                },
                fixture.db,
              );
              restore = async () => {
                const work = await getWorkAutomation(
                  a.context,
                  a.workspace,
                  fixture.db,
                );
                await updateWorkAutomation(
                  a.context,
                  a.workspace,
                  {
                    capability: 'cloud',
                    enabled: true,
                    expectedRevision: work.revision,
                  },
                  fixture.db,
                );
              };
            } else if (failure === 'source') {
              // Withdraw a real mutable user-upload source through its authorized
              // deletion path. The immutable approved deliverable is never edited.
              const prepared = await prepareStorageDelete(
                a.context,
                revocable!.objectId,
              );
              await assistantFixtureStorage(fixture.db).delete(prepared.object);
              await completeStorageDelete(a.context, revocable!.objectId);
              await expect(
                getStoredFile(a.context, revocable!.objectId, fixture.db),
              ).rejects.toMatchObject({ code: 'not_found' });
            } else if (failure === 'bundle') {
              const image = await seedUpload(a, [20, 80, 40]);
              await mutateBrandContent(
                a.context,
                {
                  ...a.scope,
                  brandId: f.brand.brandId,
                  operation: 'article.images',
                  requestId: freshKey('unreviewed-image'),
                  articleId: f.submitted.result.entityId,
                  expectedRevision: f.reviewed.result.revision,
                  bundleDigest: f.reviewed.result.bundleDigest!,
                  images: [
                    { slotKey: 'cover', file: image, sourceKind: 'uploaded' },
                  ],
                  changeSummary:
                    'Synthetic new image requires a new human review.',
                },
                { db: fixture.db },
              );
            } else {
              const [binding] = await fixture.db<
                { binding_revision: number }[]
              >`select binding_revision from allrice_employee_workflow_bindings where instance_id=${a.instance.id} and workflow_id=${value.workflow.workflowId} and scene_id is null`;
              expect(binding).toBeDefined();
              const disabled = await setWorkflowPackageBinding(a.context, {
                ...a.scope,
                sceneId: null,
                workflowRevisionId: value.workflow.id,
                requestId: randomUUID(),
                expectedRevision: binding!.binding_revision,
                enabled: false,
              });
              restore = async () => {
                await setWorkflowPackageBinding(a.context, {
                  ...a.scope,
                  sceneId: null,
                  workflowRevisionId: value.workflow.id,
                  requestId: randomUUID(),
                  expectedRevision: disabled.revision,
                  enabled: true,
                });
              };
            }
            try {
              await delivered(clock);
              // The existing native sink must record this business denial, not
              // send a message or poison the following independent occurrence.
              expect(await dispatchNextNativeOnceOccurrence(randomUUID())).toBe(
                true,
              );
            } finally {
              await restore();
            }
            const [result] = await fixture.db<
              {
                state: string;
                status: string;
                run_id: string | null;
                automation_status: string;
                messages: number;
              }[]
            >`
              select d.state,o.status,o.run_id,a.status as automation_status,
                (select count(*)::int from allrice_messages m where m.id=d.reserved_message_id) as messages
              from allrice_brand_content_reminders d join allrice_automation_runs o on o.id=d.automation_run_id
              join allrice_automations a on a.id=d.automation_id where d.automation_id=${registered.automationId}`;
            expect(result, failure).toEqual({
              state: 'blocked',
              status: 'failed',
              run_id: null,
              automation_status: 'paused',
              messages: 0,
            });
            const [plan] = await fixture.db<
              { reminder_status: string }[]
            >`select reminder_status from allrice_brand_content_plans
              where id=${registered.planId} and organization_id=${a.org} and workspace_id=${a.workspace} and owner_id=${a.user} and instance_id=${a.instance.id}`;
            expect(plan?.reminder_status).toBe('failed');
            expect(await identity(registered.automationId)).toEqual(f.original);
            const [native] =
              await fixture.db`select occurrence_id,outbox_state from allrice_native_once_occurrences where automation_id=${registered.automationId}`;
            expect(native).toEqual({
              occurrence_id: clock.control.dispatch.occurrenceId,
              outbox_state: 'blocked',
            });
            if (failure === 'source')
              await expect(board(f.brand)).rejects.toMatchObject({
                code: 'source_unavailable',
              });
          }
          expect(await runJobCounts()).toEqual(countsBefore);
        }, 45_000);

        it('preserves original IDs/P, rejects ordinary execution and once APIs, and consumes one SQL receipt exactly once without Run/Job', async () => {
          const f = await enrolled('native-original-private-target');
          const original = f.original,
            c = await control(f.registered.automationId);
          expect(original).toMatchObject({
            plan_revision: f.registered.revision,
            session_id: a.session.id,
            scheduled_for: f.plannedAt,
            plan_snapshot: {
              id: f.input.planId,
              article_id: f.submitted.result.entityId,
              bundle_digest: f.reviewed.result.bundleDigest,
              review_id: f.reviewed.result.reviewId,
            },
            automation_snapshot: {
              id: f.registered.automationId,
              brand_content_binding: original.reminder_id,
              clock_owner: 'native_once',
              session_id: a.session.id,
              schedule: { frequency: 'once', runAt: f.plannedAt.toISOString() },
            },
            reminder_snapshot: {
              workflow_revision_id: (await ensureReminderPackage()).workflow.id,
              request_id: f.input.requestId,
              plan_id: f.input.planId,
            },
          });
          expect(c.dispatch).toMatchObject({
            consumer: 'brand-reminder-v1',
            reminderId: original.reminder_id,
            businessRevision: original.business_revision,
            plannedAt: f.plannedAt.toISOString(),
            businessOccurrenceId: original.reserved_occurrence_id,
            businessMessageId: original.reserved_message_id,
            businessSessionId: a.session.id,
            employeeInstanceId: a.instance.id,
            employeeAssignmentId: a.assignmentId,
          });
          expect(c.revision).toBe(1);
          expect(c.dispatch.occurrenceId).not.toBe(
            original.reserved_occurrence_id,
          );
          expect(Date.parse(c.at)).toBeGreaterThan(f.plannedAt.getTime());
          const fullBusinessState = async () => {
            const [row] = await fixture.db`
            select to_jsonb(r) as reminder,to_jsonb(p) as plan,to_jsonb(a) as automation,c.snapshot
            from allrice_brand_content_reminders r
            join allrice_brand_content_plans p on p.id=r.plan_id
            join allrice_automations a on a.id=r.automation_id
            join allrice_native_once_controls c on c.automation_id=a.id
            where a.id=${f.registered.automationId}`;
            return row;
          };
          const beforeGuard = await fullBusinessState();
          expect((await listOnceTasks(a.context, a.session.id)).tasks).toEqual(
            [],
          );
          expect(
            (
              await listOnceTasks(a.context, a.session.id, {
                clientRequestId: original.reminder_id,
              })
            ).tasks,
          ).toEqual([]);
          await expect(
            cancelOnceTask(a.context, a.session.id, f.registered.automationId),
          ).rejects.toMatchObject({ code: 'not_found' });
          expect(await fullBusinessState()).toEqual(beforeGuard);

          const countsBefore = await runJobCounts(),
            clock = await preparedClock(f);
          await waitUntilReminder(new Date(clock.control.at));
          await expect(
            runAutomationNow(a.context, a.workspace, f.registered.automationId),
          ).rejects.toMatchObject({ code: 'grant_invalid' });
          const [beforeReceipt] = await fixture.db`select
          (select count(*)::int from allrice_automation_runs where automation_id=${f.registered.automationId}) as occurrences,
          (select count(*)::int from allrice_messages where id=${original.reserved_message_id}) as messages`;
          expect(beforeReceipt).toEqual({ occurrences: 0, messages: 0 });
          const receiptWrite = await delivered(clock);
          const [native] = await fixture.db`
          select occurrence_id,outbox_state from allrice_native_once_occurrences
          where automation_id=${f.registered.automationId}`;
          expect(native).toEqual({
            occurrence_id: c.dispatch.occurrenceId,
            outbox_state: 'pending',
          });
          const dispatched = await Promise.all([
            dispatchNextNativeOnceOccurrence(randomUUID()),
            dispatchNextNativeOnceOccurrence(randomUUID()),
          ]);
          expect(dispatched.filter(Boolean)).toHaveLength(1);
          // Re-entry and exact historical ACK readback retain the original write.
          expect(await store.commitMutation(writer, receiptWrite)).toBe(
            'committed',
          );
          expect(await store.readExactCommit(writer, receiptWrite)).toBe(
            'committed',
          );
          expect(await dispatchNextNativeOnceOccurrence(randomUUID())).toBe(
            false,
          );
          const [result] = await fixture.db`
          select r.state,r.automation_run_id,r.delivery_message_id,o.outbox_state,m.visibility,
            ar.run_id,ar.session_id,ar.scheduled_for,ar.native_once_occurrence_id,
            (select count(*)::int from allrice_messages where id=r.reserved_message_id) as messages,
            (select count(*)::int from allrice_automation_runs where automation_id=r.automation_id) as occurrences,
            (select count(*)::int from allrice_brand_content_receipts where plan_id=r.plan_id) as publication_receipts,
            (select count(*)::int from allrice_native_once_journal where write_id=${receiptWrite.writeId}) as exact_receipt_writes
          from allrice_brand_content_reminders r
          join allrice_automation_runs ar on ar.id=r.reserved_occurrence_id
          join allrice_native_once_occurrences o on o.occurrence_id=ar.native_once_occurrence_id
          join allrice_messages m on m.id=r.reserved_message_id
          where r.automation_id=${f.registered.automationId}`;
          expect(result).toEqual({
            state: 'reminded',
            automation_run_id: original.reserved_occurrence_id,
            delivery_message_id: original.reserved_message_id,
            outbox_state: 'enqueued',
            visibility: 'private',
            run_id: null,
            session_id: a.session.id,
            scheduled_for: f.plannedAt,
            native_once_occurrence_id: c.dispatch.occurrenceId,
            messages: 1,
            occurrences: 1,
            publication_receipts: 0,
            exact_receipt_writes: 1,
          });
          expect(await identity(f.registered.automationId)).toEqual(original);
          expect(await runJobCounts()).toEqual(countsBefore);
          const history = await getChatSessionHistory(
            a.context,
            a.workspace,
            a.session.id,
          );
          const message = history.messages.find(
            (row) => row.id === original.reserved_message_id,
          );
          expect(message).toMatchObject({
            role: 'assistant',
            status: 'completed',
            runId: null,
            sessionId: a.session.id,
            ownerId: a.user,
          });
          expect(message!.content.text).toContain('发布提醒');
          expect(message!.content.text).toContain(
            `/api/v1/files/${f.document.object.id}/download`,
          );
          expect(message!.content.text).toContain('不表示已对外发布');
        }, 35_000);

        it('persists the original failed occurrence for cloud loss before receipt and read-only membership before consumption', async () => {
          const cloudCase = await enrolled('native-cloud-revoked');
          const readOnlyCase = await enrolled('native-readonly-revoked');
          const cloudClock = await preparedClock(cloudCase),
            readOnlyClock = await preparedClock(readOnlyCase);
          const countsBefore = await runJobCounts();
          const setCloud = async (enabled: boolean) => {
            const work = await getWorkAutomation(
              a.context,
              a.workspace,
              fixture.db,
            );
            return updateWorkAutomation(
              a.context,
              a.workspace,
              {
                capability: 'cloud',
                enabled,
                expectedRevision: work.revision,
              },
              fixture.db,
            );
          };
          await setCloud(false);
          try {
            await delivered(cloudClock);
            const [receipt] =
              await fixture.db`select outbox_state from allrice_native_once_occurrences
            where automation_id=${cloudCase.registered.automationId}`;
            expect(receipt?.outbox_state).toBe('blocked');
            expect(await dispatchNextNativeOnceOccurrence(randomUUID())).toBe(
              true,
            );
          } finally {
            await setCloud(true);
          }
          // A pending receipt admitted while writable cannot retain permission
          // after actual membership changes, even with a stale browser context.
          await delivered(readOnlyClock);
          const [pending] =
            await fixture.db`select outbox_state from allrice_native_once_occurrences
          where automation_id=${readOnlyCase.registered.automationId}`;
          expect(pending?.outbox_state).toBe('pending');
          const memberships = await fixture.db<{ id: string; role: string }[]>`
          select id,role from allrice_memberships
          where organization_id=${a.org} and user_id=${a.user} and active
            and (workspace_id is null or workspace_id=${a.workspace}) order by id`;
          expect(memberships.length).toBeGreaterThan(0);
          await fixture.db`update allrice_memberships set role='viewer'
          where id in ${fixture.db(memberships.map((row) => row.id))}`;
          try {
            expect(await dispatchNextNativeOnceOccurrence(randomUUID())).toBe(
              true,
            );
          } finally {
            for (const row of memberships)
              await fixture.db`update allrice_memberships set role=${row.role} where id=${row.id}`;
          }
          for (const f of [cloudCase, readOnlyCase]) {
            const [result] = await fixture.db`
            select r.state,r.error_code,r.automation_run_id,r.delivery_message_id,
              a.status,a.next_run_at,p.reminder_status,ar.status as occurrence_status,
              ar.run_id,ar.scheduled_for,ar.native_once_occurrence_id,o.outbox_state,
              (select count(*)::int from allrice_messages where id=r.reserved_message_id) as messages,
              (select count(*)::int from allrice_automation_runs where automation_id=r.automation_id) as occurrences
            from allrice_brand_content_reminders r
            join allrice_brand_content_plans p on p.id=r.plan_id
            join allrice_automations a on a.id=r.automation_id
            join allrice_automation_runs ar on ar.id=r.reserved_occurrence_id
            join allrice_native_once_occurrences o on o.occurrence_id=ar.native_once_occurrence_id
            where r.automation_id=${f.registered.automationId}`;
            expect(result).toEqual({
              state: 'blocked',
              error_code: 'AUTHORITY_DENIED',
              automation_run_id: f.original.reserved_occurrence_id,
              delivery_message_id: null,
              status: 'paused',
              next_run_at: null,
              reminder_status: 'failed',
              occurrence_status: 'failed',
              run_id: null,
              scheduled_for: f.plannedAt,
              outbox_state: 'blocked',
              native_once_occurrence_id: (
                await control(f.registered.automationId)
              ).dispatch.occurrenceId,
              messages: 0,
              occurrences: 1,
            });
            expect(await identity(f.registered.automationId)).toEqual(
              f.original,
            );
          }
          expect(await dispatchNextNativeOnceOccurrence(randomUUID())).toBe(
            false,
          );
          expect(await runJobCounts()).toEqual(countsBefore);
        }, 40_000);

        it('records a receipt arriving after cancellation without a private message or business occurrence', async () => {
          const f = await enrolled('native-late-cancel-receipt'),
            clock = await preparedClock(f);
          const countsBefore = await runJobCounts();
          await mutateBrandContent(
            a.context,
            {
              ...a.scope,
              brandId: f.brand.brandId,
              operation: 'plan.cancel',
              planId: f.input.planId,
              expectedRevision: f.registered.revision,
              requestId: freshKey('native-cancel'),
              reason: 'Synthetic cancellation before receipt.',
            },
            { db: fixture.db },
          );
          expect(
            (await control(f.registered.automationId)).command,
          ).toMatchObject({
            kind: 'delete',
            status: 'pending',
          });
          const receiptWrite = await delivered(clock);
          expect(await store.readExactCommit(writer, receiptWrite)).toBe(
            'committed',
          );
          expect(await dispatchNextNativeOnceOccurrence(randomUUID())).toBe(
            false,
          );
          expect(await dispatchNextNativeOnceOccurrence(randomUUID())).toBe(
            false,
          );
          const [result] = await fixture.db`
          select r.state,r.delivery_message_id,a.status,a.next_run_at,p.state as plan_state,
            o.outbox_state,o.business_binding,
            (select count(*)::int from allrice_messages where id=r.reserved_message_id) as messages,
            (select count(*)::int from allrice_automation_runs where automation_id=r.automation_id) as occurrences
          from allrice_brand_content_reminders r
          join allrice_brand_content_plans p on p.id=r.plan_id
          join allrice_automations a on a.id=r.automation_id
          join allrice_native_once_occurrences o on o.automation_id=a.id
          where a.id=${f.registered.automationId}`;
          expect(result).toEqual({
            state: 'superseded',
            delivery_message_id: null,
            status: 'paused',
            next_run_at: null,
            plan_state: 'cancelled',
            outbox_state: 'blocked',
            business_binding: null,
            messages: 0,
            occurrences: 0,
          });
          const after = await identity(f.registered.automationId);
          expect(after.reminder_snapshot).toEqual(f.original.reminder_snapshot);
          expect(after.scheduled_for).toEqual(f.plannedAt);
          expect(after.business_revision).toBe(f.original.business_revision);
          expect(await runJobCounts()).toEqual(countsBefore);
        }, 35_000);

        it('requires a journaled not-future absence, reserves attempt2 once concurrently, and retains original business IDs/P and attempt1', async () => {
          const f = await enrolled('native-journaled-next-attempt');
          const first = await control(f.registered.automationId),
            countsBefore = await runJobCounts();
          await readySession(first);
          expect(await reconcileBrandNativeReminderAttempt()).toBe(false);
          const unproved: NativeOnceMutation = {
            kind: 'reject_command',
            controlId: first.controlId,
            commandId: first.command.id,
            reason: 'target_not_future',
          };
          const absentWrite = {
            writeId: randomUUID(),
            digest: nativeOnceDigest(unproved),
            mutation: unproved,
          };
          await expect(store.commitMutation(writer, absentWrite)).resolves.toBe(
            'rejected',
          );
          expect(await store.readExactCommit(writer, absentWrite)).toBe(
            'absent',
          );
          expect(await reconcileBrandNativeReminderAttempt()).toBe(false);
          expect((await control(f.registered.automationId)).revision).toBe(1);
          await waitUntilReminder(new Date(first.at));
          const [now] = await fixture.db<
            { now: Date }[]
          >`select clock_timestamp() now`;
          const rejected = await write({
            kind: 'reject_command',
            controlId: first.controlId,
            commandId: first.command.id,
            reason: 'target_not_future',
            absence: {
              controlSessionId: first.controlSessionId,
              catalogDigest: nativeOnceDigest([]),
              taskCount: 0,
              observedAt: now!.now.toISOString(),
            },
          });
          const retainedAttempt = async () => {
            const [row] = await fixture.db`
            select to_jsonb(c) as control,to_jsonb(j) as journal
            from allrice_native_once_controls c
            join allrice_native_once_journal j on j.partition_id=c.partition_id and j.control_id=c.control_id
            where c.control_id=${first.controlId} and j.write_id=${rejected.writeId}`;
            return row;
          };
          const originalAttempt = await retainedAttempt();
          expect(originalAttempt).toBeDefined();
          const reconciled = await Promise.all([
            reconcileBrandNativeReminderAttempt(),
            reconcileBrandNativeReminderAttempt(),
          ]);
          expect(reconciled.filter(Boolean)).toHaveLength(1);
          expect(await reconcileBrandNativeReminderAttempt()).toBe(false);
          const rows = await fixture.db<
            { revision: number | string; control_id: string }[]
          >`
          select revision,control_id from allrice_native_once_controls
          where automation_id=${f.registered.automationId} order by revision`;
          expect(rows.map((row) => Number(row.revision))).toEqual([1, 2]);
          expect(rows[0]!.control_id).toBe(first.controlId);
          const second = await control(f.registered.automationId);
          expect(second.controlId).not.toBe(first.controlId);
          expect(second.controlSessionId).not.toBe(first.controlSessionId);
          expect(second.dispatch.occurrenceId).not.toBe(
            first.dispatch.occurrenceId,
          );
          expect(second.revision).toBe(2);
          expect(second.dispatch).toMatchObject({
            businessRevision: f.original.business_revision,
            reminderId: f.original.reminder_id,
            businessOccurrenceId: f.original.reserved_occurrence_id,
            businessMessageId: f.original.reserved_message_id,
            plannedAt: f.plannedAt.toISOString(),
            businessSessionId: a.session.id,
          });
          expect(Date.parse(second.at)).toBeGreaterThan(Date.parse(first.at));
          const [target] = await fixture.db`
          select attempt,control_id,business_revision from allrice_brand_native_reminder_targets
          where reminder_id=${f.original.reminder_id}`;
          expect(target).toEqual({
            attempt: 2,
            control_id: second.controlId,
            business_revision: f.original.business_revision,
          });
          expect(await identity(f.registered.automationId)).toEqual(f.original);
          expect(await retainedAttempt()).toEqual(originalAttempt);
          await delivered(await preparedClock(f));
          expect(await dispatchNextNativeOnceOccurrence(randomUUID())).toBe(
            true,
          );
          expect(await dispatchNextNativeOnceOccurrence(randomUUID())).toBe(
            false,
          );
          const [result] = await fixture.db`
          select r.state,r.automation_run_id,r.delivery_message_id,ar.scheduled_for,
            ar.native_once_occurrence_id,ar.run_id,
            (select count(*)::int from allrice_automation_runs where automation_id=r.automation_id) as occurrences,
            (select count(*)::int from allrice_messages where id=r.reserved_message_id) as messages,
            (select count(*)::int from allrice_native_once_occurrences where control_id=${first.controlId}) as old_native_occurrences
          from allrice_brand_content_reminders r
          join allrice_automation_runs ar on ar.id=r.reserved_occurrence_id
          where r.automation_id=${f.registered.automationId}`;
          expect(result).toEqual({
            state: 'reminded',
            automation_run_id: f.original.reserved_occurrence_id,
            delivery_message_id: f.original.reserved_message_id,
            scheduled_for: f.plannedAt,
            native_once_occurrence_id: second.dispatch.occurrenceId,
            run_id: null,
            occurrences: 1,
            messages: 1,
            old_native_occurrences: 0,
          });
          expect(await identity(f.registered.automationId)).toEqual(f.original);
          expect(await retainedAttempt()).toEqual(originalAttempt);
          expect(await runJobCounts()).toEqual(countsBefore);
        }, 60_000);

        it('keeps an overdue legacy reminder unchanged without a native receipt and replays only its original registration', async () => {
          const workflow = await ensureReminderPackage();
          const f = await prepareReminderPlan(
            a,
            'retained-overdue-legacy',
            3_000,
          );
          const registered = await seedHistoricalLegacyReminder(a, f, workflow);
          const originalRows = async () => {
            const [row] = await fixture.db`
              select to_jsonb(r) as reminder,to_jsonb(p) as plan,to_jsonb(a) as automation,
                (select count(*)::int from allrice_native_once_controls where automation_id=a.id) as controls,
                (select count(*)::int from allrice_brand_native_reminder_targets where automation_id=a.id) as targets,
                (select count(*)::int from allrice_automation_runs where automation_id=a.id) as occurrences,
                (select count(*)::int from allrice_messages where id=r.reserved_message_id) as messages
              from allrice_brand_content_reminders r
              join allrice_brand_content_plans p on p.id=r.plan_id
              join allrice_automations a on a.id=r.automation_id
              where a.id=${registered.automationId}`;
            return row!;
          };
          const before = await originalRows(),
            countsBefore = await runJobCounts();
          expect(before).toMatchObject({
            automation: { clock_owner: 'legacy', status: 'enabled' },
            controls: 0,
            targets: 0,
            occurrences: 0,
            messages: 0,
          });
          await waitUntilReminder(f.plannedAt);
          // Even a genuine locked legacy gate cannot enter the retained native sink.
          await expect(
            fixture.db.begin(async (tx) => {
              const gate = await lockBrandContentReminder(
                tx,
                registered.automationId,
              );
              if (!gate) throw Error('historical_brand_gate_missing');
              return completeBrandContentReminder(tx, gate, {});
            }),
          ).rejects.toMatchObject({ code: 'invalid_state' });
          expect(await reconcileBrandNativeReminderAttempt()).toBe(false);
          expect(await dispatchNextNativeOnceOccurrence(randomUUID())).toBe(
            false,
          );
          await expect(
            runAutomationNow(a.context, a.workspace, registered.automationId),
          ).rejects.toMatchObject({ code: 'grant_invalid' });
          try {
            vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '0');
            const replay = await registerBrandContentReminder(
              a.context,
              f.input,
              {
                db: fixture.db,
                workflow: reminderPin(workflow),
              },
            );
            expect(replay).toMatchObject({
              automationId: registered.automationId,
              planId: registered.planId,
              revision: registered.revision,
              replayed: true,
              status: 'registered',
              messageId: null,
            });
          } finally {
            vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '1');
          }
          expect(await originalRows()).toEqual(before);
          expect(await runJobCounts()).toEqual(countsBefore);
        }, 15_000);

        it('leaves future historical reminders untouched for both cloud-denied and authorized owners while new registrations enroll natively', async () => {
          const deniedWorkflow = await prepareReminderPackage(
            b,
            await prepareReminderMethod(b),
          );
          const allowedWorkflow = await ensureReminderPackage();
          const deniedPlan = await prepareReminderPlan(
            b,
            'retained-denied-legacy',
            60_000,
          );
          const allowedPlan = await prepareReminderPlan(
            a,
            'retained-authorized-legacy',
            60_000,
          );
          const first = await seedHistoricalLegacyReminder(
            b,
            deniedPlan,
            deniedWorkflow,
          );
          const second = await seedHistoricalLegacyReminder(
            a,
            allowedPlan,
            allowedWorkflow,
          );
          const ids = [first.automationId, second.automationId];
          const legacyState = async () => fixture.db`
            select to_jsonb(r) as reminder,to_jsonb(p) as plan,to_jsonb(a) as automation,
              (select count(*)::int from allrice_native_once_controls where automation_id=a.id) as controls,
              (select count(*)::int from allrice_brand_native_reminder_targets where automation_id=a.id) as targets,
              (select count(*)::int from allrice_automation_runs where automation_id=a.id) as occurrences,
              (select count(*)::int from allrice_messages where id=r.reserved_message_id) as messages
            from allrice_brand_content_reminders r
            join allrice_brand_content_plans p on p.id=r.plan_id
            join allrice_automations a on a.id=r.automation_id
            where a.id in ${fixture.db(ids)} order by a.id`;
          const before = await legacyState(),
            countsBefore = await runJobCounts();
          let cloudRevoked = false;
          try {
            const work = await getWorkAutomation(
              b.context,
              b.workspace,
              fixture.db,
            );
            await updateWorkAutomation(
              b.context,
              b.workspace,
              {
                capability: 'cloud',
                enabled: false,
                expectedRevision: work.revision,
              },
              fixture.db,
            );
            cloudRevoked = true;
            await expect(
              registerBrandContentReminder(b.context, deniedPlan.input, {
                db: fixture.db,
                workflow: reminderPin(deniedWorkflow),
              }),
            ).rejects.toMatchObject({ code: 'authority_denied' });
            const reconciled = await Promise.all([
              reconcileBrandNativeReminderAttempt(),
              reconcileBrandNativeReminderAttempt(),
            ]);
            expect(reconciled).toEqual([false, false]);
            expect(await legacyState()).toEqual(before);

            const native = await enrolled(
              'independent-native-after-retirement',
              60_000,
            );
            expect(
              (await control(native.registered.automationId)).dispatch,
            ).toMatchObject({
              consumer: 'brand-reminder-v1',
              plannedAt: native.plannedAt.toISOString(),
            });
            expect(await legacyState()).toEqual(before);
            expect(await runJobCounts()).toEqual(countsBefore);
          } finally {
            if (cloudRevoked) {
              const work = await getWorkAutomation(
                b.context,
                b.workspace,
                fixture.db,
              );
              await updateWorkAutomation(
                b.context,
                b.workspace,
                {
                  capability: 'cloud',
                  enabled: true,
                  expectedRevision: work.revision,
                },
                fixture.db,
              );
            }
          }
        }, 20_000);
      },
    );
  },
);
