import type { EmployeeRuntimePackage } from '@allrice/contracts';
import { runtimePolicyDigest } from '../runtime-policy-digest.ts';

export type PersonaRuntimePackagePayload = Omit<
  Extract<EmployeeRuntimePackage, { schemaVersion: 3 }>,
  'checksum'
>;

/** Schema-3 signing contract shared by readers and the future writer.
 * Callers provide schema-validated JSON: recursively sort object keys, retain
 * array order and sign optional fields only when present. No defaults or
 * JSON.stringify coercions: explicit undefined/non-finite/sparse values fail.
 * Legacy schema 1/2 must retain their original ordered JSON algorithm. */
export function personaRuntimePackageChecksum(
  pkg: PersonaRuntimePackagePayload,
): string {
  return runtimePolicyDigest({
    schemaVersion: pkg.schemaVersion,
    packageVersion: pkg.packageVersion,
    capabilityFingerprint: pkg.capabilityFingerprint,
    foundation: pkg.foundation,
    platformPolicy: pkg.platformPolicy,
    skills: pkg.skills,
    runtimeManifest: pkg.runtimeManifest,
  });
}
