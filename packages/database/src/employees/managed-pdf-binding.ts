import {
  EmployeeManifestSchema,
  FrozenManagedPdfBindingSchema,
  PlatformEmployeeDefinitionSchema,
  type FrozenManagedPdfBinding,
  type SkillCapability,
} from '@allrice/contracts';

/** Resolve the exact assigned publication before calling; never follow drafts. */
export function freezeManagedPdfBinding(input: {
  manifest: unknown;
  grantedCapabilities: readonly SkillCapability[];
  publication: {
    revisionId: string;
    checksum: string;
    definition: unknown;
  } | null;
}): FrozenManagedPdfBinding | undefined {
  const manifest = EmployeeManifestSchema.safeParse(input.manifest);
  const publication = PlatformEmployeeDefinitionSchema.safeParse(
    input.publication?.definition,
  );
  if (
    !input.publication ||
    !manifest.success ||
    manifest.data.schemaVersion !== 2 ||
    !publication.success
  )
    return undefined;
  const frozen = manifest.data,
    original = publication.data;
  if (
    !input.grantedCapabilities.includes('storage:read') ||
    original.securityPolicy.bridgeAccess === 'none' ||
    frozen.securityPolicy.deniedCapabilities.includes('storage:read') ||
    original.securityPolicy.deniedCapabilities.includes('storage:read') ||
    !frozen.capabilityBindings.toolNames.includes('workspace.document.read') ||
    !original.capabilities.toolNames.includes('workspace.document.read')
  )
    return undefined;
  const binding = FrozenManagedPdfBindingSchema.safeParse({
    contractVersion: 1,
    profileVersion: 1,
    publication: {
      revisionId: input.publication.revisionId,
      checksum: input.publication.checksum,
    },
  });
  return binding.success ? binding.data : undefined;
}
