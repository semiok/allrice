import {
  CloudCommandInputSchema,
  EmployeeExecutionSnapshotSchema,
  type ExecutionContext,
} from '@allrice/contracts';
import {
  getDatabase,
  readFrozenSkillResource,
  validateFrozenSkill,
} from '@allrice/database';
import { CloudToolInputSchema } from '../../cloud-runner/tool-input.js';

/** Resolve only from the immutable, scoped persisted Run; no catalog/host read.
 * Resolving grants nothing: caller still obtains the normal exact cloud approval. */
export async function resolveCloudToolArguments(
  input: {
    context: ExecutionContext;
    sessionId?: string;
    arguments: unknown;
  },
  db = getDatabase(),
) {
  const args = CloudToolInputSchema.parse(input.arguments);
  if ('script' in args) return args;
  if (!input.sessionId) throw Error('frozen_script_session_required');
  const c = input.context;
  const [run] = await db<
    { native_skills: unknown[]; execution_snapshot: unknown }[]
  >`
    select native_skills,execution_snapshot from allrice_employee_runs
    where run_id=${c.runId} and organization_id=${c.organizationId}
      and workspace_id=${c.workspaceId} and owner_id=${c.policySnapshot.subjectId}
      and session_id=${input.sessionId}`;
  if (!run) throw Error('frozen_script_run_unavailable');
  const execution = EmployeeExecutionSnapshotSchema.parse(
    run.execution_snapshot,
  );
  const requiredTools = ['workspace.skill.read', 'cloud.process.execute'];
  if (
    !requiredTools.every((tool) =>
      execution.capabilitySnapshot.bindings.toolNames.includes(tool),
    ) ||
    !['storage:read', 'storage:write'].every((capability) =>
      execution.capabilitySnapshot.grantedCapabilities.some(
        (granted) => granted === capability,
      ),
    )
  )
    throw Error('frozen_script_tool_not_authorized');
  const skills = run.native_skills.map(validateFrozenSkill);
  const selected = skills.find(
    (skill) => skill.name === args.frozenScript.skill,
  );
  if (
    !selected ||
    !requiredTools.every((tool) => selected.requiredToolRefs.includes(tool))
  )
    throw Error('frozen_script_skill_not_authorized');
  if (
    !selected.bundle?.dependencies.some(
      (dependency) =>
        dependency.kind === 'runtime' && dependency.name === 'node',
    )
  )
    throw Error('frozen_script_runtime_required');
  const resource = readFrozenSkillResource(
    skills,
    args.frozenScript.skill,
    args.frozenScript.path,
  );
  if (
    !['text/javascript', 'application/javascript'].includes(resource.mediaType)
  )
    throw Error('frozen_script_media_type_invalid');
  const script = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(Buffer.from(resource.contentBase64, 'base64'));
  return CloudCommandInputSchema.parse({
    script,
    inputs: args.inputs,
    outputs: args.outputs,
    limits: args.limits,
  });
}
