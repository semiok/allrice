export type EmployeeCapability =
  | 'network:outbound'
  | 'storage:read'
  | 'storage:write'
  | 'secret:use'
  | 'model:invoke'
  | 'automation:write';

export interface EmployeeCapabilityDirectoryInput {
  employeeId: string;
  agentSkills: {
    installationId: string;
    grantedCapabilities: EmployeeCapability[];
    revision: { id: string };
    effective?: boolean;
  }[];
  workflows: { revision: { id: string }; effective?: boolean }[];
  knowledge: { revision: { id: string }; effective?: boolean }[];
}

export interface SkillInstallationInput {
  id: string;
  pinnedVersionId: string;
  grantedCapabilities: EmployeeCapability[];
}

export function buildEmployeeCapabilityUpdate(
  current: EmployeeCapabilityDirectoryInput,
  installation: SkillInstallationInput,
  shouldBind: boolean,
) {
  const retained = current.agentSkills.filter(
    (binding) =>
      binding.effective !== false &&
      binding.installationId !== installation.id &&
      binding.revision.id !== installation.pinnedVersionId,
  );
  const agentSkills = shouldBind
    ? [
        ...retained,
        {
          installationId: installation.id,
          revision: { id: installation.pinnedVersionId },
          grantedCapabilities: installation.grantedCapabilities,
        },
      ]
    : retained;
  return {
    agentSkills: agentSkills.map((binding) => ({
      installationId: binding.installationId,
      skillVersionId: binding.revision.id,
      grantedCapabilities: binding.grantedCapabilities,
    })),
    workflowRevisionIds: current.workflows
      .filter((binding) => binding.effective !== false)
      .map((binding) => binding.revision.id),
    knowledgeRevisionIds: current.knowledge
      .filter((binding) => binding.effective !== false)
      .map((binding) => binding.revision.id),
  };
}
