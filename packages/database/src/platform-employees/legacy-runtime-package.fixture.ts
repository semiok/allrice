import {
  EmployeeRuntimePackageSchema,
  type EmployeeRuntimePackage,
} from '@allrice/contracts';
import {
  buildEmployeeRuntimePackage,
  runtimePackageChecksum,
} from './runtime-package.ts';

/** Synthetic historical authority fixtures, not the retired production writer.
 * Instruction bytes are fixed and never reconstructed from today's identity,
 * routing table or catalog. Fixed old checksum vectors live in reader tests. */
export function syntheticLegacyRuntimePackage(current: EmployeeRuntimePackage) {
  const payload = {
    schemaVersion: current.skills.some((skill) => skill.bundle)
      ? (2 as const)
      : (1 as const),
    packageVersion: current.packageVersion,
    capabilityFingerprint: current.capabilityFingerprint,
    files: {
      identityMd: '# IDENTITY.md - immutable synthetic identity',
      soulMd: '# SOUL.md - immutable synthetic boundaries',
      userMd: '# USER.md - immutable synthetic placeholder',
      agentsMd: '# AGENTS.md - immutable synthetic methods',
    },
    skills: current.skills,
    runtimeManifest: {
      source: current.runtimeManifest.source,
      harness: current.runtimeManifest.harness,
      distributionGeneration: current.runtimeManifest.distributionGeneration,
      provider: current.runtimeManifest.provider,
      model: current.runtimeManifest.model,
      toolNames: current.runtimeManifest.toolNames,
      deniedCapabilities: current.runtimeManifest.deniedCapabilities,
      skillGovernance: current.runtimeManifest.skillGovernance,
      instructionPrecedence: [
        'platform-hard-policy',
        'identity',
        'behavior',
        'work-rules',
        'tenant-user-context',
        'runtime-authorization',
        'user-request',
        'skill-details',
      ] as const,
    },
  };
  const pkg = EmployeeRuntimePackageSchema.parse({
    ...payload,
    checksum: runtimePackageChecksum(payload),
  });
  if (pkg.schemaVersion === 3) throw Error('fixture_legacy_package_required');
  return pkg;
}

export function legacyRuntimePackageFixture(
  input: Parameters<typeof buildEmployeeRuntimePackage>[0],
) {
  return syntheticLegacyRuntimePackage(buildEmployeeRuntimePackage(input));
}
