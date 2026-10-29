/** Isolated synthetic legacy rows, never a retired executor or stop receipt.
 * Real before APIs/Worker/Host histories are covered by p25 retirement delivery. */
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionContextSchema } from '@allrice/contracts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from './runtime.fixture.ts';
import { createRunAuthorityFixture } from './run-authority.fixture.ts';
import * as client from './core/client.ts';
import { registerToolBrokerExport } from './execution/tool-broker.ts';
import { getWorkbenchArtifact, readArtifactBytes } from './artifact-review.ts';
import {
  getChatSessionHistory,
  updateChatSession,
} from './workspace/service.ts';
import {
  applyNativeTestChatRetirement,
  previewNativeTestChatRetirement,
} from './conversation/native-context-retirement.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const legacyTables = [
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
].map((name) => `allrice_${name}`);
type Database = Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>['db'];
const fixtures: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const f of fixtures.splice(0)) await f.close();
});
const digest = (value: string | Buffer) =>
  'sha256:' + createHash('sha256').update(value).digest('hex');
const rows = (db: Database, table: string) =>
  db`select to_jsonb(r) value from ${db(table)} r order by to_jsonb(r)::text`;
async function legacySnapshot(db: Database) {
  return Promise.all(legacyTables.map((table) => rows(db, table)));
}

