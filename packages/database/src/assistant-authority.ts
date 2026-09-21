import {
  AssistantRunConfigurationSchema,
  EmployeeExecutionSnapshotSchema,
  EmployeeManifestSchema,
  PolicySnapshotSchema,
  RuntimePolicyControlsSchema,
  RuntimeTaskRefSchema,
  runtimeContractEqual,
} from '@allrice/contracts';
import { z } from 'zod';
import type { AssistantAuthorityInput } from './assistant-runtime.ts';
import { employeeManifestChecksum } from './employees/employee-config.ts';
import { verifiedRuntimePackageChecksum } from './platform-employees/runtime-package.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';

const phases = new Set([
  'configure',
  'delegate',
  'message',
  'model',
  'tool',
  'recover',
  'proposal',
]);
const toolsSchema = z
  .array(z.string().regex(/^[a-zA-Z0-9_.-]{1,120}$/))
  .max(64);
const deny = (): never => {
  throw new Error('assistant_authority_denied');
};
function requireAuthority(value: unknown): asserts value {
  if (!value) deny();
}

/** Production admission hook. All identity/configuration is re-read from the
 * caller's existing ledger transaction; no user/model-supplied grant is trusted.
 * This coordinates assistants only. It does NOT authorize their tool side
 * effects, replace P04 approval, resolve secrets or enable any feature flag. */
