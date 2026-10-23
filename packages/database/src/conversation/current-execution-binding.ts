import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  allRiceToolManifest,
  DSH_MISSING_FROZEN_GENERATION,
  EmployeeDefinitionSchema,
  EmployeeExecutionSnapshotSchema,
  UuidSchema,
} from '@allrice/contracts';
import { employeeManifestChecksum } from '../employees/employee-config.ts';
import {
  runtimePackageChecksum,
  verifiedRuntimePackageChecksum,
} from '../platform-employees/runtime-package.ts';
import { frozenPackageSkills } from '../skill-bundles.ts';

export const newNativeGeneration = 'dsh-0.2.1-rc.2-687f282' as const;
export const employeeExecutionSourceFamily =
  'allrice_declarative_employee_v1' as const;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

// Kept byte-for-byte in meaning from native-root-origin: v1 origin checksums
// and persisted reader approvals must not change when v2 is introduced.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const nativeRootDigest = (value: unknown) =>
  'sha256:' +
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');

export const CurrentEmployeeExecutionTupleSchema = z
  .object({
    artifactId: digest,
    generation: z.literal(newNativeGeneration),
    profileId: z.literal('restricted'),
  })
  .strict();
export type CurrentEmployeeExecutionTuple = z.infer<
  typeof CurrentEmployeeExecutionTupleSchema
>;
const sourceBase = z
  .object({
    employeeVersionId: UuidSchema,
    configChecksum: digest,
    manifestDigest: digest,
    manifestSchema: z.literal(2),
    // Original declared capabilities, skills and resource identities. Actual
    // per-Run grants remain in the separately signed execution snapshot.
    capabilitySnapshotDigest: digest,
  })
  .strict();
export const EmployeeExecutionSourceSchema = z
  .union([
    sourceBase
      .extend({
        packageSchema: z.null(),
        packageChecksum: z.null(),
        declaredGeneration: z.null(),
      })
      .strict(),
    sourceBase
      .extend({
        packageSchema: z.union([z.literal(1), z.literal(2)]),
        packageChecksum: digest,
        declaredGeneration: z.literal(DSH_MISSING_FROZEN_GENERATION),
      })
      .strict(),
    sourceBase
      .extend({
        packageSchema: z.union([z.literal(1), z.literal(2)]),
        packageChecksum: digest,
        declaredGeneration: z.literal(newNativeGeneration),
      })
      .strict(),
  ])
  .superRefine((source, context) => {
    if (
      source.packageSchema !== null &&
      source.configChecksum !== source.packageChecksum
    )
      context.addIssue({
        code: 'custom',
        message: 'CURRENT_EXECUTION_SOURCE_CHECKSUM_MISMATCH',
      });
  });
export type EmployeeExecutionSource = z.infer<
  typeof EmployeeExecutionSourceSchema
>;
const sourceVariant = z.enum([
  'definition_only',
  'legacy_published_package_v1',
  'current_published_package_v1',
  'legacy_published_package_v2',
  'current_published_package_v2',
]);
export type EmployeeExecutionSourceVariant = z.infer<typeof sourceVariant>;

function variantFor(
  source: EmployeeExecutionSource,
): EmployeeExecutionSourceVariant {
  if (source.packageSchema === null) return 'definition_only';
  if (source.packageSchema === 1)
    return source.declaredGeneration === newNativeGeneration
      ? 'current_published_package_v1'
      : 'legacy_published_package_v1';
  return source.declaredGeneration === newNativeGeneration
    ? 'current_published_package_v2'
    : 'legacy_published_package_v2';
}
function sourcePolicyDigest(variant: EmployeeExecutionSourceVariant) {
  // Policy identity only; no Run, lease, mutable catalog or business checksum.
  return nativeRootDigest({
    family: employeeExecutionSourceFamily,
    variant,
    manifestSchema: 2,
    packageSchema:
      variant === 'definition_only' ? null : variant.endsWith('_v1') ? 1 : 2,
    declaredGeneration:
      variant === 'definition_only'
        ? null
        : variant.startsWith('legacy_')
          ? DSH_MISSING_FROZEN_GENERATION
          : newNativeGeneration,
    executionGeneration: newNativeGeneration,
    profileId: 'restricted',
    validation: 'original-checksums-known-tools-reviewed-frozen-bundles-v1',
  });
}
export const EmployeeExecutionSourcePolicySchema = z
  .object({
    family: z.literal(employeeExecutionSourceFamily),
    variant: sourceVariant,
    digest,
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.digest !== sourcePolicyDigest(policy.variant))
      context.addIssue({
        code: 'custom',
        message: 'CURRENT_EXECUTION_SOURCE_POLICY_INVALID',
      });
  });
