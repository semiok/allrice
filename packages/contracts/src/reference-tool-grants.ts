import { EmployeeCapabilityBindingsSchema } from './employees.ts';
import { withPlatformImageTools } from './image-generation.ts';
import type { SkillCapability } from './skills.ts';

export const referenceToolNames = [
  'workspace.reference.search',
  'workspace.reference.read',
] as const;
export type ReferenceToolName = (typeof referenceToolNames)[number];

/** Only new ordinary Runs derive these read-only tools from an existing file
 * reader. Historical and delegated allowlists are never expanded here. */
export function freezeReferenceToolNames(
  names: readonly string[],
  capabilities: readonly SkillCapability[],
  model: Parameters<typeof withPlatformImageTools>[2],
  ordinaryRun: boolean,
) {
  if (
    !ordinaryRun ||
    !capabilities.includes('storage:read') ||
    !names.some(
      (name) =>
        name === 'workspace.file.read' || name === 'workspace.document.read',
    )
  )
    return [...names];
  const expanded = [...new Set([...names, ...referenceToolNames])];
  return EmployeeCapabilityBindingsSchema.shape.toolNames.safeParse(
    withPlatformImageTools(expanded, capabilities, model),
  ).success
    ? EmployeeCapabilityBindingsSchema.shape.toolNames.parse(expanded)
    : [...names];
}