async function historical() {
  vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
  const fixture = await createRuntimeFixtureDatabase({
    throughMigration: '0228_repository_review_jobs.sql',
  });
  fixtures.push(fixture);
  const { db } = fixture;
  vi.spyOn(client, 'getDatabase').mockReturnValue(db);
  const f = await createRunAuthorityFixture(db, { configure: false }),
    child = randomUUID();
  await f.ledger.createRoot({
    task: f.task,
    deadlineAt: new Date(Date.now() + 600000).toISOString(),
    budgets: [
      {
        metric: 'model_calls',
        unit: 'calls',
        currency: null,
        capacity: 10,
        source: { kind: 'worker', sourceId: 'passive-history-fixture' },
      },
    ],
  });
  await db`update allrice_runs set state='failed',result='{"answer":"Original failed history"}',completed_at=clock_timestamp() where id=${f.rootRunId}`;
  await db`update allrice_employee_runs set status='failed',completed_at=clock_timestamp() where run_id=${f.rootRunId}`;
  await db`update allrice_jobs set status='failed',completed_at=clock_timestamp(),worker_id=null,lease_token=null,claimed_at=null,heartbeat_at=null,lease_expires_at=null where id=${f.worker.jobId}`;
  await db`update allrice_conversation_runtimes set state='idle',active_run_id=null,worker_id=null where session_id=${f.session}`;
  await db`insert into allrice_assistant_roots(root_run_id,configuration,worker_job_id,worker_id,worker_lease_digest,generation)
    values(${f.rootRunId},'{"allowAssistants":true}',${f.worker.jobId},${f.worker.workerId},${digest('old lease')},1)`;
  await db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
    values(${child},${f.org},${f.workspace},${f.user},'failed','{}','{}')`;
  await db`insert into allrice_runtime_run_links(run_id,root_run_id,parent_run_id,organization_id,workspace_id,task)
    values(${child},${f.rootRunId},${f.rootRunId},${f.org},${f.workspace},${db.json({ ...f.task, runId: child, parentRunId: f.rootRunId })})`;
  for (const runId of [f.rootRunId, child])
    await db`insert into allrice_assistant_instances(run_id,root_run_id,parent_run_id,native_session_id,delegation_id,creation_digest,label,depth,allowed_tools,artifact_namespace,status)
      values(${runId},${f.rootRunId},${runId === child ? f.rootRunId : null},${'legacy-' + runId},${randomUUID()},${digest('history')},'Passive legacy fixture',${runId === child ? 1 : 0},'[]',${'legacy/' + runId},${runId === child ? 'failed' : 'unknown'})`;
  await db`insert into allrice_assistant_messages(input_id,root_run_id,sender_run_id,recipient_run_id,content,content_digest,status)
    values(${randomUUID()},${f.rootRunId},${child},${f.rootRunId},'Original unknown delivery',${digest('message')},'unknown')`;
  await db`insert into allrice_assistant_results(delivery_id,run_id,root_run_id,payload,payload_digest)
    values(${randomUUID()},${child},${f.rootRunId},'{"status":"failed"}',${digest('failed result')})`;
  const callId = randomUUID();
  await db`insert into allrice_assistant_usage(call_id,run_id,root_run_id,metric,amount)
    values(${callId},${child},${f.rootRunId},'model_calls',1)`;
  await db`insert into allrice_assistant_model_admissions(call_id,run_id,root_run_id,requested_output_tokens,granted_output_tokens,input_tokens,request_digest,dispatched_at)
    values(${callId},${child},${f.rootRunId},1,1,1,${digest('request')},clock_timestamp())`;
  await db`insert into allrice_assistant_price_snapshots(root_run_id,snapshot_digest,snapshot,currency)
    values(${f.rootRunId},${digest('price')},'{"historical":"unchanged"}','USD')`;
  await db`insert into allrice_assistant_cost_receipts(call_id,root_run_id,run_id,snapshot_digest,request_digest,receipt_digest,usage,usage_complete,cache_usage_known,cost_basis)
    values(${callId},${f.rootRunId},${child},${digest('price')},${digest('request')},${digest('receipt')},'{}',false,false,'unknown')`;
  const bytes = Buffer.from('Original file with passive legacy provenance');
  const object = {
    id: randomUUID(),
    organizationId: f.org,
    workspaceId: f.workspace,
    ownerId: f.user,
    key: `organizations/${f.org}/workspaces/${f.workspace}/owners/${f.user}/exports/${randomUUID()}`,
    checksum: digest(bytes),
    sizeBytes: bytes.length,
    mediaType: 'text/plain',
    immutable: true,
    retentionUntil: null,
    deletedAt: null,
  };
  const storage = runtimeFixtureStorage(db);
  await storage.put(object, new Blob([bytes]).stream());
  const [policy] =
    await db`select * from allrice_policy_snapshots where id=${f.policy}`;
  const executionContext = ExecutionContextSchema.parse({
    executionId: randomUUID(),
    runId: f.rootRunId,
    jobId: f.worker.jobId,
    worker: { type: 'worker', id: f.worker.workerId },
    delegatedBy: f.context.actor,
    organizationId: f.org,
    workspaceId: f.workspace,
    startedAt: new Date().toISOString(),
    policySnapshot: {
      id: f.policy,
      organizationId: f.org,
      subjectId: f.user,
      version: 1,
      issuedAt: policy!.issued_at.toISOString(),
      expiresAt: policy!.expires_at.toISOString(),
      ...policy!.payload,
    },
  });
  await registerToolBrokerExport(
    {
      context: executionContext,
      sessionId: f.session,
      fileName: 'history.txt',
      format: 'text',
      object,
    },
    db,
  );
  const [version] =
    await db`select id from allrice_deliverable_versions where object_id=${object.id}`;
  const versionId = String(version!.id);
  await db`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,request_id,request_digest)
    values(${versionId},${f.org},${f.workspace},${f.user},${child},'document',${db.json({ kind: 'tool_result', runId: child, operationId: null, stepId: null })},${randomUUID()},${object.checksum})`;
  await db`insert into allrice_assistant_artifacts(run_id,relative_path,artifact_id,digest) values(${child},'history.txt',${versionId},${object.checksum})`;
  const target = randomUUID(),
    operation = randomUUID(),
    assignment = randomUUID(),
    merge = randomUUID(),
    review = randomUUID();
  await db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities,metadata)
    values(${target},${f.org},${f.workspace},'passive-legacy','rice_bridge','Passive history','online','[]','{}')`;
  await db`insert into allrice_runtime_operations(id,organization_id,workspace_id,run_id,root_run_id,target_id,attempt_id,attempt_number,generation,fence,idempotency_key,initial_snapshot,snapshot)
    values(${operation},${f.org},${f.workspace},${child},${f.rootRunId},${target},${randomUUID()},1,1,1,${randomUUID()},'{"status":"failed"}','{"status":"failed"}')`;
  await db`insert into allrice_development_heads(root_run_id,seed_artifact_id,seed_digest,head_artifact_id,head_digest,execution)
    values(${f.rootRunId},${versionId},${object.checksum},${versionId},${object.checksum},'{}')`;
  await db`insert into allrice_development_assignments(id,root_run_id,run_id,assigned_by_run_id,base_artifact_id,base_digest,execution,paths,request_digest)
    values(${assignment},${f.rootRunId},${child},${f.rootRunId},${versionId},${object.checksum},'{}','["history.txt"]',${digest('assignment')})`;
  await db`insert into allrice_development_proposals(artifact_id,root_run_id,assignment_id,digest)
    values(${versionId},${f.rootRunId},${assignment},${object.checksum})`;
  await db`insert into allrice_development_merges(request_id,root_run_id,request_digest,previous_artifact_id,result_artifact_id,result_digest,revision)
    values(${merge},${f.rootRunId},${digest('merge')},${versionId},${versionId},${object.checksum},1)`;
  await db`insert into allrice_development_merge_sources(request_id,artifact_id) values(${merge},${versionId})`;
  await db`insert into allrice_development_verifiers(id,root_run_id,run_id,artifact_id,digest,role)
    values(${randomUUID()},${f.rootRunId},${child},${versionId},${object.checksum},'review')`;
  await db`insert into allrice_development_reviews(id,root_run_id,reviewer_run_id,artifact_id,digest,operation_id,verdict,summary)
    values(${review},${f.rootRunId},${child},${versionId},${object.checksum},${operation},'revise','Original failed review')`;
  await db`insert into allrice_development_deliveries(artifact_id,root_run_id,candidate_id,digest,review_id)
    values(${versionId},${f.rootRunId},${versionId},${object.checksum},${review})`;
  return { ...f, child, object, versionId, bytes, storage, operation };
}

