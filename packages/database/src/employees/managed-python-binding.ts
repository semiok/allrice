import {
  EmployeeManifestSchema,
  FrozenManagedPythonBindingSchema,
  PlatformEmployeeDefinitionSchema,
  type FrozenManagedPythonBinding,
  type SkillCapability,
} from '@allrice/contracts';

/** Called only after resolving a publication for the exact assigned version. */
export function freezeManagedOfficeBinding(input: {
  manifest: unknown;
  grantedCapabilities: readonly SkillCapability[];
  publication: {
    revisionId: string;
    checksum: string;
    definition: unknown;
  } | null;
}): FrozenManagedPythonBinding | undefined {
  const manifest = EmployeeManifestSchema.safeParse(input.manifest);
  const published = PlatformEmployeeDefinitionSchema.safeParse(
    input.publication?.definition,
  );
  if (
    !input.publication ||
    !manifest.success ||
    manifest.data.schemaVersion !== 2 ||
    !published.success
  )
    return undefined;
  const frozen = manifest.data,
    original = published.data;
  if (
    !frozen.capabilityBindings.toolNames.includes('workspace.export.create') ||
    !original.capabilities.toolNames.includes('workspace.export.create') ||
    original.securityPolicy.bridgeAccess !== 'read_write' ||
    !input.grantedCapabilities.includes('storage:write') ||
    frozen.securityPolicy.deniedCapabilities.includes('storage:write') ||
    original.securityPolicy.deniedCapabilities.includes('storage:write')
  )
    return undefined;
  const binding = FrozenManagedPythonBindingSchema.safeParse({
    contractVersion: 1,
    profileVersion: 1,
    purposes: ['office'],
    publication: {
      revisionId: input.publication.revisionId,
      checksum: input.publication.checksum,
    },
  });
  return binding.success ? binding.data : undefined;
}
