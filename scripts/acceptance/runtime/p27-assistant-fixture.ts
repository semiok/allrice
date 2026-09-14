/** P27-only synthetic tenant. No permissive admission or pre-seeded runtime ledger. */
import { randomUUID } from 'node:crypto';
import type { createAssistantFixtureDatabase } from '../../../packages/database/src/assistant-runtime.fixture.ts';
import {
  EmployeeExecutionSnapshotSchema,
  ExecutionContextSchema,
  type RequestContext,
} from '../../../packages/contracts/src/index.ts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from '../../../packages/database/src/employees/employee-config.ts';
import { PROVIDER, RUN_LIMITS } from './p27-assistant-preflight.ts';

export async function createP27AssistantFixture(
  db: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>['db'],
) {
  const org = randomUUID(),
    workspace = randomUUID(),
    user = randomUUID(),
    membership = randomUUID(),
    rootRunId = randomUUID(),
    jobId = randomUUID(),
    workerId = randomUUID(),
    leaseToken = randomUUID(),
    employee = randomUUID(),
    version = randomUUID(),
    assignment = randomUUID(),
    session = randomUUID(),
    policy = randomUUID(),
    userMessageId = randomUUID(),
    assistantMessageId = randomUUID();
  const tools = ['assistant.delegate', 'assistant.report'];
  const config = {
    version: 1 as const,
    mode: 'daily' as const,
    allowAssistants: true,
    maxConcurrent: 2,
    maxDepth: 1,
    maxChildren: 2,
  };
  const manifest = employeeManifest({
    key: 'p27-smoke',
    name: 'P27 smoke',
    description: 'Ephemeral synthetic assistant acceptance only',
    toolNames: tools,
    runtimePolicy: {
      harness: 'dsh',
      provider: PROVIDER.route,
      model: PROVIDER.model,
      reasoningEffort: PROVIDER.reasoningEffort,
      timeoutMs: RUN_LIMITS.timeoutMs,
      fallbackModels: [],
      credentialReference: PROVIDER.credentialReference,
      baseUrl: null,
    },
    securityPolicy: {
      dataScopes: ['workspace'],
      connectorIdentityModes: ['user'],
      approvalPolicy: 'confirm_side_effects',
      deniedCapabilities: ['secret:use'],
    },
  });
  if (manifest.schemaVersion !== 2) throw Error('p27_manifest_schema');
  const checksum = employeeManifestChecksum(manifest);
  const now = new Date().toISOString();
  const memberships = [
    {
      id: membership,
      userId: user,
      organizationId: org,
      workspaceId: workspace,
      role: 'admin' as const,
      active: true,
    },
  ];
  const grants = [
    {
      resourceType: 'job' as const,
      action: 'job:execute',
      workspaceId: workspace,
    },
  ];
  const snapshot = EmployeeExecutionSnapshotSchema.parse({
    schemaVersion: 2,
    employee: {
      id: employee,
      key: manifest.key,
      versionId: version,
      revision: 1,
      definitionChecksum: checksum,
      definition: manifest,
    },
    assignment: {
      id: assignment,
      userId: user,
      assignedBy: null,
      assignedAt: now,
    },
    runtimePolicy: manifest.runtimePolicy,
    capabilitySnapshot: {
      declaredCapabilities: manifest.capabilities,
      grantedCapabilities: manifest.capabilities.filter(
        (c) => !manifest.securityPolicy.deniedCapabilities.includes(c),
      ),
      bindings: manifest.capabilityBindings,
      skillBindings: [],
      agentSkills: [],
      workflows: [],
      knowledge: [],
      resolvedForActorId: user,
    },
    tenantContext: {
      organizationId: org,
      workspaceId: workspace,
      actorId: user,
      policySnapshotId: policy,
    },
    userProfile: { schemaVersion: 1, displayName: null, preferences: {} },
    createdAt: now,
  });
  const executionSpec = {
    kind: 'synthetic-p27-assistant-smoke',
    employeeVersionId: version,
    definitionChecksum: checksum,
    provider: PROVIDER,
    runLimits: RUN_LIMITS,
  };
  const context: RequestContext = {
    actor: { type: 'user', id: user },
    organizationId: org,
    workspaceId: workspace,
    requestId: randomUUID(),
    sessionId: randomUUID(),
    authenticatedAt: now,
    memberships,
  };
  const worker = { jobId, workerId, leaseToken, generation: 1 };
  const executionContext = ExecutionContextSchema.parse({
    executionId: randomUUID(),
    runId: rootRunId,
    jobId,
    worker: { type: 'worker', id: workerId },
    delegatedBy: context.actor,
    organizationId: org,
    workspaceId: workspace,
    startedAt: now,
    policySnapshot: {
      id: policy,
      organizationId: org,
      subjectId: user,
      version: 1,
      issuedAt: now,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      memberships,
      grants,
    },
  });
  await db.begin(async (tx) => {
    await tx`insert into allrice_users(id,email,display_name,password_hash) values(${user},${`${user}@example.test`},'P27 synthetic','not-login')`;
    await tx`insert into allrice_organizations(id,slug,name) values(${org},${`p27-${org}`},'P27 synthetic')`;
    await tx`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspace},${org},'synthetic','P27 synthetic')`;
    await tx`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${membership},${org},${workspace},${user},'admin')`;
    await tx`insert into allrice_policy_snapshots(id,organization_id,subject_id,version,payload,expires_at)
      values(${policy},${org},${user},1,${tx.json({ memberships, grants })},clock_timestamp()+interval '1 hour')`;
    await tx`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name) values(${employee},${org},${workspace},'p27-smoke','P27 synthetic')`;
    await tx`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
      values(${version},${org},${workspace},${employee},1,'P27 synthetic',${manifest.provider.model},${manifest.systemPrompt},${tx.json(manifest.capabilities)},${checksum},${tx.json(manifest)},${tx.json(manifest.provider)})`;
    await tx`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id,is_default)
      values(${assignment},${org},${workspace},${employee},${version},${user},false)`;
    await tx`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
      values(${session},${org},${workspace},${user},'P27 synthetic',${assignment},${version})`;
    await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
      values(${userMessageId},${org},${workspace},${session},${user},'user','{"text":"Synthetic P27 acceptance","citations":[]}'),
        (${assistantMessageId},${org},${workspace},${session},${user},'assistant','{"text":"","citations":[]}')`;
    await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,policy_snapshot_id,execution_spec,input)
      values(${rootRunId},${org},${workspace},${user},'running',${policy},${tx.json(executionSpec)},${tx.json({ assistantConfiguration: config })})`;
    await tx`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at)
      values(${jobId},${org},${workspace},${user},${rootRunId},'running',${randomUUID()},clock_timestamp()+interval '180 seconds','{"schemaVersion":1,"type":"allrice.employee.run","input":{}}',${workerId},${leaseToken},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '180 seconds')`;
    await tx`insert into allrice_conversation_runtimes(organization_id,workspace_id,session_id,owner_id,thread_generation,config_checksum,state,active_run_id,worker_id)
      values(${org},${workspace},${session},${user},${worker.generation},${checksum},'running',${rootRunId},${workerId})`;
    await tx`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,native_skills,execution_snapshot)
      values(${rootRunId},${org},${workspace},${user},${assignment},${version},${session},${userMessageId},${assistantMessageId},${tx.json(manifest.provider)},'{}','[]',${tx.json(JSON.parse(JSON.stringify(snapshot)))})`;
    await tx`insert into allrice_runtime_policy_controls(organization_id,workspace_id,version,controls)
      values(${org},${workspace},1,${tx.json({ version: 1, enabled: true, mode: 'execute', rules: tools.map((action) => ({ action, effect: 'allow' })) })})`;
  });
  return {
    org,
    workspace,
    user,
    rootRunId,
    worker,
    config,
    context,
    executionContext,
    assignment,
    version,
    session,
    userMessageId,
    assistantMessageId,
    manifest,
    checksum,
  };
}
