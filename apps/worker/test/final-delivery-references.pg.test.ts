import { prepareDeliveryAuthorityFixture } from './final-delivery-reference-authority.fixture.ts';
/** Synthetic immutable inputs; actual PG/production ACL/reader/runtime/queue.
 * No model, parser, Dev account, native SDK or reference-read receipt is run. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeLedgerTransaction } from '../../../packages/database/src/runtime-ledger/types.ts';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  ExecutionContextSchema,
  makeObjectKey,
  type RequestContext,
} from '@allrice/contracts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../../../packages/database/src/runtime.fixture.ts';
import { createFinalReferenceAuthorityFixture } from './final-delivery-reference-authority.fixture.ts';
import { closeDatabase } from '../../../packages/database/src/core/client.ts';
import { completeJob } from '../../../packages/database/src/execution/queue.ts';
import { readFinalDeliveryReferences } from '../../../packages/database/src/final-delivery-references.ts';
import { finalDeliveryFactsDigest } from '../../../packages/database/src/final-delivery-commit.ts';
import {
  createToolBrokerExportObject,
  registerToolBrokerExport,
} from '../../../packages/database/src/execution/tool-broker.ts';
import { readArtifact } from '../../../packages/database/src/artifact-review.ts';
import {
  captureReferenceSelections,
  readReferenceSelection,
} from '../../../packages/database/src/reference-runtime.ts';
import { createSession } from '../../../packages/database/src/identity.ts';
import { changeReference } from '../../../packages/database/src/reference-library.ts';

const out = process.env.MET184_FROZEN_REFERENCE_EVIDENCE;
const save = (name: string, data: unknown) => {
  if (out)
    writeFileSync(
      join(out, name + '.json'),
      JSON.stringify(data, null, 2) + '\n',
    );
};
const cases: unknown[] = [];
const record = (name: string, detail: unknown) => {
  cases.push({ name, detail });
  save('case-facts', cases);
};
let database: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
const db = () => database.db;
const storage = () => runtimeFixtureStorage(db());
const originalEnvironment = Object.fromEntries(
  ['DATABASE_URL', 'ALLRICE_ASSISTANTS_ENABLED'].map((key) => [
    key,
    process.env[key],
  ]),
);
const sha = (s: string) =>
  'sha256:' + createHash('sha256').update(s).digest('hex');
type Tx = RuntimeLedgerTransaction;
type SeedIdentity = Parameters<
  NonNullable<
    NonNullable<
      Parameters<typeof createFinalReferenceAuthorityFixture>[1]
    >['preparePrompt']
  >
>[1];
type Mode = 'review' | 'knowledge' | 'both' | 'ordinary' | 'none';
type Plan = {
  mode?: Mode;
  newer?: boolean;
  reviewFeedback?: boolean;
  foreign?: 'session' | 'owner' | 'tenant';
  bad?:
    | 'review-checksum'
    | 'review-kind'
    | 'review-actor'
    | 'review-session'
    | 'origin-checksum'
    | 'origin-shape'
    | 'origin-version'
    | 'origin-file'
    | 'origin-run'
    | 'copy-alias'
    | 'selection-checksum'
    | 'selection-digest'
    | 'selection-null'
    | 'selection-shape'
    | 'selection-duplicate'
    | 'copy-expiry';
};
async function seedInput(tx: Tx, x: SeedIdentity, plan: Plan) {
  const mode = plan.mode ?? 'knowledge';
  const currentUser = x.userId,
    currentSession = x.sessionId;
  let org = x.organizationId,
    workspace = x.workspaceId,
    user = x.userId,
    session = x.sessionId;
  if (plan.foreign === 'tenant') {
    org = randomUUID();
    workspace = randomUUID();
    await tx`insert into allrice_organizations(id,slug,name) values(${org},${'foreign-' + org},'Foreign fixture')`;
    await tx`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspace},${org},'test','Foreign workspace')`;
  }
  if (plan.foreign === 'owner' || plan.foreign === 'tenant') {
    user = randomUUID();
    await tx`insert into allrice_users(id,email,display_name,password_hash) values(${user},${user + '@example.test'},'Other fixture','not-login')`;
    await tx`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${org},${workspace},${user},'member')`;
  }
  let sourceVersion = x.employeeVersionId,
    sourceAssignment = x.employeeAssignmentId;
  if (plan.foreign === 'tenant') {
    const employee = randomUUID();
    sourceVersion = randomUUID();
    await tx`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name) values(${employee},${org},${workspace},'foreign','Foreign fixture')`;
    await tx`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
      select ${sourceVersion},${org},${workspace},${employee},1,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot from allrice_employee_versions where id=${x.employeeVersionId}`;
  }
  if (user !== x.userId) {
    sourceAssignment = randomUUID();
    const [employee] =
      await tx`select employee_id from allrice_employee_versions where id=${sourceVersion}`;
    await tx`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id)
      values(${sourceAssignment},${org},${workspace},${employee!.employee_id},${sourceVersion},${user})`;
  }
  if (plan.foreign) {
    session = randomUUID();
    await tx`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
      values(${session},${org},${workspace},${user},'Foreign source Session',${sourceAssignment},${sourceVersion})`;
  }
  const oldRun = randomUUID(),
    oldUm = randomUUID(),
    oldAm = randomUUID();
  await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,policy_snapshot_id,execution_spec,input)
    values(${oldRun},${org},${workspace},${user},'succeeded',${x.policyId},'{}','{}')`;
  await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
    values(${oldUm},${org},${workspace},${session},${user},'user','{"text":"old input","citations":[]}'),
      (${oldAm},${org},${workspace},${session},${user},'assistant','{"text":"old output","citations":[]}')`;
  // Cross-tenant input needs no original employee binding: it must fail its
  // Knowledge ACL first. Same-scope historical outputs have real ER lineage.
  if (org === x.organizationId) {
    await tx`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,
      user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,native_skills,execution_snapshot)
      values(${oldRun},${org},${workspace},${user},${sourceAssignment},${sourceVersion},${session},${oldUm},${oldAm},${tx.json(x.providerSnapshot as Parameters<RuntimeLedgerTransaction['json']>[0])},'{}','[]',${tx.json(JSON.parse(JSON.stringify(x.executionSnapshot)))})`;
  }
  const [policy] =
    await tx`select payload,issued_at,expires_at from allrice_policy_snapshots where id=${x.policyId}`;
  const context = ExecutionContextSchema.parse({
    executionId: randomUUID(),
    runId: oldRun,
    jobId: x.jobId,
    worker: { type: 'worker', id: x.workerId },
    delegatedBy: { type: 'user', id: user },
    organizationId: org,
    workspaceId: workspace,
    startedAt: new Date().toISOString(),
    policySnapshot: {
      id: x.policyId,
      organizationId: org,
      subjectId: user,
      version: 1,
      issuedAt: policy!.issued_at.toISOString(),
      expiresAt: policy!.expires_at.toISOString(),
      ...policy!.payload,
    },
  });
  const publish = async (text: string, parentObjectId?: string) => {
    const bytes = Buffer.from(text);
    const object = {
      ...createToolBrokerExportObject({
        context,
        mediaType: 'text/plain',
        sizeBytes: bytes.length,
        checksum: sha(text) as `sha256:${string}`,
      }),
      immutable: true,
    };
    await storage().put(object, new Blob([bytes]).stream());
    const version = await registerToolBrokerExport(
      {
        context,
        sessionId: session,
        fileName: 'same-name.txt',
        format: 'text',
        object,
        ...(parentObjectId ? { parentObjectId } : {}),
      },
      tx,
    );
    await tx`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,request_id,request_digest)
      values(${version.id},${org},${workspace},${user},${oldRun},${(mode === 'review' || mode === 'both') && plan.bad !== 'review-kind' ? 'plan' : 'document'},${tx.json({ kind: 'model_proposal', runId: oldRun, operationId: null, stepId: null })},${randomUUID()},${sha(text)})`;
    return readArtifact(
      tx,
      {
        actor: { type: 'user', id: user },
        organizationId: org,
        workspaceId: workspace,
      },
      session,
      version.id,
    );
  };
  const first = await publish('old v1 exact bytes');
  const newer = plan.newer
    ? await publish('new v2 different bytes', first.object.id)
    : null;
  const collision = plan.newer
    ? await publish('same name unrelated series')
    : null;
  const selected: string[] = [];
  let sourceId: string | null = null,
    revisionId: string | null = null,
    copyId: string | null = null;
  if (mode === 'knowledge' || mode === 'both' || mode === 'ordinary') {
    sourceId = randomUUID();
    revisionId = randomUUID();
    copyId = randomUUID();
    const ownership = { scope: 'company' as const, organizationId: org };
    const copied = {
      ...first.object,
      id: copyId,
      key: makeObjectKey({
        organizationId: org,
        workspaceId: workspace,
        ownerId: user,
        category: 'uploads',
        objectId: copyId,
      }),
    };
    await storage().put(
      copied,
      new Blob([Buffer.from('old v1 exact bytes')]).stream(),
    );
    await tx`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,visibility,state,immutable,retention_until)
      values(${copyId},${org},${workspace},${user},${copied.key},'uploads',${copied.mediaType},${copied.sizeBytes},${copied.checksum},'private','ready',true,
        ${plan.bad === 'copy-expiry' ? new Date(Date.now() + 60000) : null})`;
    await tx`insert into allrice_knowledge_sources(id,organization_id,workspace_id,slug,name,description,created_by,ownership)
      values(${sourceId},${org},${workspace},${'reference-' + sourceId},'same-name.txt','Fixed reference',${user},${tx.json(ownership)})`;
    const origin =
      plan.bad === 'origin-shape'
        ? {}
        : {
            fileName:
              plan.bad === 'origin-file'
                ? 'another-file.txt'
                : first.version.fileName,
            version:
              plan.bad === 'origin-version'
                ? first.version.version + 1
                : first.version.version,
            checksum:
              plan.bad === 'origin-checksum'
                ? sha('wrong')
                : first.object.checksum,
            sessionId: session,
            runId: plan.bad === 'origin-run' ? randomUUID() : oldRun,
          };
    await tx`insert into allrice_knowledge_revisions(id,organization_id,workspace_id,knowledge_source_id,revision,name,description,status,definition,checksum,created_by,published_at,
      file_object_id,file_name,request_id,request_input,source_artifact_version_id,source_target_key,artifact_snapshot)
      values(${revisionId},${org},${workspace},${sourceId},1,'same-name.txt','Fixed reference','published','{}',${sha('manifest v1')},${user},clock_timestamp(),
        ${plan.bad === 'copy-alias' ? first.object.id : copyId},'same-name.txt',${randomUUID()},'{}',${mode === 'ordinary' ? null : first.id},${mode === 'ordinary' ? null : 'company:' + org},${mode === 'ordinary' ? null : tx.json(origin)})`;
    await tx`insert into allrice_knowledge_processing(revision_id,state,indexed_at) values(${revisionId},'ready',clock_timestamp())`;
    selected.push(revisionId);
    if (plan.newer) {
      // A later normal revision must not replace the frozen v1 mapping.
      const rid = randomUUID(),
        oid = randomUUID();
      await tx`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,visibility,state,immutable)
        values(${oid},${org},${workspace},${user},${makeObjectKey({ organizationId: org, workspaceId: workspace, ownerId: user, category: 'uploads', objectId: oid })},'uploads','text/plain',2,${sha('v2')},'private','ready',true)`;
      await tx`insert into allrice_knowledge_revisions(id,organization_id,workspace_id,knowledge_source_id,revision,name,description,status,definition,checksum,created_by,published_at,file_object_id,file_name,request_id,request_input)
        values(${rid},${org},${workspace},${sourceId},2,'same-name.txt','Later reference','published','{}',${sha('manifest v2')},${user},clock_timestamp(),${oid},'same-name.txt',${randomUUID()},'{}')`;
      await tx`insert into allrice_knowledge_processing(revision_id,state) values(${rid},'ready')`;
    }
  }
  if (mode === 'review' || mode === 'both') {
    const actor = plan.bad === 'review-actor' ? randomUUID() : currentUser;
    if (actor !== currentUser)
      await tx`insert into allrice_users(id,email,display_name,password_hash) values(${actor},${actor + '@example.test'},'Wrong actor','not-login')`;
    let reviewSession = currentSession;
    if (plan.bad === 'review-session') {
      reviewSession = randomUUID();
      await tx`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id) values(${reviewSession},${x.organizationId},${x.workspaceId},${currentUser},'Wrong review Session',${x.employeeAssignmentId},${x.employeeVersionId})`;
    }
    const feedbackId = plan.reviewFeedback ? randomUUID() : null;
    if (feedbackId)
      await tx`insert into allrice_artifact_feedback(id,organization_id,workspace_id,actor_id,artifact_id,checksum,revision,comments,state,submitted_at)
      values(${feedbackId},${x.organizationId},${x.workspaceId},${currentUser},${first.id},${first.object.checksum},1,'[{"text":"Fixed feedback"}]','submitted',clock_timestamp())`;
    await tx`insert into allrice_review_continuations(response_id,organization_id,workspace_id,session_id,actor_id,artifact_id,checksum,kind,feedback_id,run_id)
      values(${randomUUID()},${x.organizationId},${x.workspaceId},${reviewSession},${actor},${first.id},${plan.bad === 'review-checksum' ? sha('wrong') : first.object.checksum},${feedbackId ? 'version_feedback' : 'plan_review'},${feedbackId},${x.rootRunId})`;
  }
  // Capture using the true source principal for a foreign tenant fixture so
  // the frozen pin itself is well-formed; the current reader must still deny it.
  const selectionIdentity = {
    actor: {
      type: 'user' as const,
      id: plan.foreign === 'tenant' ? user : currentUser,
    },
    organizationId: plan.foreign === 'tenant' ? org : x.organizationId,
    workspaceId: plan.foreign === 'tenant' ? workspace : x.workspaceId,
  };
  const selections = await captureReferenceSelections(
    selectionIdentity,
    selected,
    tx,
  );
  let prompt: Parameters<RuntimeLedgerTransaction['json']>[0] = {
    referenceSelections: JSON.parse(JSON.stringify(selections)),
    conversation: [
      { text: first.id + ' ' + first.object.id + ' same-name.txt' },
    ],
  };
  if (plan.bad === 'selection-null') prompt = { referenceSelections: null };
  if (plan.bad === 'selection-shape')
    prompt = { referenceSelections: { revisionId } };
  if (plan.bad === 'selection-checksum' && selections[0])
    prompt = {
      referenceSelections: [{ ...selections[0], checksum: sha('wrong') }],
    } as Parameters<RuntimeLedgerTransaction['json']>[0];
  if (plan.bad === 'selection-digest' && selections[0])
    prompt = {
      referenceSelections: [{ ...selections[0], digest: sha('wrong') }],
    } as Parameters<RuntimeLedgerTransaction['json']>[0];
  if (plan.bad === 'selection-duplicate')
    prompt = {
      referenceSelections: JSON.parse(
        JSON.stringify([...selections, ...selections]),
      ),
    };
  return {
    prompt,
    first,
    newer,
    collision,
    sourceId,
    revisionId,
    copyId,
    oldRun,
    sourceScope: { org, workspace, user, session },
  };
}

async function fixture(plan: Plan = {}) {
  let seeded!: Awaited<ReturnType<typeof seedInput>>;
  const f = await createFinalReferenceAuthorityFixture(db(), {
    memberRole: 'member',
    allowedTools: ['workspace.export.create', 'workspace.document.read'],
    preparePrompt: async (tx, x) => {
      seeded = await seedInput(tx, x, plan);
      return seeded.prompt;
    },
  });
  const { native, port } = await prepareDeliveryAuthorityFixture(f, {
    startTurn: true,
  });
  const read = () => port.readSnapshot();
  const proof = async () => ({
    nativeSessionId: native,
    publicMessageId: randomUUID(),
    durableSeq: 9,
    nativeBindingId: randomUUID(),
    nativeCandidateDigest: sha('checked original answer'),
    candidateDigest: sha('checked original answer'),
    factSetDigest: finalDeliveryFactsDigest(await read()),
    attempt: 1,
    generation: f.worker.generation,
  });
  const finish = async (p: Awaited<ReturnType<typeof proof>>) => {
    const origin = await port.readOrigin();
    if (!origin) throw Error('Missing synthetic turn origin');
    return port.createCommitGuard(p, origin);
  };
  const login = await createSession(f.user);
  await db()`insert into allrice_organization_people(organization_id,user_id,display_name,content_maintenance_level) values(${f.org},${f.user},'Synthetic publisher','company')`;
  const context: RequestContext = {
    ...f.context,
    sessionId: login.id,
    workspaceId: f.workspace,
    requestId: randomUUID(),
  };
  const withdraw = () =>
    changeReference(context, seeded.sourceId!, {
      workspaceId: f.workspace,
      expectedRevision: plan.newer ? 2 : 1,
      requestId: randomUUID(),
      action: 'archive',
    });
  const state = async () =>
    (
      await db()`select j.status,r.state,m.content->>'text' text from allrice_jobs j join allrice_runs r on r.id=j.run_id join allrice_employee_runs e on e.run_id=r.id join allrice_messages m on m.id=e.assistant_message_id where j.id=${f.worker.jobId}`
    )[0];
  return {
    ...f,
    ...seeded,
    read,
    proof,
    finish,
    withdraw,
    state,
    context,
  };
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
async function waitFor(check: () => Promise<boolean>, label: string) {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Barrier not observed: ' + label);
}

describe
  .skipIf(process.env.ALLRICE_RUN_DB_INTEGRATION !== '1')
  .sequential(
    'frozen reference production producer, actual isolated PG',
    () => {
      beforeAll(async () => {
        process.env.ALLRICE_ASSISTANTS_ENABLED = '1';
        database = await createRuntimeFixtureDatabase();
        const [location] =
          await db()`select current_database() database,current_schema() schema`;
        assert.equal(
          location!.database,
          new URL(process.env.ALLRICE_TEST_DATABASE_URL!).pathname.slice(1),
        );
        assert.match(location!.schema, /^p25_[a-f0-9]{32}$/);
        const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
        url.searchParams.set(
          'options',
          '-csearch_path=' + location!.schema + ',public',
        );
        process.env.DATABASE_URL = url.toString();
        save('fixture', {
          ...location,
          storageRoot: database.storageRoot,
          immutableFirstInsert: true,
          realAuthority: 'assertAssistantAuthority',
          realProducer: 'readFinalDeliveryReferences',
          syntheticNativePin: true,
          models: 0,
          clouds: 0,
        });
      });
      afterAll(async () => {
        try {
          if (database) {
            const [usage] =
              await db()`select (select count(*)::int from allrice_model_usage_ledger) models,(select count(*)::int from allrice_cloud_execution_attempts) clouds,(select count(*)::int from allrice_employee_runs where reference_reads is not null) referenceReads`;
            save('usage', usage);
            expect(usage).toEqual({ models: 0, clouds: 0, referencereads: 0 });
          }
        } finally {
          try {
            await closeDatabase();
          } finally {
            try {
              if (database) save('cleanup', await database.close());
            } finally {
              for (const [key, value] of Object.entries(originalEnvironment)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
              }
            }
          }
        }
      });

      it('review fixes historical exact v1 despite v2 and same-name independent series; old Run is not new output', async () => {
        const f = await fixture({ mode: 'review', newer: true });
        const facts = await f.read();
        expect(facts.explicitReferenceVersionIds).toEqual([f.first.id]);
        expect(facts.artifacts.map((a) => a.versionId)).toEqual([f.first.id]);
        expect(facts.ownedRunIds).toEqual([f.rootRunId]);
        expect(facts.artifacts[0]!.originRunId).toBe(f.oldRun);
        expect(facts.ownedRunIds).not.toContain(f.oldRun);
        const p = await f.proof(),
          guard = await f.finish(p);
        await completeJob({
          workerId: f.worker.workerId,
          jobId: f.worker.jobId,
          leaseToken: f.worker.leaseToken,
          result: { answer: 'checked original answer' },
          checkedDelivery: guard,
        });
        expect(await f.state()).toMatchObject({
          status: 'succeeded',
          state: 'succeeded',
          text: 'checked original answer',
        });
        record('review exact historical identity and commit', {
          currentRun: f.rootRunId,
          oldRun: f.oldRun,
          v1: f.first.id,
          v2: f.newer?.id,
          collision: f.collision?.id,
          facts,
        });
      });
      it('Knowledge fixed revision maps original v1, never copy or later Knowledge/source version', async () => {
        const f = await fixture({ mode: 'knowledge', newer: true });
        const facts = await f.read();
        expect(f.copyId).not.toBe(f.first.object.id);
        expect(facts.explicitReferenceVersionIds).toEqual([f.first.id]);
        expect(facts.artifacts.map((a) => a.objectId)).toEqual([
          f.first.object.id,
        ]);
        const p = await f.proof(),
          guard = await f.finish(p);
        await completeJob({
          workerId: f.worker.workerId,
          jobId: f.worker.jobId,
          leaseToken: f.worker.leaseToken,
          result: { answer: 'checked original answer' },
          checkedDelivery: guard,
        });
        expect(await f.state()).toMatchObject({
          status: 'succeeded',
          state: 'succeeded',
        });
        record('Knowledge fixed source', {
          revision: f.revisionId,
          originalObject: f.first.object.id,
          copy: f.copyId,
          v1: f.first.id,
          v2: f.newer?.id,
          facts,
        });
      });
      it('submitted version feedback preserves its exact artifact after a newer version', async () => {
        const f = await fixture({
          mode: 'review',
          newer: true,
          reviewFeedback: true,
        });
        expect((await f.read()).explicitReferenceVersionIds).toEqual([
          f.first.id,
        ]);
      });
      it('review plus Knowledge deduplicates only the same exact identity', async () => {
        const f = await fixture({ mode: 'both' });
        expect((await f.read()).explicitReferenceVersionIds).toEqual([
          f.first.id,
        ]);
      });
      it('no frozen source never scans old Session files or model text IDs/names', async () => {
        const f = await fixture({ mode: 'none', newer: true });
        const facts = await f.read();
        expect(facts.explicitReferenceVersionIds).toEqual([]);
        expect(facts.artifacts).toEqual([]);
      });
      it('ordinary ready uploaded Knowledge input is authorized but not a delivered artifact', async () => {
        const f = await fixture({ mode: 'ordinary' });
        expect((await f.read()).artifacts).toEqual([]);
      });
      for (const foreign of ['session', 'owner'] as const)
        it(
          'readable company copy never upgrades original ' +
            foreign +
            ' access',
          async () => {
            const f = await fixture({ mode: 'knowledge', foreign });
            const copy = await db().begin((tx) =>
              readReferenceSelection(f.context, f.revisionId!, tx, true),
            );
            expect(copy.objectId).toBe(f.copyId);
            expect((await f.read()).artifacts).toEqual([]);
            record('independent readable copy ' + foreign, {
              currentOwner: f.user,
              currentSession: f.session,
              sourceScope: f.sourceScope,
              copy: copy.objectId,
              explicit: [],
            });
          },
        );
      it('well-formed foreign tenant pin cannot borrow its uploader or organization authority', async () => {
        const f = await fixture({ mode: 'knowledge', foreign: 'tenant' });
        await expect(f.read()).rejects.toThrow();
      });
      for (const bad of [
        'review-checksum',
        'review-kind',
        'review-actor',
        'review-session',
      ] as const)
        it('malformed immutable review rejects: ' + bad, async () => {
          const f = await fixture({ mode: 'review', bad });
          await expect(f.read()).rejects.toThrow();
        });
      for (const bad of [
        'origin-checksum',
        'origin-shape',
        'origin-version',
        'origin-file',
        'origin-run',
        'copy-alias',
        'selection-checksum',
        'selection-digest',
        'selection-null',
        'selection-shape',
        'selection-duplicate',
        'copy-expiry',
      ] as const)
        it(
          'malformed/unsupported frozen data rejects instead of empty references: ' +
            bad,
          async () => {
            const f = await fixture({ mode: 'knowledge', bad });
            await expect(f.read()).rejects.toThrow();
          },
        );
      it('a foreign input with malformed frozen version still rejects instead of silently becoming empty', async () => {
        const f = await fixture({
          mode: 'knowledge',
          foreign: 'session',
          bad: 'origin-version',
        });
        await expect(f.read()).rejects.toThrow(
          'final_delivery_evidence_unavailable',
        );
      });
      it('source archive between finalize and complete rolls back the whole final success', async () => {
        const f = await fixture();
        const p = await f.proof(),
          guard = await f.finish(p);
        await f.withdraw();
        await expect(
          completeJob({
            workerId: f.worker.workerId,
            jobId: f.worker.jobId,
            leaseToken: f.worker.leaseToken,
            result: { answer: 'checked original answer' },
            checkedDelivery: guard,
          }),
        ).rejects.toThrow();
        expect(await f.state()).toMatchObject({
          status: 'running',
          state: 'running',
          text: 'synthetic',
        });
        record('source withdrawal refuses final success', {
          revision: f.revisionId,
          state: await f.state(),
        });
      });
      it('original source Session revocation does not revoke the Knowledge copy or authorize the original', async () => {
        const f = await fixture();
        await db()`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${f.session}`;
        const copy = await db().begin((tx) =>
          readReferenceSelection(f.context, f.revisionId!, tx, true),
        );
        expect(copy.objectId).toBe(f.copyId);
        await expect(f.read()).rejects.toThrow();
        record('copy independent of original Session', {
          copy: copy.objectId,
          sourceSessionArchived: true,
        });
      });
      it('original object expiry is independent of the retained copy and refuses completion', async () => {
        const f = await fixture();
        const p = await f.proof(),
          guard = await f.finish(p);
        await db()`update allrice_storage_objects set retention_until=clock_timestamp()+interval '100 milliseconds' where id=${f.first.object.id}`;
        await new Promise((r) => setTimeout(r, 150));
        expect(
          (
            await db().begin((tx) =>
              readReferenceSelection(f.context, f.revisionId!, tx, true),
            )
          ).objectId,
        ).toBe(f.copyId);
        await expect(
          completeJob({
            workerId: f.worker.workerId,
            jobId: f.worker.jobId,
            leaseToken: f.worker.leaseToken,
            result: { answer: 'checked original answer' },
            checkedDelivery: guard,
          }),
        ).rejects.toThrow();
        expect(await f.state()).toMatchObject({
          status: 'running',
          state: 'running',
        });
        record('original expired, copy still readable', {
          original: f.first.object.id,
          copy: f.copyId,
          state: await f.state(),
        });
      });
      it('an unbound transaction cannot call the host producer without the actual root barrier', async () => {
        const f = await fixture();
        await expect(
          db().begin((transaction) =>
            readFinalDeliveryReferences({ transaction, task: f.task }),
          ),
        ).rejects.toThrow('final_delivery_evidence_unavailable');
      });
      it('a current producer waiting for a prior source writer sees the committed withdrawal', async () => {
        const f = await fixture();
        const held = deferred(),
          release = deferred();
        const writer = db().begin(async (tx) => {
          await tx`update allrice_knowledge_sources set status='archived' where id=${f.sourceId!}`;
          held.resolve();
          await release.promise;
        });
        await held.promise;
        const read = f.read();
        const rejected = expect(read).rejects.toThrow();
        try {
          await waitFor(async () => {
            const [r] =
              await db()`select exists(select 1 from pg_stat_activity where application_name=current_schema() and wait_event_type='Lock' and query like '%allrice_knowledge_sources%') waiting`;
            return r?.waiting === true;
          }, 'source lock wait');
        } finally {
          release.resolve();
        }
        await writer;
        await rejected;
        record('waited current source writer', {
          sourceId: f.sourceId,
          seesArchived: true,
        });
      });
      it('complete holds source authority to commit; actual later archive waits without reversing Job/root locks', async () => {
        const f = await fixture();
        const p = await f.proof(),
          guard = await f.finish(p);
        const held = deferred(),
          release = deferred();
        let blockerPid = 0,
          completionPid = 0;
        const blocker = db().begin(async (tx) => {
          blockerPid = Number((await tx`select pg_backend_pid() pid`)[0]!.pid);
          await tx`select id from allrice_messages where id=(select assistant_message_id from allrice_employee_runs where run_id=${f.rootRunId}) for update`;
          held.resolve();
          await release.promise;
        });
        await held.promise;
        const completed = completeJob({
          workerId: f.worker.workerId,
          jobId: f.worker.jobId,
          leaseToken: f.worker.leaseToken,
          result: { answer: 'checked original answer' },
          checkedDelivery: guard,
        });
        let withdrawal: ReturnType<typeof f.withdraw> | undefined;
        try {
          await waitFor(async () => {
            const [r] =
              await db()`select pid from pg_stat_activity where ${blockerPid}=any(pg_blocking_pids(pid)) and wait_event_type='Lock' and query like '%allrice_messages%' limit 1`;
            completionPid = Number(r?.pid ?? 0);
            return completionPid > 0;
          }, 'queue terminal message');
          withdrawal = f.withdraw();
          await waitFor(async () => {
            const [r] =
              await db()`select exists(select 1 from pg_stat_activity where ${completionPid}=any(pg_blocking_pids(pid)) and wait_event_type='Lock' and query like '%allrice_knowledge_sources%') waiting`;
            return r?.waiting === true;
          }, 'actual archive waits for producer SHARE');
        } finally {
          release.resolve();
        }
        await blocker;
        await completed;
        await withdrawal;
        expect(await f.state()).toMatchObject({
          status: 'succeeded',
          state: 'succeeded',
        });
        record('queue serialized before later source archive', {
          state: await f.state(),
          archiveAfterCommit: true,
        });
      });
      it('published frozen mapping and prompt pin remain immutable under the existing DB triggers', async () => {
        const f = await fixture({ mode: 'both' });
        await expect(
          db()`update allrice_knowledge_revisions set artifact_snapshot='{}' where id=${f.revisionId!}`,
        ).rejects.toThrow('Reference revision is immutable');
        await expect(
          db()`update allrice_employee_runs set prompt_snapshot='{}' where run_id=${f.rootRunId}`,
        ).rejects.toThrow('employee run execution snapshots are immutable');
        await expect(
          db()`delete from allrice_review_continuations where run_id=${f.rootRunId}`,
        ).rejects.toThrow('artifact version metadata is immutable');
      });
    },
  );