export async function assertAssistantAuthority(
  input: AssistantAuthorityInput,
): Promise<void> {
  requireAuthority(
    process.env.ALLRICE_ASSISTANTS_ENABLED === '1' && phases.has(input.phase),
  );
  const parsedTask = RuntimeTaskRefSchema.safeParse(input.task),
    parsedTools = toolsSchema.safeParse(input.tools);
  requireAuthority(parsedTask.success && parsedTools.success);
  const task = parsedTask.data,
    tools = parsedTools.data,
    tx = input.transaction;
  requireAuthority(
    new Set(tools).size === tools.length &&
      task.frozenConfiguration.employeeVersionId !== null &&
      task.chatSessionId !== null,
  );
  if (input.phase === 'configure')
    requireAuthority(task.runId === task.rootRunId);

  // Identification only; mutations are excluded by locks below. The root lease
  // has already been checked by the ledger, which also rechecks it at commit.
  const [identity] = await tx<{ owner_id: string; employee_id: string }[]>`
    select r.owner_id,v.employee_id from allrice_employee_runs e
    join allrice_runs r on r.id=e.run_id and r.organization_id=e.organization_id and r.workspace_id=e.workspace_id and r.owner_id=e.owner_id
    join allrice_employee_versions v on v.id=e.employee_version_id and v.organization_id=e.organization_id and v.workspace_id=e.workspace_id
    where e.run_id=${task.rootRunId} and e.organization_id=${task.scope.organizationId} and e.workspace_id=${task.scope.workspaceId}
      and e.session_id=${task.chatSessionId} and e.employee_version_id=${task.frozenConfiguration.employeeVersionId}`;
  requireAuthority(identity);

  // Controls-before-membership matches setRuntimePolicyControls. Employee is
  // locked before assignments, matching publication/assignment management.
  const [policyControl] = await tx<{ version: number; controls: unknown }[]>`
    select version,controls from allrice_runtime_policy_controls
    where organization_id=${task.scope.organizationId} and workspace_id=${task.scope.workspaceId} for share`;
  const controls = RuntimePolicyControlsSchema.safeParse(
    policyControl?.controls,
  );
  requireAuthority(
    controls.success &&
      controls.data.version === policyControl?.version &&
      controls.data.enabled &&
      controls.data.mode === 'execute',
  );
  const delegationRules = controls.data.rules.filter(
    (rule) => rule.action === 'assistant.delegate',
  );
  requireAuthority(
    delegationRules.some((rule) => rule.effect === 'allow') &&
      delegationRules.every((rule) => rule.effect === 'allow'),
  );
  // Only the implemented local-command proposal path may advertise/submit an
  // ask-bound tool. Registration is not action permission: normal tool calls
  // still deny ask, and the proposal must pass its exact P04 command approval.
  if (input.phase === 'proposal')
    requireAuthority(
      tools.length === 1 && tools[0] === 'local.process.execute',
    );
  requireAuthority(
    !controls.data.rules.some(
      (rule) =>
        tools.includes(rule.action) &&
        rule.effect !== 'allow' &&
        !(
          rule.action === 'local.process.execute' &&
          rule.effect === 'ask' &&
          ['configure', 'delegate', 'proposal'].includes(input.phase)
        ),
    ),
  );

  const [member] = await tx`
    select m.id from allrice_memberships m
    join allrice_users u on u.id=m.user_id and u.status='active'
    join allrice_organizations o on o.id=m.organization_id and o.archived_at is null
    join allrice_workspaces w on w.id=${task.scope.workspaceId} and w.organization_id=o.id and w.archived_at is null
    where m.organization_id=${task.scope.organizationId} and m.user_id=${identity.owner_id}
      and (m.workspace_id is null or m.workspace_id=${task.scope.workspaceId}) and m.active and m.role in ('admin','member') for share of m,u,o,w`;
  requireAuthority(member);
  const [employee] = await tx`
    select id from allrice_employees where id=${identity.employee_id} and organization_id=${task.scope.organizationId}
      and workspace_id=${task.scope.workspaceId} and status='active' for share`;
  requireAuthority(employee);

  const [root] = await tx<
    {
      owner_id: string;
      project_id: string | null;
      execution_spec: unknown;
      input: { assistantConfiguration?: unknown };
      root_task: unknown;
      link_task: unknown;
      configuration: unknown;
      execution_snapshot: unknown;
      policy_snapshot_id: string;
      policy_payload: unknown;
      policy_expires_at: Date;
      employee_assignment_id: string;
      employee_version_id: string;
      session_id: string;
      manifest: unknown;
      config_checksum: string;
      version: number;
      deadline_at: Date;
      lease_expires_at: Date;
      lease_token: string;
      worker_lease_digest: string;
      timeout_at: Date;
    }[]
  >`
    select r.owner_id,r.project_id,r.execution_spec,r.input,rt.task as root_task,l.task as link_task,ar.configuration,
      e.execution_snapshot,e.employee_assignment_id,e.employee_version_id,e.session_id,
      r.policy_snapshot_id,p.payload as policy_payload,p.expires_at as policy_expires_at,
      v.manifest,v.config_checksum,v.version,rt.deadline_at,j.lease_expires_at,j.timeout_at,j.lease_token,ar.worker_lease_digest
    from allrice_runtime_roots rt
    join allrice_assistant_roots ar on ar.root_run_id=rt.root_run_id
    join allrice_runtime_run_links l on l.root_run_id=rt.root_run_id and l.run_id=${task.runId}
      and l.organization_id=rt.organization_id and l.workspace_id=rt.workspace_id
    join allrice_runs r on r.id=rt.root_run_id and r.organization_id=rt.organization_id and r.workspace_id=rt.workspace_id
    join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id
    join allrice_employee_assignments a on a.id=e.employee_assignment_id and a.organization_id=e.organization_id
      and a.workspace_id=e.workspace_id and a.user_id=e.owner_id and a.employee_id=${identity.employee_id} and a.active
    join allrice_employee_versions v on v.id=e.employee_version_id and v.employee_id=a.employee_id
      and v.organization_id=e.organization_id and v.workspace_id=e.workspace_id
    join allrice_policy_snapshots p on p.id=r.policy_snapshot_id and p.organization_id=r.organization_id and p.subject_id=r.owner_id
    join allrice_chat_sessions s on s.id=e.session_id and s.organization_id=e.organization_id and s.workspace_id=e.workspace_id and s.owner_id=e.owner_id
    join allrice_conversation_runtimes c on c.session_id=e.session_id and c.organization_id=e.organization_id
      and c.workspace_id=e.workspace_id and c.owner_id=e.owner_id and c.active_run_id=r.id and c.state='running'
      and c.thread_generation=ar.generation and c.worker_id=ar.worker_id
    join allrice_jobs j on j.id=ar.worker_job_id and j.run_id=r.id and j.organization_id=r.organization_id
      and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id and j.worker_id=ar.worker_id
    where rt.root_run_id=${task.rootRunId} and rt.organization_id=${task.scope.organizationId} and rt.workspace_id=${task.scope.workspaceId}
      and r.owner_id=${identity.owner_id} and r.project_id is not distinct from ${task.scope.projectId}::uuid
      and r.state='running' and ar.revoked_at is null and rt.cancel_request_id is null and rt.deadline_at>clock_timestamp()
      and e.employee_version_id=${task.frozenConfiguration.employeeVersionId} and e.session_id=${task.chatSessionId}
      and s.archived_at is null and s.project_id is not distinct from r.project_id and j.status='running' and j.cancel_requested_at is null
      and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp() and p.expires_at>clock_timestamp()
    for share of rt,ar,l,r,e,a,v,p,s,c,j`;
  requireAuthority(root && root.owner_id === identity.owner_id);
  requireAuthority(
    root.worker_lease_digest === runtimePolicyDigest(root.lease_token),
  );
  const rootTask = RuntimeTaskRefSchema.safeParse(root.root_task),
    linkTask = RuntimeTaskRefSchema.safeParse(root.link_task);
  const configuration = AssistantRunConfigurationSchema.safeParse(
    root.input?.assistantConfiguration,
  );
  const frozenConfiguration = AssistantRunConfigurationSchema.safeParse(
    root.configuration,
  );
  const snapshot = EmployeeExecutionSnapshotSchema.safeParse(
      root.execution_snapshot,
    ),
    manifest = EmployeeManifestSchema.safeParse(root.manifest);
  requireAuthority(
    rootTask.success &&
      linkTask.success &&
      configuration.success &&
      frozenConfiguration.success &&
      snapshot.success &&
      manifest.success,
  );
  requireAuthority(
    configuration.data.allowAssistants &&
      runtimeContractEqual(configuration.data, frozenConfiguration.data),
  );
  requireAuthority(
    runtimeContractEqual(linkTask.data, task) &&
      runtimeContractEqual(rootTask.data, {
        ...task,
        runId: task.rootRunId,
        parentRunId: null,
      }),
  );
  requireAuthority(
    runtimePolicyDigest(root.execution_spec) ===
      task.frozenConfiguration.digest,
  );
  requireAuthority(
    manifest.data.schemaVersion === 2 &&
      snapshot.data.runtimePolicy.harness === 'dsh',
  );
  const definition = manifest.data;
  requireAuthority(
    snapshot.data.employee.id === identity.employee_id &&
      snapshot.data.employee.versionId === root.employee_version_id &&
      snapshot.data.employee.revision === root.version,
  );
  requireAuthority(
    snapshot.data.employee.definitionChecksum === root.config_checksum &&
      (manifest.data.schemaVersion === 2 && manifest.data.runtimePackage
        ? verifiedRuntimePackageChecksum(manifest.data.runtimePackage)
        : employeeManifestChecksum(manifest.data)) === root.config_checksum &&
      runtimeContractEqual(snapshot.data.employee.definition, manifest.data),
  );
  if (manifest.data.schemaVersion === 2 && manifest.data.runtimePackage) {
    const packaged = manifest.data.runtimePackage.runtimeManifest;
    requireAuthority(
      packaged.provider === manifest.data.runtimePolicy.provider &&
        packaged.model === manifest.data.runtimePolicy.model &&
        runtimeContractEqual(
          [...packaged.toolNames].sort(),
          [...manifest.data.capabilityBindings.toolNames].sort(),
        ) &&
        runtimeContractEqual(
          [...packaged.deniedCapabilities].sort(),
          [...manifest.data.securityPolicy.deniedCapabilities].sort(),
        ),
    );
  }
  requireAuthority(
    snapshot.data.assignment.id === root.employee_assignment_id &&
      snapshot.data.assignment.userId === root.owner_id,
  );
  requireAuthority(
    snapshot.data.tenantContext.organizationId === task.scope.organizationId &&
      snapshot.data.tenantContext.workspaceId === task.scope.workspaceId &&
      snapshot.data.tenantContext.actorId === root.owner_id &&
      snapshot.data.tenantContext.policySnapshotId === root.policy_snapshot_id,
  );
  if (snapshot.data.schemaVersion === 2)
    requireAuthority(
      snapshot.data.capabilitySnapshot.resolvedForActorId === root.owner_id,
    );
  requireAuthority(
    snapshot.data.capabilitySnapshot.grantedCapabilities.includes(
      'model:invoke',
    ) &&
      manifest.data.capabilities.includes('model:invoke') &&
      !manifest.data.securityPolicy.deniedCapabilities.includes('model:invoke'),
  );
  requireAuthority(
    snapshot.data.capabilitySnapshot.grantedCapabilities.every(
      (capability) =>
        manifest.data.capabilities.includes(capability) &&
        !definition.securityPolicy.deniedCapabilities.includes(capability),
    ),
  );
  const frozenTools = snapshot.data.capabilitySnapshot.bindings.toolNames,
    declaredTools = manifest.data.capabilityBindings.toolNames;
  requireAuthority(
    frozenTools.includes('assistant.delegate') &&
      declaredTools.includes('assistant.delegate') &&
      tools.every(
        (tool) => frozenTools.includes(tool) && declaredTools.includes(tool),
      ),
  );

  const frozenPolicy = PolicySnapshotSchema.pick({
    memberships: true,
    grants: true,
  }).safeParse(root.policy_payload);
  requireAuthority(
    frozenPolicy.success &&
      frozenPolicy.data.memberships.some(
        (m) =>
          m.userId === root.owner_id &&
          m.organizationId === task.scope.organizationId &&
          (m.workspaceId === null ||
            m.workspaceId === task.scope.workspaceId) &&
          m.active &&
          ['admin', 'member'].includes(m.role),
      ) &&
      frozenPolicy.data.grants.some(
        (g) =>
          g.resourceType === 'job' &&
          g.action === 'job:execute' &&
          (g.workspaceId === null || g.workspaceId === task.scope.workspaceId),
      ),
  );
  if (task.scope.projectId !== null) {
    const [project] =
      await tx`select id from allrice_projects where id=${task.scope.projectId} and organization_id=${task.scope.organizationId}
      and workspace_id=${task.scope.workspaceId} and archived_at is null and (owner_id=${root.owner_id} or visibility in ('workspace','organization')) for share`;
    requireAuthority(project);
  }
  // Lock/read actual child scope too; possessing a root's capability snapshot
  // does not let a child recover the parent's wider tool set.
  if (input.phase !== 'configure') {
    const [instance] = await tx<{ allowed_tools: unknown }[]>`
      select allowed_tools from allrice_assistant_instances where run_id=${task.runId} and root_run_id=${task.rootRunId}
        and parent_run_id is not distinct from ${task.parentRunId}::uuid and cancel_requested_at is null
        and status in ('provisioning','running','waiting') for share`;
    const allowedTools = toolsSchema.safeParse(instance?.allowed_tools);
    requireAuthority(
      allowedTools.success &&
        tools.every((tool) => allowedTools.data.includes(tool)),
    );
    if (input.phase === 'delegate')
      requireAuthority(allowedTools.data.includes('assistant.delegate'));
  }
  const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
  requireAuthority(
    clock &&
      root.policy_expires_at > clock.now &&
      root.deadline_at > clock.now &&
      root.lease_expires_at > clock.now &&
      root.timeout_at > clock.now &&
      process.env.ALLRICE_ASSISTANTS_ENABLED === '1',
  );
}
