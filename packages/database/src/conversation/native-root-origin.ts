import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EmployeeRuntimePackageSchema, UuidSchema } from '@allrice/contracts';

export const newNativeGeneration = 'dsh-0.2.1-rc.2-687f282' as const;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const NativeRootOriginSchema = z
  .object({
    schemaVersion: z.literal(1),
    contextKind: z.enum([
      'chat',
      'platform_technical',
      'experience_consolidation',
      'platform_employee_test',
    ]),
    contextId: UuidSchema,
    rootSeed: z.string().min(1).max(100),
    distributionGeneration: z.literal(newNativeGeneration),
    profileId: z.enum(['restricted', 'technical']),
    artifactId: digest,
    frozenIdentity: z
      .object({
        kind: z.enum(['employee_package', 'internal_recipe']),
        checksum: digest,
        sourceId: UuidSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((origin, ctx) => {
    if (
      origin.contextKind === 'chat' &&
      (origin.frozenIdentity.kind !== 'employee_package' ||
        !origin.frozenIdentity.sourceId)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Chat birth requires its immutable published version',
      });
  });
export type NativeRootOrigin = z.infer<typeof NativeRootOriginSchema>;
type Kind = NativeRootOrigin['contextKind'];
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
export const nativeRootSeed = (kind: Kind, id: string) =>
  kind === 'experience_consolidation'
    ? `experience-${UuidSchema.parse(id)}`
    : UuidSchema.parse(id);
function issue(
  kind: Kind,
  id: string,
  frozenIdentity: NativeRootOrigin['frozenIdentity'],
): NativeRootOrigin {
  // This independently configured ID is not derived from a local manifest,
  // current catalog, timestamp, worker version, model or browser input.
  const artifactId = digest.parse(process.env.ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID);
  return NativeRootOriginSchema.parse({
    schemaVersion: 1,
    contextKind: kind,
    contextId: id,
    rootSeed: nativeRootSeed(kind, id),
    distributionGeneration: newNativeGeneration,
    profileId: kind === 'platform_technical' ? 'technical' : 'restricted',
    artifactId,
    frozenIdentity,
  });
}
/** Called only in the first business INSERT transaction; never on claim,
 * cache miss, retry, content-generation creation or a worker's first bind. */
export function newEmployeeNativeRootOrigin(
  kind: 'chat' | 'platform_employee_test',
  id: string,
  runtimePackage: unknown,
  employeeVersionId?: string,
): NativeRootOrigin | null {
  if (runtimePackage == null) return null;
  const value = EmployeeRuntimePackageSchema.parse(runtimePackage);
  if (value.runtimeManifest.distributionGeneration !== newNativeGeneration)
    return null;
  return issue(kind, id, {
    kind: 'employee_package',
    checksum: value.checksum,
    ...(kind === 'chat'
      ? { sourceId: UuidSchema.parse(employeeVersionId) }
      : {}),
  });
}
export function newInternalNativeRootOrigin(
  kind: 'platform_technical' | 'experience_consolidation',
  id: string,
  recipe: unknown,
): NativeRootOrigin | null {
  if (!process.env.ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID) return null;
  return issue(kind, id, {
    kind: 'internal_recipe',
    checksum: nativeRootDigest(recipe),
  });
}
/** Explicit retry inherits its source engine, including NULL legacy choice.
 * It receives a new stable test identity, not a new deployment decision. */
export function retryNativeRootOrigin(
  source: unknown,
  id: string,
): NativeRootOrigin | null {
  if (source == null) return null;
  const origin = NativeRootOriginSchema.parse(source);
  if (origin.contextKind !== 'platform_employee_test')
    throw Error('NATIVE_ROOT_ORIGIN_INVALID');
  return {
    ...origin,
    contextId: UuidSchema.parse(id),
    rootSeed: nativeRootSeed('platform_employee_test', id),
  };
}
export function assertNativeRootOrigin(
  value: unknown,
  kind: Kind,
  id: string,
  frozenIdentity: NativeRootOrigin['frozenIdentity'],
): NativeRootOrigin | null {
  if (value == null) return null;
  const origin = NativeRootOriginSchema.parse(value);
  if (
    origin.contextKind !== kind ||
    origin.contextId !== id ||
    origin.rootSeed !== nativeRootSeed(kind, id) ||
    origin.profileId !==
      (kind === 'platform_technical' ? 'technical' : 'restricted') ||
    origin.frozenIdentity.kind !== frozenIdentity.kind ||
    origin.frozenIdentity.checksum !== frozenIdentity.checksum ||
    origin.frozenIdentity.sourceId !== frozenIdentity.sourceId
  )
    throw Error('NATIVE_ROOT_ORIGIN_INVALID');
  return origin;
}
