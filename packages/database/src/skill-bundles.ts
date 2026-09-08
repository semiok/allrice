import { createHash } from 'node:crypto';
import {
  SkillBundleSchema,
  DshNativeSkillSnapshotSchema,
  EmployeeRuntimePackageSchema,
  allRiceToolManifest,
  localCommandToolchainImageV1,
  type SkillBundle,
  type DshNativeSkillSnapshot,
} from '@allrice/contracts';

export const skillBytesChecksum = (value: string | Uint8Array) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

// Canonicalize object order, but preserve declared array order. Legacy runtime
// packages keep their existing checksum format; this only signs bundle v1.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  return value;
}
export function skillBundleChecksum(bundle: Omit<SkillBundle, 'checksum'>) {
  return skillBytesChecksum(JSON.stringify(canonical(bundle)));
}

export function validateSkillBundle(
  input: unknown,
  content?: string,
): SkillBundle {
  const bundle = SkillBundleSchema.parse(input);
  const { checksum, ...payload } = bundle;
  if (
    skillBundleChecksum(payload) !== checksum ||
    (content !== undefined &&
      skillBytesChecksum(content) !== bundle.contentChecksum)
  )
    throw Error('skill_bundle_checksum_mismatch');
  const tools = new Set(
    allRiceToolManifest.map((t) => t.canonicalName as string),
  );
  for (const dependency of bundle.dependencies) {
    if (dependency.kind === 'tool' && !tools.has(dependency.name))
      throw Error('skill_bundle_unknown_tool');
    if (
      dependency.kind === 'runtime' &&
      dependency.imageDigest !== localCommandToolchainImageV1
    )
      throw Error('skill_bundle_unsupported_runtime');
  }
  for (const resource of bundle.resources) {
    const bytes = Buffer.from(resource.contentBase64, 'base64');
    if (
      bytes.toString('base64') !== resource.contentBase64 ||
      bytes.length !== resource.byteLength ||
      skillBytesChecksum(bytes) !== resource.checksum
    )
      throw Error('skill_resource_checksum_mismatch');
  }
  return bundle;
}

export function validateFrozenSkill(input: unknown): DshNativeSkillSnapshot {
  const skill = DshNativeSkillSnapshotSchema.parse(input);
  if (skillBytesChecksum(skill.content) !== skill.checksum)
    throw Error('skill_content_checksum_mismatch');
  if (skill.bundle) {
    validateSkillBundle(skill.bundle, skill.content);
    if (
      skill.bundle.dependencies.some(
        (d) => d.kind === 'tool' && !skill.requiredToolRefs.includes(d.name),
      )
    )
      throw Error('skill_bundle_undeclared_tool');
  }
  return skill;
}

/** Verify the revision itself before trusting its assets. No mutable catalog lookup. */
export function frozenPackageSkills(input: unknown): DshNativeSkillSnapshot[] {
  const pkg = EmployeeRuntimePackageSchema.parse(input);
  const { files } = pkg;
  const signed = {
    schemaVersion: pkg.schemaVersion,
    packageVersion: pkg.packageVersion,
    capabilityFingerprint: pkg.capabilityFingerprint,
    files: {
      identityMd: files.identityMd,
      soulMd: files.soulMd,
      userMd: files.userMd,
      agentsMd: files.agentsMd,
    },
    skills: pkg.skills,
    runtimeManifest: pkg.runtimeManifest,
  };
  if (skillBytesChecksum(JSON.stringify(signed)) !== pkg.checksum)
    throw Error('runtime_package_checksum_mismatch');
  if (pkg.schemaVersion === 1 && pkg.skills.some((s) => s.bundle))
    throw Error('legacy_package_contains_bundle');
  for (const skill of pkg.skills) {
    validateFrozenSkill(skill);
    const governance = pkg.runtimeManifest.skillGovernance.find(
      (g) => g.id === skill.id,
    );
    if (!governance || governance.checksum !== skill.checksum)
      throw Error('skill_governance_mismatch');
    if (
      skill.bundle &&
      (governance.version !== skill.bundle.version ||
        governance.license !== skill.bundle.license ||
        governance.sourceRef !== skill.bundle.sourceRef ||
        governance.reviewedByLabel !== skill.bundle.reviewedBy)
    )
      throw Error('skill_bundle_governance_mismatch');
  }
  return pkg.skills;
}

/** Inert asset read from this exact Run only; never reads a host path or executes scripts. */
export function readFrozenSkillResource(
  skills: readonly DshNativeSkillSnapshot[],
  name: string,
  path: string,
) {
  const skill = skills.find((candidate) => candidate.name === name);
  if (!skill) throw Error('skill_not_in_frozen_run');
  validateFrozenSkill(skill);
  const asset = skill.bundle?.resources.find(
    (resource) => resource.path === path,
  );
  if (!asset) throw Error('skill_resource_not_found');
  return {
    skill: skill.name,
    version: skill.bundle!.version,
    bundleChecksum: skill.bundle!.checksum,
    ...asset,
  };
}
