import {
  UuidSchema,
  type RequestContext,
  type TenantValidationSummary,
  type TenantRunInspection,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  requireTenantManagementScope,
  type TenantManagementTarget,
} from './tenant-management-scope.ts';
import { getAdminTenantEnvironments } from './tenant-environments.ts';
import { getAdminTenantQuotas } from './tenant-quotas.ts';
import { inspectTenantRunArtifacts } from './artifact-review.ts';
import { listDshRuntimeEventTimeline } from './conversation/conversation-runtime.ts';
// Do not expose provider configuration, raw event payloads or encrypted inputs.
// Persisted output has already passed runtime redaction; mask common credential
// forms once more at this new display boundary, without decrypting any secret.
const diagnosticText = (text: string) =>
  text
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(
      /((?:password|api[-_]?key|secret|token|cookie|authorization)\s*[=:]\s*)(["']?)[^\s,;}]+/gi,
      '$1[REDACTED]',
    );

export async function getTenantValidationSummary(
  issuer: RequestContext,
  target: TenantManagementTarget,
  deviceInput: string | null,
  db = getDatabase(),
): Promise<TenantValidationSummary> {
  await requireTenantManagementScope(issuer, target, db);
  const deviceId = deviceInput === null ? null : UuidSchema.parse(deviceInput);
  const environments = await getAdminTenantEnvironments(issuer, target, db);
  if (deviceId && !environments.devices.some((d) => d.id === deviceId))
    throw new DataAccessError('not_found');
  let quotas: TenantValidationSummary['quotas'] = null;
  try {
    quotas = await getAdminTenantQuotas(issuer, target, db);
  } catch {
    /* Unknown is not zero or an admission promise. Recheck identity below. */
  }
  const { organizationId, workspaceId, subjectId } = target;
  const assignments = await db<
    {
      id: string;
      name: string;
      versionId: string;
      version: number;
      isDefault: boolean;
    }[]
  >`select a.id,e.name,v.id as "versionId",v.version,a.is_default as "isDefault" from allrice_employee_assignments a
    join allrice_employees e on e.id=a.employee_id and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id
    join allrice_employee_versions v on v.id=a.employee_version_id and v.organization_id=a.organization_id and v.workspace_id=a.workspace_id
    where a.organization_id=${organizationId} and a.workspace_id=${workspaceId} and a.user_id=${subjectId} and a.active and e.status='active' order by a.is_default desc,e.name,a.id limit 50`;
  const [policy] = await db<
    { version: number }[]
  >`select version from allrice_runtime_policy_controls where organization_id=${organizationId} and workspace_id=${workspaceId}`;
  const runs = await db<
    {
      id: string;
      session_id: string;
      title: string;
      state: string;
      created_at: Date;
      employee_version_id: string;
    }[]
  >`select r.id,e.session_id,s.title,r.state,r.created_at,e.employee_version_id from allrice_runs r
    join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id
    join allrice_chat_sessions s on s.id=e.session_id and s.organization_id=r.organization_id and s.workspace_id=r.workspace_id and s.owner_id=r.owner_id and s.archived_at is null
    where r.organization_id=${organizationId} and r.workspace_id=${workspaceId} and r.owner_id=${subjectId} order by r.created_at desc,r.id desc limit 51`;
  await requireTenantManagementScope(issuer, target, db);
  return {
    ...target,
    inspectorId: issuer.actor.id,
    deviceId,
    observedAt: new Date().toISOString(),
    policyVersion: policy?.version ?? null,
    assignments: [...assignments],
    environments,
    quotas,
    quotaError: quotas === null,
    runs: runs.slice(0, 50).map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      title: diagnosticText(r.title).slice(0, 250),
      status: r.state,
      createdAt: r.created_at.toISOString(),
      employeeVersionId: r.employee_version_id,
    })),
    runsTruncated: runs.length > 50,
  };
}

/** Read-only diagnostics. There is deliberately no start/approve/resume API
 * here: admin observation can never substitute for the actual member's Run. */