export type EmployeeExecutionSourcePolicy = z.infer<
  typeof EmployeeExecutionSourcePolicySchema
>;
function policyFor(
  source: EmployeeExecutionSource,
): EmployeeExecutionSourcePolicy {
  const variant = variantFor(source);
  return {
    family: employeeExecutionSourceFamily,
    variant,
    digest: sourcePolicyDigest(variant),
  };
}
function need(condition: unknown, code: string): asserts condition {
  if (!condition) throw Error(code);
}
function sorted(values: readonly string[]) {
  return [...values].sort();
}
const equal = (left: unknown, right: unknown) =>
  nativeRootDigest(left) === nativeRootDigest(right);
const knownTools = new Set(
  allRiceToolManifest.map((tool) => tool.canonicalName as string),
);
function assertTools(tools: readonly string[]) {
  need(
    new Set(tools).size === tools.length &&
      tools.every((name) => knownTools.has(name)),
    'CURRENT_EXECUTION_SOURCE_TOOL_INVALID',
  );
}

export type EmployeeExecutionSourceInput = {
  employeeVersionId: string;
  configChecksum: string;
  /** Immutable version's original JSON. Never derive this from the latest assignment. */
  manifest: unknown;
};
export function validateEmployeeExecutionSource(
  input: EmployeeExecutionSourceInput,
): {
  source: EmployeeExecutionSource;
  sourcePolicy: EmployeeExecutionSourcePolicy;
} {
  const employeeVersionId = UuidSchema.parse(input.employeeVersionId);
  const configChecksum = digest.parse(input.configChecksum);
  const manifest = EmployeeDefinitionSchema.parse(input.manifest);
  need(
    manifest.runtimePolicy.harness === 'dsh' &&
      ['codex', 'dsh'].includes(manifest.provider.provider),
    'CURRENT_EXECUTION_SOURCE_HARNESS_INVALID',
  );
  assertTools(manifest.capabilityBindings.toolNames);
  const pkg = manifest.runtimePackage;
  let skills: ReturnType<typeof frozenPackageSkills> = [];
  if (pkg !== null) {
    need(
      pkg.schemaVersion === 1 || pkg.schemaVersion === 2,
      'CURRENT_EXECUTION_SOURCE_PACKAGE_SCHEMA_UNSUPPORTED',
    );
    need(
      pkg.runtimeManifest.distributionGeneration ===
        DSH_MISSING_FROZEN_GENERATION ||
        pkg.runtimeManifest.distributionGeneration === newNativeGeneration,
      'CURRENT_EXECUTION_SOURCE_GENERATION_UNSUPPORTED',
    );
    need(
      verifiedRuntimePackageChecksum(pkg) === pkg.checksum &&
        configChecksum === pkg.checksum,
      'CURRENT_EXECUTION_SOURCE_CHECKSUM_MISMATCH',
    );
    // These existing validators include bundle/resource checksums, paths,
    // runtime/image dependencies and exact immutable governance provenance.
    skills = frozenPackageSkills(pkg);
    const published = pkg.runtimeManifest;
    assertTools(published.toolNames);
    need(
      published.provider === manifest.runtimePolicy.provider &&
        published.model === manifest.runtimePolicy.model &&
        equal(
          sorted(published.toolNames),
          sorted(manifest.capabilityBindings.toolNames),
        ) &&
        equal(
          sorted(published.deniedCapabilities),
          sorted(manifest.securityPolicy.deniedCapabilities),
        ),
      'CURRENT_EXECUTION_SOURCE_DECLARATION_MISMATCH',
    );
    need(
      new Set(skills.map((skill) => skill.id)).size === skills.length &&
        new Set(skills.map((skill) => skill.name)).size === skills.length &&
        published.skillGovernance.length === skills.length &&
        new Set(published.skillGovernance.map((item) => item.id)).size ===
          skills.length,
      'CURRENT_EXECUTION_SOURCE_GOVERNANCE_INVALID',
    );
    for (const skill of skills) {
      assertTools(skill.requiredToolRefs);
      need(
        published.skillGovernance.find((item) => item.id === skill.id)?.name ===
          skill.name,
        'CURRENT_EXECUTION_SOURCE_GOVERNANCE_INVALID',
      );
    }
    // Reuse the package checksum algorithm with the original generation. This
    // is the capability payload emitted by buildEmployeeRuntimePackage.
    need(
      pkg.capabilityFingerprint ===
        runtimePackageChecksum({
          distributionGeneration: published.distributionGeneration,
          provider: published.provider,
          model: published.model,
          tools: sorted(published.toolNames),
          skills: skills.map((skill) => ({
            name: skill.name,
            checksum: skill.checksum,
            requiredToolRefs: sorted(skill.requiredToolRefs),
            ...(skill.bundle ? { bundleChecksum: skill.bundle.checksum } : {}),
          })),
          deniedCapabilities: sorted(published.deniedCapabilities),
        }),
      'CURRENT_EXECUTION_SOURCE_CAPABILITY_FINGERPRINT_MISMATCH',
    );
  } else {
    need(
      employeeManifestChecksum(manifest) === configChecksum,
      'CURRENT_EXECUTION_SOURCE_CHECKSUM_MISMATCH',
    );
  }
  const source = EmployeeExecutionSourceSchema.parse({
    employeeVersionId,
    configChecksum,
    manifestDigest: nativeRootDigest(input.manifest),
    manifestSchema: 2,
    packageSchema: pkg?.schemaVersion ?? null,
    packageChecksum: pkg?.checksum ?? null,
    declaredGeneration: pkg?.runtimeManifest.distributionGeneration ?? null,
    capabilitySnapshotDigest: nativeRootDigest({
      capabilities: manifest.capabilities,
      bindings: manifest.capabilityBindings,
      securityPolicy: manifest.securityPolicy,
      skills,
    }),
  });
  return { source, sourcePolicy: policyFor(source) };
}

