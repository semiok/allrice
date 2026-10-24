import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Client from './core/client.ts';
import {
  createExperienceStore,
  createExperienceInTransaction,
  reviewExperienceInTransaction,
} from './experience.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import { approveSyntheticCurrentEmployeeExecution } from './current-execution.fixture.ts';
import {
  createChatSession,
  sendChatMessage,
  correctWorkspaceMemory,
  promoteWorkspaceMemory,
  searchWorkspaceMemories,
  deleteWorkspaceMemory,
} from './workspace/service.ts';
import { resolveEmployeeExecution } from './employees/employeehub.ts';
import { assembleEmployeeKernel } from '../../../apps/worker/src/employee-kernel.ts';
import {
  BrandContentWorkflowInvocationSchema,
  BrandFeedbackInputSchema,
  BrandExperiencePinSchema,
  brandRetrospectiveSource,
  makeObjectKey,
  type BrandContentWorkflowInvocation,
} from '@allrice/contracts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import { resolveEmployeeContentSource } from './employees/employee-content-sources.ts';
import { freezeEmployeeRuntimeContent } from './employees/employee-content.ts';
import {
  assertEmployeeBrandWorkflowContext,
  assertEmployeeContentContext,
  assertEmployeeContentReferenceMessages,
  prepareEmployeeContentContext,
} from './employees/employee-runtime-content.ts';
import { brandContentDigest } from './brand-content/rules.ts';
import { authenticateSession, createSession } from './identity.ts';
import { prepareStorageDelete, completeStorageDelete } from './data.ts';
import { getBrandContentBoard } from './brand-content/reads.ts';
import { mutateBrandContent } from './brand-content/service.ts';
import { brandContentStageInput } from './brand-content/workflow-start.ts';
import {
  assertBrandFeedbackInput,
  readBrandFeedback,
} from './brand-content/feedback.ts';
let admin: ReturnType<typeof postgres>, db: ReturnType<typeof postgres>;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => db,
}));
const schema = `p20_experience_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const store = createExperienceStore();
async function fixture() {
  return createExperienceFixture(db);
}
/** Synthetic saved report and completed assistant message. No model request or
 * claim of real publication metrics is made by this isolated SQL fixture. */
async function brandFixture(
  mismatch?: string,
  options: { mutableEvidence?: boolean } = {},
) {
  const f = await fixture();
  const [assignment] = await db<
    { id: string; employee_id: string; employee_version_id: string }[]
  >`select a.id,a.employee_id,a.employee_version_id from allrice_employee_assignments a
    join allrice_employee_runs er on er.employee_assignment_id=a.id where er.run_id=${f.run}`;
  const instanceId = randomUUID(),
    brandId = randomUUID(),
    contextId = randomUUID(),
    sessionId = randomUUID(),
    runId = randomUUID(),
    userMessageId = randomUUID(),
    messageId = randomUUID(),
    reportId = randomUUID(),
    feedbackId = randomUUID(),
    evidenceId = randomUUID();
  const content = {
    audience: 'Synthetic brand audience',
    tone: 'Factual',
    requirements: 'Do not infer causal uplift from a single sample.',
    visualBrief: '',
    facts: [{ id: 'f1', text: 'Synthetic brand context for a database test.' }],
    sourceFiles: [],
    strategies: [],
    campaign: {
      key: 'campaign-a',
      name: 'Campaign A',
      brief: 'Synthetic only',
    },
  };
  const invocation = BrandContentWorkflowInvocationSchema.parse({
    schemaVersion: 1,
    startId: randomUUID(),
    instanceId,
    sceneId: null,
    workflowRevisionId: randomUUID(),
    packageDigest: `sha256:${'a'.repeat(64)}`,
    templateKey: 'brand-content-operations.retrospective',
    input: {
      stage: 'retrospective',
      brandId,
      brandName: 'Synthetic brand',
      contextRevisionId: contextId,
      contextDigest: brandContentDigest({ name: 'Synthetic brand', content }),
      context: content,
      platform: 'synthetic-platform',
    },
  });
  const output = {
    summary: 'This isolated report is synthetic.',
    rule: 'Test the concrete opening in the next post.',
    applicability: 'Only Synthetic brand, Campaign A, synthetic-platform.',
    limitations: 'One synthetic sample; no causal or audience-wide claim.',
    feedbackIds: [feedbackId],
  };
  const feedback = BrandFeedbackInputSchema.parse({
    contextRevisionId: contextId,
    publicationKind: 'imported_publication',
    title: 'Synthetic feedback fixture — no live metrics',
    platform: invocation.input.platform,
    publishedUrl: `https://www.nasa.gov/synthetic-only/${feedbackId}`,
    publishedAt: '2026-01-01T00:00:00.000Z',
    sampledAt: '2026-01-02T00:00:00.000Z',
    sourceType: 'manual_report',
    sourceUrl: `https://www.nasa.gov/synthetic-only/${feedbackId}`,
    evidence: 'Deterministic SQL fixture; this URL is never fetched.',
    limitations: 'Synthetic fixture with unknown metrics.',
    metrics: {
      views: null,
      likes: null,
      comments: null,
      shares: null,
      saves: null,
    },
    evidenceFiles: [
      { objectId: evidenceId, checksum: `sha256:${'c'.repeat(64)}` },
    ],
  });
  const sourceText = brandRetrospectiveSource(output, reportId);
  const workflow = {
    workflowRevisionId: invocation.workflowRevisionId,
    packageDigest: invocation.packageDigest,
  };
  const frozen = structuredClone(invocation);
  if (mismatch === 'brand') frozen.input.brandId = randomUUID();
  if (mismatch === 'context') frozen.input.contextRevisionId = randomUUID();
  if (mismatch === 'platform') frozen.input.platform = 'another-platform';
  if (mismatch === 'campaign') frozen.input.context.campaign!.key = 'another';
  if (mismatch === 'package') frozen.packageDigest = `sha256:${'b'.repeat(64)}`;
  await db.begin(async (tx) => {
    await tx`insert into allrice_employee_instances
      (id,organization_id,workspace_id,owner_id,assignment_id,kind,creation_version_id,creation_request_id,creation_input)
      values(${instanceId},${f.org},${f.workspace},${f.user},${assignment!.id},'custom',${assignment!.employee_version_id},${randomUUID()},'{}')`;
    await tx`insert into allrice_brand_content_brands
      (id,organization_id,workspace_id,owner_id,instance_id,name,revision,current_context_id)
      values(${brandId},${f.org},${f.workspace},${f.user},${instanceId},'Synthetic brand',1,${contextId})`;
    await tx`insert into allrice_brand_content_contexts
      (id,organization_id,workspace_id,owner_id,instance_id,brand_id,number,brand_name,content,digest)
      values(${contextId},${f.org},${f.workspace},${f.user},${instanceId},${brandId},1,'Synthetic brand',${tx.json(content)},${invocation.input.contextDigest})`;
    await tx`insert into allrice_storage_objects
      (id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,visibility,state,immutable)
      values(${evidenceId},${f.org},${f.workspace},${f.user},${makeObjectKey({ organizationId: f.org, workspaceId: f.workspace, ownerId: f.user, category: 'uploads', objectId: evidenceId })},'uploads','text/plain',1,${feedback.evidenceFiles[0]!.checksum},'private','ready',${!options.mutableEvidence})`;
    await tx`insert into allrice_brand_content_feedback
      (id,organization_id,workspace_id,owner_id,instance_id,brand_id,context_id,content,digest,publication_key)
      values(${feedbackId},${f.org},${f.workspace},${f.user},${instanceId},${brandId},${contextId},${tx.json(feedback)},${brandContentDigest(feedback)},${feedbackId})`;
    await tx`insert into allrice_chat_sessions
      (id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id,employee_instance_id)
      values(${sessionId},${f.org},${f.workspace},${f.user},'Synthetic retrospective',${assignment!.id},${assignment!.employee_version_id},${instanceId})`;
    await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content,status)
      values(${userMessageId},${f.org},${f.workspace},${sessionId},${f.user},'user',${tx.json({ text: sourceText, citations: [] })},'completed'),
      (${messageId},${f.org},${f.workspace},${sessionId},${f.user},'assistant',${tx.json({ text: `Saved retrospective.\n${sourceText}`, citations: [] })},'completed')`;
    await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
      values(${runId},${f.org},${f.workspace},${f.user},'succeeded','{}','{}')`;
    await tx`insert into allrice_employee_runs
      (run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,status,completed_at,provider_snapshot,prompt_snapshot,execution_snapshot)
      values(${runId},${f.org},${f.workspace},${f.user},${assignment!.id},${assignment!.employee_version_id},${sessionId},${userMessageId},${messageId},'succeeded',now(),'{}','{}',
        ${tx.json({ instance: { id: mismatch === 'instance' ? randomUUID() : instanceId }, workflowInvocation: frozen })})`;
    await tx`insert into allrice_brand_content_retrospectives
      (id,organization_id,workspace_id,owner_id,instance_id,brand_id,context_id,platform,campaign_key,feedback_ids,output,source_text,run_id,session_id,workflow)
      values(${reportId},${f.org},${f.workspace},${f.user},${instanceId},${brandId},${contextId},${invocation.input.platform},${content.campaign.key},
        ${tx.array([feedbackId])}::uuid[],${tx.json(output)},${sourceText},${runId},${sessionId},${tx.json(workflow)})`;
  });
  return {
    ...f,
    instanceId,
    brandId,
    contextId,
    reportSessionId: sessionId,
    evidenceId,
    feedbackId,
    invocation,
    assignment: assignment!,
    reportId,
    userMessageId,
    employeeId: assignment!.employee_id,
    normalInput: f.input,
    input: {
      ...f.input,
      runId,
      messageId,
      sourceExcerpt: sourceText,
      content: sourceText,
    },
  };
}
async function brandRuntime(
  f: Awaited<ReturnType<typeof brandFixture>>,
  invocation: BrandContentWorkflowInvocation | null,
  options: {
    sessionId?: string;
    references?: { sessionId: string; messages: { id: string }[] }[];
  } = {},
) {
  const sessionId = options.sessionId ?? randomUUID(),
    runId = randomUUID(),
    userMessageId = randomUUID(),
    assistantMessageId = randomUUID();
  const content = await freezeEmployeeRuntimeContent(
    { actor: f.owner.actor, organizationId: f.org, workspaceId: f.workspace },
    {
      instanceId: f.instanceId,
      employeeId: f.employeeId,
      employeeVersionId: f.assignment.employee_version_id,
    },
    db,
  );
  await db.begin(async (tx) => {
    if (!options.sessionId)
      await tx`insert into allrice_chat_sessions
        (id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id,employee_instance_id)
        values(${sessionId},${f.org},${f.workspace},${f.user},'Synthetic workflow runtime',${f.assignment.id},${f.assignment.employee_version_id},${f.instanceId})`;
    await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content,status)
      values(${userMessageId},${f.org},${f.workspace},${sessionId},${f.user},'user','{"text":"Synthetic workflow prompt","citations":[]}','completed'),
      (${assistantMessageId},${f.org},${f.workspace},${sessionId},${f.user},'assistant','{"text":"Synthetic derived answer","citations":[]}','completed')`;
    await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
      values(${runId},${f.org},${f.workspace},${f.user},'succeeded','{}','{}')`;
    await tx`insert into allrice_employee_runs
      (run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,status,completed_at,provider_snapshot,prompt_snapshot,execution_snapshot)
      values(${runId},${f.org},${f.workspace},${f.user},${f.assignment.id},${f.assignment.employee_version_id},${sessionId},${userMessageId},${assistantMessageId},'succeeded',now(),'{}',
        ${tx.json({ userRequest: 'Synthetic workflow prompt', sessionReferences: options.references ?? [] })},
        ${tx.json({ instance: { id: f.instanceId }, content, ...(invocation ? { workflowInvocation: invocation } : {}) })})`;
  });
  return {
    scope: {
      organizationId: f.org,
      workspaceId: f.workspace,
      ownerId: f.user,
      sessionId,
      runId,
    },
    userMessageId,
    assistantMessageId,
  };
}