export async function inspectTenantRun(
  issuer: RequestContext,
  target: TenantManagementTarget,
  runInput: string,
  db = getDatabase(),
): Promise<TenantRunInspection> {
  const runId = UuidSchema.parse(runInput),
    { organizationId, workspaceId, subjectId } = target;
  await requireTenantManagementScope(issuer, target, db);
  const [row] = await db<
    {
      session_id: string;
      state: string;
      created_at: Date;
      employee_version_id: string;
    }[]
  >`select e.session_id,r.state,r.created_at,e.employee_version_id from allrice_employee_runs e
    join allrice_runs r on r.id=e.run_id and r.organization_id=e.organization_id and r.workspace_id=e.workspace_id and r.owner_id=e.owner_id
    join allrice_chat_sessions s on s.id=e.session_id and s.organization_id=e.organization_id and s.workspace_id=e.workspace_id and s.owner_id=e.owner_id and s.archived_at is null
    where e.run_id=${runId} and e.organization_id=${organizationId} and e.workspace_id=${workspaceId} and e.owner_id=${subjectId}`;
  if (!row) throw new DataAccessError('not_found');
  const timeline = await listDshRuntimeEventTimeline(row.session_id, {
      runId,
      database: db,
    }),
    turn = timeline.turns.find((t) => t.run.id === runId);
  const artifacts = await inspectTenantRunArtifacts(
    issuer,
    target,
    runId,
    null,
    db,
  );
  const operations = await db<
    {
      id: string;
      device_id: string | null;
      target_id: string;
      action: string;
      status: string;
      approval: string | null;
      expires_at: Date | null;
      output: string;
      output_length: number;
      output_chunks: number;
    }[]
  >`select o.id,o.device_id,o.target_id,
    left(o.snapshot->'binding'->>'action',160) as action,left(o.snapshot->>'status',80) as status,
    case when a.runtime_revoked_at is not null then 'revoked' when a.runtime_consumed_at is not null then 'consumed'
      when a.status='rejected' then 'rejected' when a.runtime_expires_at<=now() then 'expired' else a.status end as approval,
    a.runtime_expires_at as expires_at,coalesce(out.content,'') as output,coalesce(out.length,0)::int as output_length,coalesce(out.chunks,0)::int as output_chunks
    from allrice_runtime_operations o
    left join lateral(select x.status,x.runtime_revoked_at,x.runtime_consumed_at,x.runtime_expires_at from allrice_approval_requests x where x.resource_type='runtime_operation' and x.resource_id=o.id and x.organization_id=o.organization_id and x.workspace_id=o.workspace_id and x.actor_id=${subjectId} order by x.requested_at desc limit 1) a on true
    left join lateral(select left(string_agg(left(x.content,16000),E'\n' order by x.sequence),16000) as content,sum(length(x.content))+greatest(count(*)-1,0) as length,count(*) as chunks from (select content,sequence from allrice_runtime_operation_output where operation_id=o.id order by sequence limit 65) x) out on true
    where o.organization_id=${organizationId} and o.workspace_id=${workspaceId} and o.run_id=${runId}
      and o.snapshot->'binding'->'requestedBy'->>'id'=${subjectId} order by o.created_at,o.id limit 33`;
  await db.begin(async (tx) => {
    await requireTenantManagementScope(issuer, target, tx);
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
      values(${organizationId},${workspaceId},${issuer.actor.id},'tenant.run.inspected','run',${runId},'recorded','explicit_tenant_user_run_inspection',${tx.json({ subjectId, readOnly: true })})`;
  });
  return {
    ...target,
    inspectorId: issuer.actor.id,
    run: {
      id: runId,
      sessionId: row.session_id,
      status: row.state,
      employeeVersionId: row.employee_version_id,
      createdAt: row.created_at.toISOString(),
    },
    userText: turn?.userMessage.text
      ? diagnosticText(turn.userMessage.text)
      : null,
    answerText: turn?.assistantMessage.text
      ? diagnosticText(turn.assistantMessage.text)
      : null,
    usage: turn?.usage ?? null,
    events: (turn?.events ?? []).slice(-150).map((e) => ({
      key: e.key,
      title: diagnosticText(e.title),
      status: e.status,
      detail: e.detail ? diagnosticText(e.detail) : null,
    })),
    operations: operations.slice(0, 32).map((o) => ({
      id: o.id,
      deviceId: o.device_id,
      targetId: o.target_id,
      action: o.action,
      status: o.status,
      approval: o.approval,
      expiresAt: o.expires_at?.toISOString() ?? null,
      output: diagnosticText(o.output),
      outputTruncated: o.output_length > 16000 || o.output_chunks >= 65,
    })),
    operationsTruncated: operations.length > 32,
    artifacts: artifacts.artifacts,
    artifactsTruncated: artifacts.truncated,
  };
}