suite('executor-first retirement: passive legacy history', () => {
  it('existing history, archive/restore and native context retirement keep legacy FKs and bytes intact', async () => {
    const f = await historical(),
      { db } = f;
    const before = await legacySnapshot(db);
    expect(before.every((table) => table.length > 0)).toBe(true);
    const history = await getChatSessionHistory(
      f.context,
      f.workspace,
      f.session,
    );
    const artifact = await getWorkbenchArtifact(
      f.context,
      f.session,
      f.versionId,
    );
    await updateChatSession(f.context, f.workspace, f.session, {
      archived: true,
    });
    expect(
      (await getChatSessionHistory(f.context, f.workspace, f.session)).messages,
    ).toEqual(history.messages);
    await updateChatSession(f.context, f.workspace, f.session, {
      archived: false,
    });
    expect(await legacySnapshot(db)).toEqual(before);
    const plan = await previewNativeTestChatRetirement({
      requestId: randomUUID(),
      authorizationEvidenceDigest: digest('synthetic fixture'),
      scopes: [
        {
          contextKind: 'chat',
          contextId: f.session,
          organizationId: f.org,
          workspaceId: f.workspace,
          ownerId: f.user,
        },
      ],
    });
    await expect(applyNativeTestChatRetirement(plan)).resolves.toMatchObject({
      contexts: [f.session],
    });
    expect(await legacySnapshot(db)).toEqual(before);
    expect(
      await getWorkbenchArtifact(f.context, f.session, f.versionId),
    ).toEqual(artifact);
    expect(await readArtifactBytes(f.storage, artifact.object)).toEqual(
      f.bytes,
    );
    expect(
      (await getChatSessionHistory(f.context, f.workspace, f.session)).messages,
    ).toEqual(history.messages);
  }, 120000);
});
