import {
  ArtifactSourceFileSchema,
  EmployeeExecutionSnapshotSchema,
  ExecutionChoiceSchema,
  ExecutionLocationSchema,
  UuidSchema,
  resolveExecutionChoice,
  runtimeContractEqual,
  type ExecutionContext,
  type ExecutionChoice,
  type ExecutionLocation,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { executionRequestConstraints } from './browser-execution-choice.ts';
import { cloudStableId } from './cloud-execution.ts';
import { RuntimePolicyError, runtimePolicyDigest } from './runtime-policy.ts';
import { assertToolBrokerSourceFile } from './execution/tool-broker.ts';

export interface OfficePdfSelectionInput {
  context: ExecutionContext;
  callId: string;
  arguments: Record<string, unknown>;
  officePdf: { objectId: string; checksum: string };
  jobAttempt: number;
  jobLeaseToken: string;
  location?: ExecutionLocation;
}

/** DSH Office-to-PDF is currently a server provider. Admission never borrows
 * Python/Bridge authority and rejects local constraints before source IO. */
export async function selectOfficePdfExecution(
  input: OfficePdfSelectionInput,
  db = getDatabase(),
) {
  const ctx = input.context;
  UuidSchema.parse(ctx.workspaceId);
  const sourceInput = ArtifactSourceFileSchema.parse(input.officePdf);
  const requested = ExecutionLocationSchema.parse(input.location ?? 'auto');
  if (
    !input.callId ||
    input.callId.length > 255 ||
    input.arguments.format !== 'pdf' ||
    !runtimeContractEqual(input.arguments.officePdf, sourceInput) ||
    ExecutionLocationSchema.parse(input.arguments.location ?? 'auto') !==
      requested
  )
    throw new RuntimePolicyError('invalid_tool_call');
  const selectionId = cloudStableId(`office-pdf:${ctx.runId}:${input.callId}`);
  const requestDigest = runtimePolicyDigest({
    toolName: 'workspace.export.create',
    arguments: input.arguments,
  });
  return db.begin(async (tx) => {
    const [run] = await tx<
      {
        text: string;
        execution_snapshot: unknown;
        timeout_at: Date;
        session_id: string;
        local_inputs: boolean;
      }[]
    >`select coalesce(m.content->>'text','') as text,e.execution_snapshot,j.timeout_at,e.session_id,
      (exists(select 1 from allrice_runtime_operations o where o.run_id=r.id
        and o.organization_id=r.organization_id and o.workspace_id=r.workspace_id
        and o.snapshot->'binding'->>'action' in ('local.fs.read','local.fs.write','local.fs.changeset','local.process.execute','local.file.inspect','local.file.import','local.file.select'))
      or exists(select 1 from allrice_bridge_commands b where b.organization_id=r.organization_id
        and b.workspace_id=r.workspace_id and b.owner_id=r.owner_id
        and b.idempotency_key like ${`tool:${ctx.runId}:%`})) as local_inputs
      from allrice_runs r join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id
        and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id
      join allrice_jobs j on j.id=${ctx.jobId} and j.run_id=r.id and j.organization_id=r.organization_id
        and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id
      join allrice_messages m on m.id=e.user_message_id and m.organization_id=r.organization_id
        and m.workspace_id=r.workspace_id and m.owner_id=r.owner_id
      join allrice_chat_sessions s on s.id=e.session_id and s.organization_id=r.organization_id
        and s.workspace_id=r.workspace_id and s.owner_id=r.owner_id and s.archived_at is null
      join allrice_users u on u.id=r.owner_id and u.status='active'
      where r.id=${ctx.runId} and r.organization_id=${ctx.organizationId} and r.workspace_id=${ctx.workspaceId}
        and r.owner_id=${ctx.policySnapshot.subjectId} and r.policy_snapshot_id=${ctx.policySnapshot.id} and r.state='running'
        and j.status='running' and j.worker_id=${ctx.worker.id} and j.attempt=${input.jobAttempt}
        and j.lease_token=${input.jobLeaseToken} and j.lease_expires_at>clock_timestamp()
        and j.timeout_at>clock_timestamp() and j.cancel_requested_at is null
        and exists(select 1 from allrice_memberships membership where membership.organization_id=r.organization_id
          and membership.user_id=r.owner_id and membership.active and (membership.workspace_id is null or membership.workspace_id=r.workspace_id)
          and membership.role in ('admin','member')) for update of j`;
    const frozen = EmployeeExecutionSnapshotSchema.safeParse(
      run?.execution_snapshot,
    );
    if (
      !run ||
      !frozen.success ||
      frozen.data.tenantContext.organizationId !== ctx.organizationId ||
      frozen.data.tenantContext.workspaceId !== ctx.workspaceId ||
      frozen.data.tenantContext.actorId !== ctx.policySnapshot.subjectId ||
      frozen.data.tenantContext.policySnapshotId !== ctx.policySnapshot.id ||
      !frozen.data.capabilitySnapshot.bindings.toolNames.includes(
        'workspace.export.create',
      ) ||
      !['storage:read', 'storage:write'].every((capability) =>
        frozen.data.capabilitySnapshot.grantedCapabilities.includes(
          capability as 'storage:read' | 'storage:write',
        ),
      ) ||
      (frozen.data.employee.definition.schemaVersion === 2 &&
        frozen.data.employee.definition.securityPolicy.deniedCapabilities.some(
          (capability) =>
            capability === 'storage:read' || capability === 'storage:write',
        ))
    )
      throw new RuntimePolicyError('run_or_frozen_configuration_changed');
    const constraints = executionRequestConstraints(run.text);
    const location =
      constraints.location === 'auto' ? requested : constraints.location;
    const localInputs = run.local_inputs || constraints.localOnly;
    const [prior] = await tx<
      {
        reason: string;
        metadata: { requestDigest: string; choice: ExecutionChoice };
      }[]
    >`select reason,metadata from allrice_audit_events where organization_id=${ctx.organizationId}
      and workspace_id=${ctx.workspaceId} and actor_id=${ctx.policySnapshot.subjectId} and action='execution.location'
      and resource_type='office_pdf' and resource_id=${selectionId} order by occurred_at limit 1`;
    if (prior && prior.metadata.requestDigest !== requestDigest)
      throw new RuntimePolicyError('idempotency_conflict');
    const oldChoice = prior
      ? ExecutionChoiceSchema.parse(prior.metadata.choice)
      : null;
    const choice = resolveExecutionChoice({
      location,
      local: 'unsupported',
      cloudAvailable: true,
      localInputs,
      boundLocation:
        oldChoice?.location === 'none' ? undefined : oldChoice?.location,
      outcomeUnknown: oldChoice?.status === 'reconcile',
    });
    // Original local instructions remain authoritative even for a bound audit.
    const effectiveChoice: ExecutionChoice =
      location === 'local' && choice.location === 'cloud'
        ? { location: 'local', status: 'unavailable', reason: 'explicit_local' }
        : choice;
    const source =
      effectiveChoice.status === 'execute'
        ? await assertToolBrokerSourceFile(
            tx,
            ctx,
            sourceInput,
            run.session_id,
            undefined,
            'pdf',
          )
        : null;
    if (!prior && effectiveChoice.status !== 'unavailable')
      await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
        values(${ctx.organizationId},${ctx.workspaceId},${ctx.policySnapshot.subjectId},'execution.location','office_pdf',${selectionId},'recorded',${effectiveChoice.reason},
          ${tx.json({ requestDigest, choice: effectiveChoice, callId: input.callId, runId: ctx.runId, localInputs })})`;
    return {
      choice: effectiveChoice,
      selectionReason: prior?.reason ?? effectiveChoice.reason,
      selectionId,
      deadlineAt: run.timeout_at.toISOString(),
      source,
    };
  });
}