const ownerScope = z
  .object({
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
  })
  .strict();
export const CurrentEmployeeChatOriginSchema = z
  .object({
    schemaVersion: z.literal(2),
    contextKind: z.literal('chat'),
    contextId: UuidSchema,
    rootSeed: UuidSchema,
    distributionGeneration: z.literal(newNativeGeneration),
    profileId: z.literal('restricted'),
    artifactId: digest,
    scope: ownerScope,
    birthSource: EmployeeExecutionSourceSchema,
    sourcePolicy: EmployeeExecutionSourcePolicySchema,
  })
  .strict()
  .superRefine((origin, context) => {
    if (
      origin.rootSeed !== origin.contextId ||
      !equal(origin.sourcePolicy, policyFor(origin.birthSource))
    )
      context.addIssue({
        code: 'custom',
        message: 'CURRENT_EMPLOYEE_ORIGIN_INVALID',
      });
  });
export type CurrentEmployeeChatOrigin = z.infer<
  typeof CurrentEmployeeChatOriginSchema
>;
export function readApprovedCurrentEmployeeExecution(): CurrentEmployeeExecutionTuple {
  const artifactId = digest.parse(process.env.ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID);
  const primary = digest.parse(process.env.ALLRICE_DSH_NATIVE_ARTIFACT_ID);
  need(artifactId === primary, 'CURRENT_EMPLOYEE_EXECUTION_APPROVAL_MISMATCH');
  return {
    artifactId,
    generation: newNativeGeneration,
    profileId: 'restricted',
  };
}
export type CurrentEmployeeChatOriginInput = z.infer<typeof ownerScope> & {
  sessionId: string;
  source: EmployeeExecutionSourceInput;
};
/** Only on the first chat INSERT. It never upgrades an existing NULL/v1 row. */
export function newCurrentEmployeeChatOrigin(
  input: CurrentEmployeeChatOriginInput,
): CurrentEmployeeChatOrigin {
  const scope = ownerScope.parse({
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    ownerId: input.ownerId,
  });
  const sessionId = UuidSchema.parse(input.sessionId);
  const { source, sourcePolicy } = validateEmployeeExecutionSource(
    input.source,
  );
  const execution = readApprovedCurrentEmployeeExecution();
  return CurrentEmployeeChatOriginSchema.parse({
    schemaVersion: 2,
    contextKind: 'chat',
    contextId: sessionId,
    rootSeed: sessionId,
    distributionGeneration: execution.generation,
    profileId: execution.profileId,
    artifactId: execution.artifactId,
    scope,
    birthSource: source,
    sourcePolicy,
  });
}
/** Validate immutable birth metadata, not the assignment's current version. */
export function assertCurrentEmployeeChatOrigin(
  value: unknown,
  input: CurrentEmployeeChatOriginInput,
): CurrentEmployeeChatOrigin {
  const origin = CurrentEmployeeChatOriginSchema.parse(value);
  const { source, sourcePolicy } = validateEmployeeExecutionSource(
    input.source,
  );
  need(
    origin.contextId === UuidSchema.parse(input.sessionId) &&
      equal(
        origin.scope,
        ownerScope.parse({
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          ownerId: input.ownerId,
        }),
      ) &&
      equal(origin.birthSource, source) &&
      equal(origin.sourcePolicy, sourcePolicy),
    'CURRENT_EMPLOYEE_ORIGIN_SOURCE_MISMATCH',
  );
  return origin;
}

const runScope = ownerScope
  .extend({ sessionId: UuidSchema, runId: UuidSchema })
  .strict();
