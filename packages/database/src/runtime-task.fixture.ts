/** Generic isolated Run, session, storage and operation ledger; no retired executor. */
import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { RequestContext } from '@allrice/contracts';
import { createRuntimeOperationLedger } from './runtime-ledger/ledger.ts';
import { employeeManifest } from './employees/employee-config.ts';
import { runtimeFixtureStorage } from './runtime.fixture.ts';
export async function runtimeTaskFixture(
  db: ReturnType<typeof postgres>,
  capacity = 12,
  options: { nativeSessionId?: string; allowedTools?: string[] } = {},
) {
  const org = randomUUID(),
    workspace = randomUUID(),
    user = randomUUID(),
    runId = randomUUID(),
    jobId = randomUUID(),
    workerId = randomUUID(),
    leaseToken = randomUUID(),
    sessionId = randomUUID(),
    employeeId = randomUUID(),
    versionId = randomUUID(),
    assignmentId = randomUUID();
  await db`insert into allrice_users(id,email,display_name,password_hash) values(${user},${`${user}@example.test`},'P25 fixture','not-login')`;
  await db`insert into allrice_organizations(id,slug,name) values(${org},${`p25-${org}`},'P25 fixture')`;
  await db`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspace},${org},'test','P25 fixture')`;
  await db`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${randomUUID()},${org},${workspace},${user},'admin')`;
  const manifest = employeeManifest({
    key: 'p25-fixture',
    name: 'P25 Fixture',
    description: 'Synthetic fixture only',
    toolNames: ['workspace.document.read'],
  });
  await db`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name) values(${employeeId},${org},${workspace},'p25-fixture','P25 Fixture')`;
  await db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot) values(${versionId},${org},${workspace},${employeeId},1,'P25 Fixture',${manifest.provider.model},${manifest.systemPrompt},${db.json(manifest.capabilities)},${`sha256:${'a'.repeat(64)}`},${db.json(manifest)},${db.json(manifest.provider)})`;
  await db`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id) values(${assignmentId},${org},${workspace},${employeeId},${versionId},${user})`;
  await db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id) values(${sessionId},${org},${workspace},${user},'Synthetic runtime session',${assignmentId},${versionId})`;
  await db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input) values(${runId},${org},${workspace},${user},'running','{}','{}')`;
  await db`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at)
    values(${jobId},${org},${workspace},${user},${runId},'running',${randomUUID()},clock_timestamp()+interval '10 minutes','{"schemaVersion":1,"type":"allrice.employee.run","input":{}}',${workerId},${leaseToken},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '10 minutes')`;
  const task = {
    scope: { organizationId: org, workspaceId: workspace, projectId: null },
    runId,
    rootRunId: runId,
    parentRunId: null,
    chatSessionId: sessionId,
    frozenConfiguration: {
      employeeVersionId: null,
      digest: `sha256:${'a'.repeat(64)}`,
    },
  };
  const context: RequestContext = {
    actor: { type: 'user', id: user },
    organizationId: org,
    workspaceId: workspace,
    requestId: randomUUID(),
    sessionId: randomUUID(),
    authenticatedAt: new Date().toISOString(),
    memberships: [],
  };
  const worker = { jobId, workerId, leaseToken, generation: 1 };
  const ledger = createRuntimeOperationLedger({
    database: db,
    admission: async () => {},
  });
  await ledger.createRoot({
    task,
    deadlineAt: new Date(Date.now() + 600000).toISOString(),
    budgets: [
      {
        metric: 'model_calls',
        unit: 'calls',
        currency: null,
        capacity,
        source: { kind: 'worker', sourceId: 'runtime-fixture-v1' },
      },
      {
        metric: 'tool_calls',
        unit: 'calls',
        currency: null,
        capacity: 100,
        source: { kind: 'worker', sourceId: 'runtime-fixture-v1' },
      },
      {
        metric: 'input_tokens',
        unit: 'tokens',
        currency: null,
        capacity: 100000,
        source: { kind: 'worker', sourceId: 'runtime-fixture-v1' },
      },
      {
        metric: 'output_tokens',
        unit: 'tokens',
        currency: null,
        capacity: 100000,
        source: { kind: 'worker', sourceId: 'runtime-fixture-v1' },
      },
    ],
  });
  return {
    db,
    task,
    context,
    worker,
    ledger,
    nativeSessionId: options.nativeSessionId ?? randomUUID(),
    base: { scope: task.scope, rootRunId: runId, worker },
    async artifact(
      childRunId: string,
      body = 'Synthetic checked evidence',
      artifactOwnerId = user,
    ) {
      const artifactId = randomUUID(),
        objectId = randomUUID(),
        key = `organizations/${org}/workspaces/${workspace}/owners/${artifactOwnerId}/artifacts/${objectId}`;
      const bytes = Buffer.from(body),
        digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const object = {
        id: objectId,
        organizationId: org,
        workspaceId: workspace,
        ownerId: artifactOwnerId,
        key,
        checksum: digest,
        sizeBytes: bytes.length,
        mediaType: 'text/plain',
        retentionUntil: null,
        deletedAt: null,
        immutable: true,
      };
      const storage = runtimeFixtureStorage(db);
      if (!storage) throw Error('Isolated fixture storage required');
      await storage.put(object, new Blob([bytes]).stream());
      await db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,state,immutable) values(${objectId},${org},${workspace},${artifactOwnerId},${key},'artifacts','text/plain',${bytes.length},${digest},'ready',true)`;
      await db`insert into allrice_deliverable_versions(id,organization_id,workspace_id,owner_id,object_id,series_id,version,session_id,file_name,format) values(${artifactId},${org},${workspace},${artifactOwnerId},${objectId},${randomUUID()},1,${sessionId},'evidence.txt','text')`;
      await db`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,request_id,request_digest) values(${artifactId},${org},${workspace},${artifactOwnerId},${childRunId},'document',${db.json({ kind: 'tool_result', runId: childRunId, operationId: null, stepId: null })},${randomUUID()},${digest})`;
      return { artifactId, digest };
    },
  };
}
