import { UuidSchema } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { cloudStableId } from './cloud-execution.ts';
import { assertMaintenanceGrant } from './platform-maintenance-authority.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import { ensureQualityEmployee } from './platform-quality.ts';
import { createAssignedChatSession } from './workspace/service.ts';
import { prepareEmployeeRunBinding } from './employees/employeehub.ts';
import { resolveTaskRuntimePolicy } from './task-runtime-policy.ts';
import {
  RepairBindingSchema,
  repairFrozenValid,
} from './platform-repair-authority.ts';
import {
  CreateRepairTaskSchema,
  repairProductPath,
} from './platform-repair-contracts.ts';
import {
  loadRepositoryBaseline,
  repositoryDigest,
} from './platform-repository-source.ts';
import { enqueueMaintenanceRepairRun, QueueError } from './execution/queue.ts';

/** Persisted grant is the only authority. Shared defect attempts never borrow
 * another company's authorization; an already linked task is observed only. */
export async function startMaintenanceRepairGrant(grantId: string) {
  const db = getDatabase();
  const source = await db.begin(async (tx) => {
    const [lookup] =
      await tx`select issuer_id from allrice_platform_maintenance_grants where id=${UuidSchema.parse(grantId)}`;
    if (!lookup) throw new DataAccessError('not_found');
    const g = await assertMaintenanceGrant(tx, grantId, lookup.issuer_id);
    const [attempt] =
      await tx`select a.* from allrice_platform_maintenance_attempts a join allrice_platform_maintenance_grant_attempts l on l.attempt_id=a.id where l.grant_id=${grantId}`;
    if (!attempt) throw new DataAccessError('authorization_denied');
    return { owner: lookup.issuer_id as string, grant: g, attempt };
  });
  if (
    source.attempt.primary_grant_id !== grantId ||
    source.attempt.repair_task_id
  ) {
    return {
      attemptId: source.attempt.id as string,
      repairTaskId: source.attempt.repair_task_id as string | null,
      created: false,
    };
  }
  const f = source.grant.frozen;
  if (f.outputBudgetMode !== 'observed_threshold' || f.maxModelCalls !== 16)
    throw new DataAccessError('grant_invalid');
  const registered = loadRepositoryBaseline(
    process.env.ALLRICE_REPOSITORY_BASELINE_DIR,
    f.baseline.id,
  );
  const original = registered.archive.files.find(
    (x) => x.path === repairProductPath,
  );
  if (
    technicalDigest(registered.baseline) !== technicalDigest(f.baseline) ||
    !original ||
    f.verificationPlan.approvedFiles.length !== 1 ||
    f.verificationPlan.approvedFiles[0]?.path !== repairProductPath ||
    f.verificationPlan.approvedFiles[0].beforeChecksum !== original.checksum
  )
    throw new DataAccessError('grant_invalid');
  const requestId = cloudStableId(
    'maintenance-repair-request:' + source.attempt.id,
  );
  const taskId = cloudStableId('maintenance-repair:' + source.attempt.id);
  const employee = await db.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('allrice-central-maintenance-repair'))`;
    await assertMaintenanceGrant(tx, grantId, source.owner);
    const result = await ensureQualityEmployee(
      { actor: { type: 'user', id: source.owner } },
      tx,
    );
    await assertMaintenanceGrant(tx, grantId, source.owner);
    return result;
  });
  const c = employee.internal;
  const principal = {
    requestId,
    actor: { type: 'user' as const, id: source.owner },
    organizationId: c.organization_id,
    workspaceId: c.workspace_id,
    memberships: [
      {
        id: c.membership_id,
        organizationId: c.organization_id,
        workspaceId: c.workspace_id,
        userId: source.owner,
        active: true,
        role: c.role,
      },
    ],
  };
  const sessionId = cloudStableId(
    'maintenance-repair-session:' + source.attempt.id,
  );
  const userMessageId = cloudStableId(
    'maintenance-repair-user:' + source.attempt.id,
  );
  const assistantMessageId = cloudStableId(
    'maintenance-repair-assistant:' + source.attempt.id,
  );
  const text =
    '修复当前登记源码的命令输出凭据遮盖缺陷。按冻结清单修改产品源码，保留原断言；通过原断言和原生包编译后交付待审候选。不操作公司数据，不合并，不部署。';
  await db.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('allrice-central-maintenance-repair'))`;
    await assertMaintenanceGrant(tx, grantId, source.owner);
    await createAssignedChatSession(
      principal,
      {
        employeeAssignmentId: employee.assignmentId,
        title: '平台隔离仓库修复候选',
        workspaceId: c.workspace_id,
      },
      { sessionId },
      tx,
    );
    for (const [id, role, status, content] of [
      [userMessageId, 'user', 'completed', { text, citations: [] }],
      [assistantMessageId, 'assistant', 'pending', { text: '', citations: [] }],
    ] as const) {
      await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content,visibility,client_message_id,status) values(${id},${c.organization_id},${c.workspace_id},${sessionId},${source.owner},${role},${tx.json(content)},'private',${role === 'user' ? requestId : null},${status}) on conflict(id) do nothing`;
      const [m] = await tx`select * from allrice_messages where id=${id}`;
      if (
        !m ||
        m.owner_id !== source.owner ||
        m.session_id !== sessionId ||
        m.organization_id !== c.organization_id ||
        m.workspace_id !== c.workspace_id ||
        m.role !== role
      )
        throw new QueueError('conflict');
    }
    await assertMaintenanceGrant(tx, grantId, source.owner);
  });
  const binding = await prepareEmployeeRunBinding({
    context: principal,
    workspaceId: c.workspace_id,
    assignmentId: employee.assignmentId,
    employeeVersionId: employee.versionId,
    sessionId,
    userMessageId,
    assistantMessageId,
    promptSnapshot: {
      systemPrompt: '',
      conversation: [],
      memories: [],
      userRequest: text,
      imageAttachments: [],
      sessionReferences: [],
    },
  });
  if (binding.providerSnapshot.provider !== 'dsh')
    throw new DataAccessError('grant_invalid');
  binding.executionSnapshot.taskRuntimePolicy = resolveTaskRuntimePolicy([
    ...(binding.executionSnapshot.taskRuntimePolicy?.sources ?? []),
    {
      scope: 'maintenance_repair',
      scopeId: grantId,
      timeoutMs: f.repairTimeoutMs,
    },
  ]);
  binding.executionSnapshot.taskRuntimePolicy.authorizationExpiresAt =
    f.expiresAt;
  const snapshot = binding.executionSnapshot.modelSnapshot;
  if (!snapshot?.runLimits) throw new DataAccessError('grant_invalid');
  snapshot.runLimits = {
    ...snapshot.runLimits,
    maxOutputTokens: Math.min(
      snapshot.runLimits.maxOutputTokens,
      f.maxOutputTokens,
    ),
  };
  const request = CreateRepairTaskSchema.parse({
    requestId,
    baselineId: f.baseline.id,
    verificationMode: 'compiled_packages',
  });
  const fields = {
    ...request,
    version: 2 as const,
    baseline: f.baseline,
    baselineText: Buffer.from(original.contentBase64, 'base64').toString(
      'utf8',
    ),
    harnessChecksum: f.verificationPlan.harnessChecksum,
    releaseSha: f.baseline.sourceSha,
    assignmentId: employee.assignmentId,
    employeeVersionId: employee.versionId,
    employeeRevisionId: employee.revisionId,
    userMessageId,
    assistantMessageId,
    timeoutMs: binding.executionSnapshot.taskRuntimePolicy.timeoutMs,
    maintenance: {
      grantId,
      grantDigest: source.grant.row.frozen_digest as string,
      attemptId: source.attempt.id as string,
      verificationPlan: f.verificationPlan,
      verificationPlanDigest: f.verificationPlanDigest,
      maxCandidateRevisions: f.maxCandidateRevisions,
      maxOutputTokens: f.maxOutputTokens,
      outputBudgetMode: f.outputBudgetMode,
      maxModelCalls: f.maxModelCalls,
    },
  };
  if (repositoryDigest(fields.baselineText) !== original.checksum)
    throw new DataAccessError('grant_invalid');
  const repairBinding = RepairBindingSchema.parse({
    id: taskId,
    inputDigest: technicalDigest(request),
    frozen: { ...fields, fingerprint: technicalDigest(fields) },
  });
  if (!repairFrozenValid(repairBinding.frozen))
    throw new DataAccessError('grant_invalid');
  const result = await enqueueMaintenanceRepairRun(
    grantId,
    {
      type: 'allrice.employee.run',
      workspaceId: c.workspace_id,
      idempotencyKey: 'platform-repair:' + source.owner + ':' + requestId,
      maxAttempts: 1,
      timeoutMs: fields.timeoutMs,
      input: {
        employeeAssignmentId: employee.assignmentId,
        employeeVersionId: employee.versionId,
        sessionId,
        userMessageId,
        assistantMessageId,
        repairRequestId: requestId,
        repairInputDigest: repairBinding.inputDigest,
      },
    },
    {
      employeeBinding: binding,
      repairBinding,
      conversationDelivery: {
        sessionId,
        userMessageId,
        assistantMessageId,
        clientUserMessageId: requestId,
        message: text,
        requestedMode: 'follow_up',
        hasAttachments: false,
      },
    },
  );
  return {
    attemptId: source.attempt.id as string,
    repairTaskId: taskId,
    runId: result.run.id,
    created: result.created,
  };
}
