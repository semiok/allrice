import { EmployeeCapabilityBindingsSchema } from './employees.ts';
import { withPlatformImageTools } from './image-generation.ts';
import type { SkillCapability } from './skills.ts';

/** A2 retirement: historical declaration names only, never executable tools
 * or aliases for V2 grants. Keep source readers and Run projection aligned. */
export const retiredMemoryToolNames = [
  'workspace.memory.search',
  'workspace.experience.read',
] as const;

/** Freeze the current read tool only from an explicit memory.read grant.
 * Retired tools never grant a replacement capability. */
export function freezeMemoryIndexToolNames(
  toolNames: readonly string[],
  capabilities: readonly SkillCapability[],
  model: Parameters<typeof withPlatformImageTools>[2],
) {
  const readable =
    capabilities.includes('storage:read') &&
    toolNames.includes('workspace.memory.read');
  const names = toolNames.filter(
    (name) =>
      ![...retiredMemoryToolNames, 'workspace.memory.read'].includes(name),
  );
  const selected = [
    ...new Set([...names, ...(readable ? ['workspace.memory.read'] : [])]),
  ];
  EmployeeCapabilityBindingsSchema.shape.toolNames.parse(
    withPlatformImageTools(selected, capabilities, model),
  );
  return EmployeeCapabilityBindingsSchema.shape.toolNames.parse(selected);
}

/** Internal scheduled/manual/folder tasks never carry personal memory tools.
 * This filters the actual frozen allowlist, without changing storage grants. */
export function withoutTaskMemoryTools(toolNames: readonly string[]) {
  return toolNames.filter(
    (name) =>
      ![
        'workspace.memory.read',
        ...retiredMemoryToolNames,
        'workspace.memory.remember',
      ].includes(name),
  );
}

/** Bytes of a JSON transport envelope, never model billing tokens. */
export function memoryContextBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