async function approvedBrandInvocation(
  f: Awaited<ReturnType<typeof brandFixture>>,
) {
  const candidate = await store.create(f.owner, f.input);
  const approved = await store.review(
    f.owner,
    candidate.id,
    decision(candidate),
  );
  const invocation = structuredClone(f.invocation);
  invocation.startId = randomUUID();
  invocation.templateKey = 'brand-content-operations.topics';
  invocation.input.stage = 'topics';
  invocation.input.experiences = [
    BrandExperiencePinSchema.parse({
      id: approved.id,
      revision: approved.revision,
      digest: approved.digest,
      content: approved.content,
      retrospectiveId: f.reportId,
      platform: invocation.input.platform,
      campaignKey: invocation.input.context.campaign!.key,
    }),
  ];
  return invocation;
}
async function brandBoardOwner(f: Awaited<ReturnType<typeof brandFixture>>) {
  const login = await createSession(f.user);
  const owner = await authenticateSession(login.token, {
    organizationId: f.org,
    workspaceId: f.workspace,
  });
  if (!owner) throw Error('Synthetic brand board login failed');
  return owner;
}
const decision = (
  c: { revision: number; digest: string },
  type = 'approve',
) => ({
  decision: type,
  expectedRevision: c.revision,
  expectedDigest: c.digest,
  reason: 'Synthetic exact rule reviewed',
});
suite(
  'P20 actual isolated PostgreSQL — no external model or personal data',
  () => {
    beforeAll(async () => {
      const value = process.env.ALLRICE_TEST_DATABASE_URL;
      if (!value) throw Error('Explicit dedicated test DB required');
      const url = new URL(value);
      if (!(
        (url.hostname === '127.0.0.1' &&
          url.port === '5432' &&
          url.pathname === '/allrice_b2' &&
          url.username === 'a123') ||
        (url.hostname === '127.0.0.1' &&
          url.port === '54329' &&
          url.pathname === '/allrice' &&
          url.username === 'allrice')
      ))
        throw Error('Dedicated B2/CI database only');
      approveSyntheticCurrentEmployeeExecution();
      admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
      const extensions = await admin<
        { extname: string }[]
      >`select extname from pg_extension where extname in ('vector','pg_trgm')`;
      expect(extensions.map((e) => e.extname).sort()).toEqual([
        'pg_trgm',
        'vector',
      ]);
      await admin.unsafe(`create schema ${schema}`);
      url.searchParams.set('options', `-csearch_path=${schema},public`);
      db = postgres(url.toString(), { max: 5, onnotice: () => {} });
      const directory = new URL('../migrations/', import.meta.url);
      for (const name of (await readdir(directory))
        .filter((n) => n.endsWith('.sql'))
        .sort())
        await db.unsafe(await readFile(new URL(name, directory), 'utf8'));
      vi.stubEnv('ALLRICE_EXPERIENCE_REVIEW_ENABLED', '1');
    }, 120000);
    afterAll(async () => {
      vi.unstubAllEnvs();
      await db?.end({ timeout: 5 });
      if (admin && /^p20_experience_[a-f0-9]{32}$/.test(schema))
        await admin.unsafe(`drop schema ${schema} cascade`);
      await admin?.end({ timeout: 5 });
    });
    it('lists only completed owned messages and persists a non-recalled private candidate with exact origin', async () => {
      const f = await fixture();
      expect(await store.sources(f.owner, f.session.id)).toHaveLength(2);
      expect(await store.sources(f.neighbor, f.session.id)).toEqual([]);
      const c = await store.create(f.owner, f.input);
      expect(c).toMatchObject({
        status: 'pending',
        revision: 1,
        scope: 'private',
        source: { runId: f.run, messageId: f.message },
        canReview: true,
      });
      expect(
        await searchWorkspaceMemories(f.owner, {
          workspaceId: f.workspace,
          query: 'Reconciliation rule',
        }),
      ).toEqual([]);
      expect(await store.list(f.reviewer)).toEqual([]);
      const [row] =
        await db`select visibility,lifecycle_state,source_id from allrice_memories where id=${c.id}`;
      expect(row).toEqual({
        visibility: 'private',
        lifecycle_state: 'candidate',
        source_id: null,
      });
    });
    it('deduplicates exact retries and rejects same id with changed content', async () => {
      const f = await fixture();
      const [a, b] = await Promise.all([
        store.create(f.owner, f.input),
        store.create(f.owner, f.input),
      ]);
      expect(a.id).toBe(b.id);
      await expect(
        store.create(f.owner, { ...f.input, content: 'Changed rule' }),
      ).rejects.toMatchObject({ code: 'conflict' });
    });
    it('hides unavailable feedback attachments and their derived content without blocking valid new inputs', async () => {
      const f = await brandFixture(undefined, { mutableEvidence: true });
      const owner = await brandBoardOwner(f);
      const candidate = await store.create(f.owner, f.input);
      const approved = await store.review(
        f.owner,
        candidate.id,
        decision(candidate),
      );
      const scope = {
        workspaceId: f.workspace,
        instanceId: f.instanceId,
        brandId: f.brandId,
      };
      const ownerScope = {
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        instanceId: f.instanceId,
      };
      const readBoard = () => getBrandContentBoard(owner, scope, { db });
      const [sample] =
        await db`select content from allrice_brand_content_feedback where id=${f.feedbackId}`;
      const valid = await mutateBrandContent(
        owner,
        {
          ...sample!.content,
          ...scope,
          operation: 'feedback.record',
          requestId: randomUUID(),
          sampledAt: '2026-01-03T00:00:00.000Z',
          evidenceFiles: [],
        },
        { db },
      );
      const entityId = randomUUID();
      await db`insert into allrice_brand_content_experience_uses
        (organization_id,workspace_id,owner_id,instance_id,brand_id,entity_id,memory_id,revision,digest,reason)
        values(${f.org},${f.workspace},${f.user},${f.instanceId},${f.brandId},${entityId},${approved.id},${approved.revision},${approved.digest},'Synthetic historical use with private source details.')`;
      const request = {
        workspaceId: f.workspace,
        brandId: f.brandId,
        requestId: randomUUID(),
        stage: 'topics' as const,
        platform: f.invocation.input.platform!,
        count: 2,
      };
      const before = await readBoard();
      expect(before.feedback).toHaveLength(2);
      expect(before.experiences).toHaveLength(1);
      expect(before.experienceUses).toHaveLength(1);
      const frozen = brandContentStageInput(before, request);
      expect(frozen.experiences?.[0]?.id).toBe(approved.id);
      await prepareStorageDelete(owner, f.evidenceId);
      await completeStorageDelete(owner, f.evidenceId);
      const after = await readBoard();
      expect(after.unavailableFeedbackSources).toBe(true);
      expect(after.feedback?.map((x) => x.id)).toEqual([valid.result.entityId]);
      expect(after.retrospectives).toEqual([]);
      expect(after.experiences).toEqual([]);
      expect(after.experienceUses).toEqual([]);
      expect(brandContentStageInput(after, request).experiences ?? []).toEqual(
        [],
      );
      expect(
        brandContentStageInput(after, {
          ...request,
          stage: 'retrospective',
          feedbackIds: [valid.result.entityId],
        }).feedback,
      ).toHaveLength(1);
      expect(() =>
        brandContentStageInput(after, {
          ...request,
          stage: 'retrospective',
          feedbackIds: [f.feedbackId],
        }),
      ).toThrow('source_unavailable');
      await expect(
        db.begin((tx) =>
          readBrandFeedback(tx, owner, ownerScope, f.brandId, f.feedbackId),
        ),
      ).rejects.toMatchObject({ code: 'source_unavailable' });
      await expect(
        db.begin((tx) =>
          assertBrandFeedbackInput(tx, owner, ownerScope, frozen),
        ),
      ).rejects.toMatchObject({ code: 'source_unavailable' });
      // The marker does not turn other integrity errors into partial success.
      await db`update allrice_storage_objects set state='ready',deleted_at=null,checksum=${`sha256:${'d'.repeat(64)}`} where id=${f.evidenceId}`;
      await expect(readBoard()).rejects.toMatchObject({
        code: 'source_changed',
      });
    });
    it('keeps archived-session history and normally withdrawn brand experience readable', async () => {
      const f = await brandFixture();
      const owner = await brandBoardOwner(f);
      const candidate = await store.create(f.owner, f.input);
      await store.review(f.owner, candidate.id, decision(candidate));
      const readBoard = () =>
        getBrandContentBoard(
          owner,
          {
            workspaceId: f.workspace,
            instanceId: f.instanceId,
            brandId: f.brandId,
          },
          { db },
        );
      await db`update allrice_chat_sessions set archived_at=now() where id=${f.reportSessionId}`;
      const archived = await readBoard();
      expect(archived.retrospectives?.[0]?.id).toBe(f.reportId);
      expect(archived.unavailableFeedbackSources).toBe(false);
      await deleteWorkspaceMemory(f.owner, f.workspace, candidate.id);
      const withdrawn = await readBoard();
      expect(withdrawn.experiences?.[0]).toMatchObject({
        id: candidate.id,
        status: 'approved',
        archived: true,
      });
      expect(withdrawn.unavailableFeedbackSources).toBe(false);
    });
    it('atomically composes the brand candidate and scope mapping with the caller transaction', async () => {
      const f = await brandFixture();
      let memoryId = '';
      await expect(
        db.begin(async (tx) => {
          const candidate = await createExperienceInTransaction(
            tx,
            f.owner,
            f.input,
          );
          memoryId = candidate.id;
          const [mapped] =
            await tx`select memory_id from allrice_brand_content_experiences where retrospective_id=${f.reportId}`;
          expect(mapped?.memory_id).toBe(memoryId);
          throw Error('Synthetic outer business receipt rollback');
        }),
      ).rejects.toThrow('Synthetic outer business receipt rollback');
      expect(
        await db`select id from allrice_memories where id=${memoryId}`,
      ).toEqual([]);
      expect(
        await db`select memory_id from allrice_experience_reviews where memory_id=${memoryId}`,
      ).toEqual([]);
      expect(
        await db`select memory_id from allrice_brand_content_experiences where retrospective_id=${f.reportId}`,
      ).toEqual([]);
      expect(
        await db`select id from allrice_audit_events where resource_id=${memoryId}`,
      ).toEqual([]);
      const candidate = await store.create(f.owner, f.input);
      expect(candidate).toMatchObject({ status: 'pending', canReview: true });
      await expect(
        db.begin(async (tx) => {
          await reviewExperienceInTransaction(
            tx,
            f.owner,
            candidate.id,
            decision(candidate),
          );
          throw Error('Synthetic review receipt rollback');
        }),
      ).rejects.toThrow('Synthetic review receipt rollback');
      expect((await store.list(f.owner, f.instanceId))[0]).toMatchObject({
        id: candidate.id,
        status: 'pending',
        revision: 1,
      });
      expect(
        await db`select id from allrice_rag_chunks where memory_id=${candidate.id}`,
      ).toEqual([]);
    });
    it('automatically scopes ordinary API proposals and keeps approved brand rules out of generic recall and content references', async () => {
      const f = await brandFixture();
      const candidate = await store.create(f.owner, f.input);
      expect(
        (await store.list(f.owner, f.instanceId)).map((row) => row.id),
      ).toContain(candidate.id);
      expect(await store.list(f.owner, randomUUID())).toEqual([]);
      expect(await store.list(f.neighbor, f.instanceId)).toEqual([]);
      const [review] =
        await db`select origin_kind,instance_id from allrice_experience_reviews where memory_id=${candidate.id}`;
      expect(review).toEqual({ origin_kind: 'manual', instance_id: null });
      const approved = await store.review(
        f.owner,
        candidate.id,
        decision(candidate),
      );
      expect(approved).toMatchObject({ status: 'approved', revision: 2 });
      await expect(
        correctWorkspaceMemory(f.owner, f.workspace, candidate.id, {
          content: 'Rewritten outside brand review',
          confidence: 1,
          expiresAt: null,
          reason: 'Synthetic bypass check',
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        promoteWorkspaceMemory(f.owner, f.workspace, candidate.id),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(
        await searchWorkspaceMemories(f.owner, {
          workspaceId: f.workspace,
          query: f.input.content,
        }),
      ).toEqual([]);
      const resolve = async (id: string, revision: number, content: string) => {
        const [r] = await db<
          { id: string }[]
        >`select id from allrice_memory_revisions where memory_id=${id} and revision=${revision}`;
        return resolveEmployeeContentSource({
          context: f.owner,
          employeeId: f.employeeId,
          ownership: {
            scope: 'personal',
            organizationId: f.org,
            ownerId: f.user,
          },
          ref: {
            sourceKind: 'experience',
            contentId: id,
            revisionId: r!.id,
            digest: runtimePolicyDigest({
              memoryId: id,
              revisionId: r!.id,
              revision,
              content,
            }),
          },
          sql: db,
          lock: false,
          allowDraft: false,
        });
      };
      expect(
        (await resolve(candidate.id, approved.revision, f.input.content)).dto
          .available,
      ).toBe(false);
      // The scope filter must not disable ordinary reviewed experiences.
      const ordinary = await store.create(f.owner, {
        ...f.normalInput,
        clientRequestId: randomUUID(),
      });
      const reviewed = await store.review(
        f.owner,
        ordinary.id,
        decision(ordinary),
      );
      expect(
        (await resolve(ordinary.id, reviewed.revision, f.normalInput.content))
          .dto.available,
      ).toBe(true);
    });
    it.each([
      'rewritten-rule',
      'partial-excerpt',
      'workspace',
      'class',
      'sharing',
      'user-message',
    ])(
      'refuses a normal experience API bypass of the exact brand report: %s',
      async (kind) => {
        const f = await brandFixture();
        const input = { ...f.input };
        if (kind === 'rewritten-rule')
          input.content = 'Do this for every brand.';
        if (kind === 'partial-excerpt')
          input.sourceExcerpt = 'Test the concrete opening in the next post.';
        if (kind === 'workspace') {
          input.scope = 'workspace';
          input.shareAcknowledged = true;
        }
        if (kind === 'class') input.memoryClass = 'user_preference';
        if (kind === 'sharing') input.shareAcknowledged = true;
        if (kind === 'user-message') input.messageId = f.userMessageId;
        await expect(store.create(f.owner, input)).rejects.toMatchObject({
          code: 'invalid_source',
        });
        expect(
          await db`select memory_id from allrice_brand_content_experiences where retrospective_id=${f.reportId}`,
        ).toEqual([]);
      },
    );
    it.each([
      'brand',
      'context',
      'platform',
      'campaign',
      'package',
      'instance',
    ])(
      'rejects a report that differs from its frozen Run %s scope',
      async (kind) => {
        const f = await brandFixture(kind);
        await expect(store.create(f.owner, f.input)).rejects.toMatchObject({
          code: 'invalid_source',
        });
      },
    );
    it('serializes distinct proposal keys and preserves the scope tombstone after withdrawal', async () => {
      const f = await brandFixture();
      const results = await Promise.allSettled([
        store.create(f.owner, f.input),
        store.create(f.owner, { ...f.input, clientRequestId: randomUUID() }),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.find((result) => result.status === 'rejected'),
      ).toMatchObject({ reason: { code: 'conflict' } });
      const [candidate] = await store.list(f.owner, f.instanceId);
      expect(candidate).toBeTruthy();
      await store.review(f.owner, candidate!.id, decision(candidate!));
      await deleteWorkspaceMemory(f.owner, f.workspace, candidate!.id);
      await expect(
        store.create(f.owner, { ...f.input, clientRequestId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(
        await db`select memory_id from allrice_brand_content_experiences where retrospective_id=${f.reportId}`,
      ).toEqual([{ memory_id: candidate!.id }]);
      expect((await store.list(f.owner, f.instanceId))[0]).toMatchObject({
        id: candidate!.id,
        archived: true,
        canReview: false,
      });
    });
    it('blocks replay, compaction and imported answers after a pinned brand experience is withdrawn', async () => {
      const f = await brandFixture();
      const invocation = await approvedBrandInvocation(f);
      const run = await brandRuntime(f, invocation);
      const first = await prepareEmployeeContentContext(run.scope);
      expect(first?.nativeContextKey).toBe(
        `${first!.generationId}-${run.scope.runId}`,
      );
      await assertEmployeeBrandWorkflowContext(run.scope);
      await assertEmployeeContentContext(run.scope, first!.generationId);
      await assertEmployeeContentReferenceMessages(
        {
          actor: f.owner.actor,
          organizationId: f.org,
          workspaceId: f.workspace,
        },
        run.scope.sessionId,
        [run.assistantMessageId],
      );
      await deleteWorkspaceMemory(
        f.owner,
        f.workspace,
        invocation.input.experiences![0]!.id,
      );
      // Recovery may reuse a previously completed load tool, but this gate runs
      // before every model step; native compaction uses the generation gate.
      await expect(
        assertEmployeeBrandWorkflowContext(run.scope),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      await expect(
        assertEmployeeContentContext(run.scope, first!.generationId),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      await expect(
        assertEmployeeContentReferenceMessages(
          {
            actor: f.owner.actor,
            organizationId: f.org,
            workspaceId: f.workspace,
          },
          run.scope.sessionId,
          [run.assistantMessageId],
        ),
      ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      const [old] =
        await db`select invalidated_at from allrice_employee_content_contexts where generation_id=${first!.generationId}`;
      expect(old?.invalidated_at).toBeInstanceOf(Date);
      const nextInvocation = structuredClone(invocation);
      nextInvocation.input.experiences = [];
      const next = await brandRuntime(f, nextInvocation, {
        sessionId: run.scope.sessionId,
      });
      const fresh = await prepareEmployeeContentContext(next.scope);
      expect(fresh!.generationId).not.toBe(first!.generationId);
      expect(fresh!.allowedMessageIds).toContain(next.userMessageId);
      expect(fresh!.allowedMessageIds).not.toContain(run.userMessageId);
      expect(fresh!.allowedMessageIds).not.toContain(run.assistantMessageId);
      await assertEmployeeContentContext(next.scope, fresh!.generationId);
    });
    it.each(['feedback-file', 'retrospective-session'])(
      'rechecks current brand evidence at dispatch after %s revocation',
      async (source) => {
        const f = await brandFixture();
        const invocation =
          source === 'retrospective-session'
            ? await approvedBrandInvocation(f)
            : structuredClone(f.invocation);
        if (source === 'feedback-file') {
          const [row] =
            await db`select content,digest,created_at from allrice_brand_content_feedback where id=${f.feedbackId}`;
          invocation.input.feedback = [
            {
              ...row!.content,
              id: f.feedbackId,
              digest: row!.digest,
              createdAt: row!.created_at.toISOString(),
            },
          ];
        }
        const run = await brandRuntime(f, invocation);
        const context = await prepareEmployeeContentContext(run.scope);
        await assertEmployeeBrandWorkflowContext(run.scope);
        if (source === 'feedback-file')
          await db`update allrice_storage_objects set retention_until=created_at+interval '1 millisecond' where id=${f.evidenceId}`;
        else
          await db`update allrice_chat_sessions set archived_at=now() where id=${f.reportSessionId}`;
        await expect(
          assertEmployeeBrandWorkflowContext(run.scope),
        ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
        await expect(
          assertEmployeeContentContext(run.scope, context!.generationId),
        ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      },
    );
    it.each(['brand', 'campaign', 'platform', 'context', 'ordinary'])(
      'retires valid brand context on %s changes without importing its prompt or answers',
      async (change) => {
        const f = await brandFixture();
        const initial = structuredClone(f.invocation);
        initial.templateKey = 'brand-content-operations.topics';
        initial.input.stage = 'topics';
        const first = await brandRuntime(f, initial);
        const before = await prepareEmployeeContentContext(first.scope);
        const nextInvocation = structuredClone(initial);
        if (change === 'platform')
          nextInvocation.input.platform = 'another-platform';
        if (['brand', 'campaign', 'context'].includes(change)) {
          const brandId = change === 'brand' ? randomUUID() : f.brandId;
          const contextId = randomUUID();
          const content = structuredClone(initial.input.context);
          if (change === 'campaign') content.campaign!.key = 'campaign-b';
          if (change === 'context')
            content.requirements = 'A newer factual context.';
          nextInvocation.input.brandId = brandId;
          nextInvocation.input.contextRevisionId = contextId;
          nextInvocation.input.context = content;
          nextInvocation.input.contextDigest = brandContentDigest({
            name: initial.input.brandName,
            content,
          });
          await db.begin(async (tx) => {
            if (change === 'brand')
              await tx`insert into allrice_brand_content_brands
                (id,organization_id,workspace_id,owner_id,instance_id,name,revision,current_context_id)
                values(${brandId},${f.org},${f.workspace},${f.user},${f.instanceId},${initial.input.brandName},1,${contextId})`;
            await tx`insert into allrice_brand_content_contexts
              (id,organization_id,workspace_id,owner_id,instance_id,brand_id,number,brand_name,content,digest)
              values(${contextId},${f.org},${f.workspace},${f.user},${f.instanceId},${brandId},${change === 'brand' ? 1 : 2},${initial.input.brandName},${tx.json(content)},${nextInvocation.input.contextDigest})`;
          });
        }
        const next = await brandRuntime(
          f,
          change === 'ordinary' ? null : nextInvocation,
          { sessionId: first.scope.sessionId },
        );
        const after = await prepareEmployeeContentContext(next.scope);
        expect(after!.generationId).not.toBe(before!.generationId);
        expect(after!.allowedMessageIds).toContain(next.userMessageId);
        expect(after!.allowedMessageIds).not.toContain(first.userMessageId);
        expect(after!.allowedMessageIds).not.toContain(
          first.assistantMessageId,
        );
        const [retired] =
          await db`select retired_at,invalidated_at from allrice_employee_content_contexts where generation_id=${before!.generationId}`;
        expect(retired).toMatchObject({
          retired_at: expect.any(Date),
          invalidated_at: null,
        });
        await assertEmployeeContentContext(next.scope, after!.generationId);
        // It remains valid evidence in its original scope, not a globally
        // revoked record merely because another task changed brand context.
        await assertEmployeeContentReferenceMessages(
          {
            actor: f.owner.actor,
            organizationId: f.org,
            workspaceId: f.workspace,
          },
          first.scope.sessionId,
          [first.assistantMessageId],
        );
        const imported = await brandRuntime(
          f,
          change === 'ordinary' ? null : nextInvocation,
          {
            references: [
              {
                sessionId: first.scope.sessionId,
                messages: [{ id: first.assistantMessageId }],
              },
            ],
          },
        );
        const importing = await prepareEmployeeContentContext(imported.scope);
        await expect(
          assertEmployeeContentContext(imported.scope, importing!.generationId),
        ).rejects.toMatchObject({ code: 'EMPLOYEE_CONTENT_UNAVAILABLE' });
      },
    );
    it('keeps historical ordinary runs without brand input on the existing content generation', async () => {
      const f = await brandFixture();
      const first = await brandRuntime(f, null);
      const before = await prepareEmployeeContentContext(first.scope);
      const second = await brandRuntime(f, null, {
        sessionId: first.scope.sessionId,
      });
      const after = await prepareEmployeeContentContext(second.scope);
      expect(after!.generationId).toBe(before!.generationId);
      expect(after!.nativeContextKey).toBe(before!.nativeContextKey);
      await assertEmployeeBrandWorkflowContext(second.scope);
      await assertEmployeeContentContext(second.scope, after!.generationId);
    });
    it.each(['wrong-message', 'running', 'changed-excerpt', 'archived'])(
      'rejects invalid source %s',
      async (kind) => {
        const f = await fixture();
        const input = { ...f.input };
        if (kind === 'wrong-message') input.messageId = randomUUID();
        if (kind === 'running')
          await db`update allrice_employee_runs set status='running' where run_id=${f.run}`;
        if (kind === 'changed-excerpt')
          input.sourceExcerpt = 'invented evidence';
        if (kind === 'archived')
          await db`update allrice_chat_sessions set archived_at=now() where id=${f.session.id}`;
        await expect(store.create(f.owner, input)).rejects.toMatchObject({
          code: 'invalid_source',
        });
      },
    );
    it('does not accept forged cached roles, cross-tenant or another owner approvals', async () => {
      const f = await fixture(),
        other = await fixture();
      const c = await store.create(f.owner, f.input);
      await expect(
        store.review(f.reviewer, c.id, decision(c)),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        store.review(other.owner, c.id, decision(c)),
      ).rejects.toMatchObject({ code: 'not_found' });
      await db`update allrice_memberships set active=false where user_id=${f.user}`;
      await expect(
        store.review(f.owner, c.id, decision(c)),
      ).rejects.toMatchObject({ code: 'identity_denied' });
    });
    it('shares only owner-approved rewritten text to a current platform administrator; ordinary reply cannot approve', async () => {
      const f = await fixture();
      const c = await store.create(f.owner, {
        ...f.input,
        scope: 'workspace',
        shareAcknowledged: true,
      });
      expect(await store.list(f.neighbor)).toEqual([]);
      const [review] = await store.list(f.reviewer);
      expect(review).toMatchObject({ source: null, canReview: true });
      expect(JSON.stringify(review)).not.toContain('SYNTHETIC-ONLY');
      await expect(
        store.review(f.owner, c.id, decision(c)),
      ).rejects.toMatchObject({ code: 'identity_denied' });
      await expect(
        store.review(f.reviewer, c.id, { message: 'yes' }),
      ).rejects.toThrow();
      const approved = await store.review(f.reviewer, c.id, decision(c));
      expect(approved).toMatchObject({ status: 'approved', revision: 2 });
      expect(
        (
          await searchWorkspaceMemories(f.neighbor, {
            workspaceId: f.workspace,
            query: 'Reconciliation rule',
          })
        ).map((m) => m.id),
      ).toContain(c.id);
    });
    it('guards legacy promote/correct endpoints instead of silently bypassing scope review', async () => {
      const f = await fixture();
      const c = await store.create(f.owner, {
        ...f.input,
        scope: 'workspace',
        shareAcknowledged: true,
      });
      await expect(
        promoteWorkspaceMemory(f.owner, f.workspace, c.id),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        correctWorkspaceMemory(f.owner, f.workspace, c.id, {
          content: 'bypass',
          reason: 'bypass',
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect((await store.list(f.owner))[0]?.status).toBe('pending');
    });
    it('allows one exact decision under concurrent approve/reject and keeps one new revision', async () => {
      const f = await fixture();
      const c = await store.create(f.owner, f.input);
      const results = await Promise.allSettled([
        store.review(f.owner, c.id, decision(c)),
        store.review(f.owner, c.id, decision(c, 'reject')),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const revisions =
        await db`select revision from allrice_memory_revisions where memory_id=${c.id} order by revision`;
      expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
    });
    it('refuses a stale digest or changed source and atomically leaves the candidate unapproved', async () => {
      const f = await fixture();
      const c = await store.create(f.owner, f.input);
      await expect(
        store.review(f.owner, c.id, {
          ...decision(c),
          expectedDigest: `sha256:${'0'.repeat(64)}`,
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      await db`update allrice_messages set content='{"text":"changed","citations":[]}' where id=${f.message}`;
      await expect(
        store.review(f.owner, c.id, decision(c)),
      ).rejects.toMatchObject({ code: 'source_changed' });
      expect((await store.list(f.owner))[0]).toMatchObject({
        status: 'pending',
        revision: 1,
      });
    });
    it('keeps a platform handoff private and inactive; even a tenant admin cannot publish it', async () => {
      const f = await fixture();
      const c = await store.create(f.owner, {
        ...f.input,
        scope: 'platform',
        shareAcknowledged: true,
      });
      expect(c.canReview).toBe(false);
      expect(await store.list(f.reviewer)).toEqual([]);
      await expect(
        store.review(f.owner, c.id, decision(c)),
      ).rejects.toMatchObject({ code: 'platform_publication_required' });
      const rejected = await store.review(f.owner, c.id, decision(c, 'reject'));
      expect(rejected.status).toBe('rejected');
      expect(
        await searchWorkspaceMemories(f.owner, {
          workspaceId: f.workspace,
          query: 'Reconciliation rule',
        }),
      ).toEqual([]);
    });
    it.each([
      'owner-revoked',
      'owner-inactive',
      'reviewer-demoted',
      'source-archived',
    ])('revalidates the current source and reviewer on %s', async (kind) => {
      const f = await fixture();
      const c = await store.create(f.owner, {
        ...f.input,
        scope: 'workspace',
        shareAcknowledged: true,
      });
      if (kind === 'owner-revoked')
        await db`update allrice_memberships set active=false where user_id=${f.user}`;
      if (kind === 'owner-inactive')
        await db`update allrice_users set status='disabled' where id=${f.user}`;
      if (kind === 'reviewer-demoted')
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      if (kind === 'source-archived')
        await db`update allrice_chat_sessions set archived_at=now() where id=${f.session.id}`;
      await expect(
        store.review(f.reviewer, c.id, decision(c)),
      ).rejects.toMatchObject({
        code: kind === 'reviewer-demoted' ? 'not_found' : 'invalid_source',
      });
      const [memory] =
        await db`select lifecycle_state,revision from allrice_memories where id=${c.id}`;
      expect(memory).toEqual({ lifecycle_state: 'candidate', revision: 1 });
    });
    it('allows explicit withdrawal after source edits while forbidding new trust', async () => {
      const f = await fixture(),
        c = await store.create(f.owner, f.input);
      await db`update allrice_messages set content='{"text":"edited origin","citations":[]}' where id=${f.message}`;
      await expect(
        store.review(f.owner, c.id, decision(c)),
      ).rejects.toMatchObject({ code: 'source_changed' });
      expect(
        await store.review(f.owner, c.id, decision(c, 'reject')),
      ).toMatchObject({ status: 'rejected', archived: true, revision: 2 });
    });
    it('keeps old Memory deletion effective and reports archived approved records honestly', async () => {
      const f = await fixture(),
        c = await store.create(f.owner, f.input);
      await store.review(f.owner, c.id, decision(c));
      await deleteWorkspaceMemory(f.owner, f.workspace, c.id);
      expect((await store.list(f.owner))[0]).toMatchObject({
        status: 'approved',
        archived: true,
        canReview: false,
      });
      expect(
        await searchWorkspaceMemories(f.owner, {
          workspaceId: f.workspace,
          query: f.input.content,
        }),
      ).toEqual([]);
    });
    it('prevents immutable source/scope mutation at the database boundary', async () => {
      const f = await fixture(),
        c = await store.create(f.owner, f.input);
      await expect(
        db`update allrice_experience_reviews set requested_scope='workspace',share_acknowledged=true where memory_id=${c.id}`,
      ).rejects.toThrow('immutable');
      await store.review(f.owner, c.id, decision(c));
      await expect(
        db`update allrice_experience_reviews set review_reason='rewrite approval' where memory_id=${c.id}`,
      ).rejects.toThrow('immutable');
    });
    it('a read-only viewer or disabled feature cannot write candidates', async () => {
      const f = await fixture();
      await db`update allrice_memberships set role='viewer' where user_id=${f.user}`;
      await expect(store.create(f.owner, f.input)).rejects.toMatchObject({
        code: 'identity_denied',
      });
      vi.stubEnv('ALLRICE_EXPERIENCE_REVIEW_ENABLED', '0');
      try {
        await expect(store.list(f.owner)).rejects.toMatchObject({
          code: 'disabled',
        });
      } finally {
        vi.stubEnv('ALLRICE_EXPERIENCE_REVIEW_ENABLED', '1');
      }
    });
    it('freezes the approved memory revision into a real next queued Run and actual Worker kernel, preserving earlier Run', async () => {
      const f = await fixture();
      const oldSession = await createChatSession(f.owner, {
        workspaceId: f.workspace,
        title: 'Before experience',
      });
      const before = await sendChatMessage(
        f.owner,
        f.workspace,
        oldSession.id,
        {
          clientMessageId: randomUUID(),
          text: 'Reconciliation rule: preserve original files and use decimal amounts.',
        },
      );
      const c = await store.create(f.owner, f.input);
      await store.review(f.owner, c.id, decision(c));
      const newSession = await createChatSession(f.owner, {
        workspaceId: f.workspace,
        title: 'After experience',
      });
      const after = await sendChatMessage(f.owner, f.workspace, newSession.id, {
        clientMessageId: randomUUID(),
        text: f.input.content,
      });
      const rows = await db<
        {
          run_id: string;
          prompt_snapshot: {
            memories: { id: string; revision?: number; content: string }[];
          };
          employee_assignment_id: string;
          employee_version_id: string;
          user_message_id: string;
          assistant_message_id: string;
        }[]
      >`select * from allrice_employee_runs where session_id in (${oldSession.id},${newSession.id}) order by created_at`;
      expect(before).toBeTruthy();
      expect(after).toBeTruthy();
      expect(rows).toHaveLength(2);
      expect(rows[0]!.prompt_snapshot.memories).toEqual([]);
      expect(rows[1]!.prompt_snapshot.memories).toEqual([
        expect.objectContaining({
          id: c.id,
          revision: 2,
          content: f.input.content,
        }),
      ]);
      const next = rows[1]!;
      const resolved = await resolveEmployeeExecution({
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        runId: next.run_id,
      });
      const kernel = assembleEmployeeKernel({
        resolved,
        sessionId: newSession.id,
        employeeAssignmentId: next.employee_assignment_id,
        employeeVersionId: next.employee_version_id,
        userMessageId: next.user_message_id,
        assistantMessageId: next.assistant_message_id,
      });
      expect(kernel.authorizedMemoryContext).toContain(`revision 2`);
      expect(kernel.authorizedMemoryContext).toContain(f.input.content);
      const [old] =
        await db`select prompt_snapshot from allrice_employee_runs where run_id=${rows[0]!.run_id}`;
      expect(old?.prompt_snapshot.memories).toEqual([]);
    });
  },
);