export type EmployeeRunExecutionScope = z.infer<typeof runScope>;
export const EmployeeRunExecutionBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('current_employee_execution'),
    scope: runScope,
    originDigest: digest,
    source: EmployeeExecutionSourceSchema,
    execution: CurrentEmployeeExecutionTupleSchema,
    sourcePolicy: EmployeeExecutionSourcePolicySchema,
    executionSnapshotDigest: digest,
    digest,
  })
  .strict()
  .superRefine((binding, context) => {
    const { digest: expected, ...payload } = binding;
    if (
      nativeRootDigest(payload) !== expected ||
      !equal(binding.sourcePolicy, policyFor(binding.source))
    )
      context.addIssue({
        code: 'custom',
        message: 'CURRENT_EMPLOYEE_EXECUTION_BINDING_INVALID',
      });
  });
export type EmployeeRunExecutionBinding = z.infer<
  typeof EmployeeRunExecutionBindingSchema
>;
export type EmployeeRunExecutionBindingInput = {
  origin: unknown;
  scope: EmployeeRunExecutionScope;
  source: EmployeeExecutionSourceInput;
  executionSnapshot: unknown;
};
/** Freeze once inside admission, alongside the unchanged execution_snapshot. */
export function freezeEmployeeRunExecutionBinding(
  input: EmployeeRunExecutionBindingInput,
): EmployeeRunExecutionBinding {
  const scope = runScope.parse(input.scope);
  const origin = CurrentEmployeeChatOriginSchema.parse(input.origin);
  need(
    origin.contextId === scope.sessionId &&
      equal(origin.scope, {
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        ownerId: scope.ownerId,
      }),
    'CURRENT_EMPLOYEE_EXECUTION_SCOPE_MISMATCH',
  );
  const { source, sourcePolicy } = validateEmployeeExecutionSource(
    input.source,
  );
  need(
    sourcePolicy.family === origin.sourcePolicy.family,
    'CURRENT_EMPLOYEE_EXECUTION_FAMILY_MISMATCH',
  );
  const snapshot = EmployeeExecutionSnapshotSchema.parse(
    input.executionSnapshot,
  );
  const definition = EmployeeDefinitionSchema.parse(input.source.manifest);
  need(
    snapshot.schemaVersion === 2 && snapshot.runtimePolicy.harness === 'dsh',
    'CURRENT_EMPLOYEE_EXECUTION_SNAPSHOT_UNSUPPORTED',
  );
  need(
    snapshot.employee.versionId === source.employeeVersionId &&
      snapshot.employee.definitionChecksum === source.configChecksum &&
      snapshot.employee.key === definition.key &&
      equal(snapshot.employee.definition, definition),
    'CURRENT_EMPLOYEE_EXECUTION_SNAPSHOT_SOURCE_MISMATCH',
  );
  need(
    snapshot.assignment.userId === scope.ownerId &&
      snapshot.tenantContext.organizationId === scope.organizationId &&
      snapshot.tenantContext.workspaceId === scope.workspaceId &&
      snapshot.tenantContext.actorId === scope.ownerId &&
      snapshot.capabilitySnapshot.resolvedForActorId === scope.ownerId,
    'CURRENT_EMPLOYEE_EXECUTION_SCOPE_MISMATCH',
  );
  need(
    equal(
      snapshot.capabilitySnapshot.declaredCapabilities,
      definition.capabilities,
    ) &&
      snapshot.capabilitySnapshot.grantedCapabilities.every(
        (capability) =>
          definition.capabilities.includes(capability) &&
          !definition.securityPolicy.deniedCapabilities.includes(capability),
      ),
    'CURRENT_EMPLOYEE_EXECUTION_CAPABILITIES_MISMATCH',
  );
  const payload = {
    schemaVersion: 1 as const,
    kind: 'current_employee_execution' as const,
    scope,
    originDigest: nativeRootDigest(origin),
    source,
    execution: {
      artifactId: origin.artifactId,
      generation: origin.distributionGeneration,
      profileId: origin.profileId,
    },
    sourcePolicy,
    executionSnapshotDigest: nativeRootDigest(input.executionSnapshot),
  };
  return EmployeeRunExecutionBindingSchema.parse({
    ...payload,
    digest: nativeRootDigest(payload),
  });
}
/** Read-only validation of a persisted binding; never invent one for NULL/v1. */
export function assertEmployeeRunExecutionBinding(
  value: unknown,
  input: EmployeeRunExecutionBindingInput,
): EmployeeRunExecutionBinding {
  const binding = EmployeeRunExecutionBindingSchema.parse(value);
  const expected = freezeEmployeeRunExecutionBinding(input);
  need(equal(binding, expected), 'CURRENT_EMPLOYEE_EXECUTION_BINDING_MISMATCH');
  return binding;
}
