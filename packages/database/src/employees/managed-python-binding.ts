import {
  EmployeeManifestSchema,
  FrozenManagedPythonBindingSchema,
  PlatformEmployeeDefinitionSchema,
  type FrozenManagedPythonBinding,
  type SkillCapability,
} from '@allrice/contracts';

/** Called only after resolving a publication for the exact assigned version. */
export function freezeManagedPythonBinding(input: {
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
    original.securityPolicy.bridgeAccess !== 'read_write' ||
    !input.grantedCapabilities.includes('storage:write') ||
    frozen.securityPolicy.deniedCapabilities.includes('storage:write') ||
    original.securityPolicy.deniedCapabilities.includes('storage:write')
  )
    return undefined;
  const purposes = (
    [
      ['workspace.export.create', 'office'],
      ['python.execute', 'python_charts'],
    ] as const
  )
    .filter(
      ([tool]) =>
        frozen.capabilityBindings.toolNames.includes(tool) &&
        original.capabilities.toolNames.includes(tool),
    )
    .map(([, purpose]) => purpose);
  if (!purposes.length) return undefined;
  const binding = FrozenManagedPythonBindingSchema.safeParse({
    contractVersion: 1,
    profileVersion: 1,
    purposes,
    publication: {
      revisionId: input.publication.revisionId,
      checksum: input.publication.checksum,
    },
  });
  return binding.success ? binding.data : undefined;
}

// Preserve existing callers and immutable Office fixtures.
export const freezeManagedOfficeBinding = freezeManagedPythonBinding;
