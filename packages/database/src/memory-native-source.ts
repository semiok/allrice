/** Memory-owned managed metadata. These persisted locators/proofs are never
 * authority: a pending transition and every issued pin re-read current source
 * permission through the original owner's bound reader. Not a public barrel. */
import {
  AdoptedHumanSourceProjectionSchema,
  EmployeeBusinessScopeProjectionSchema,
  StoredHumanSourceSelectorProjectionSchema,
  UuidSchema,
  type AdoptedHumanSourceProjection,
  type RequestContext,
} from '@allrice/contracts';
import type { Sql, TransactionSql } from 'postgres';
import { z } from 'zod';
import { DataAccessError } from './data.ts';
import {
  requireMemoryRuntimeAssembly,
  type MemoryRuntimeOwnerReads,
} from './memory-runtime-binding.ts';
import type { EmployeeMemoryScope } from './workspace/employee-memory.ts';

export const nativeMemoryMetadataKey = 'allriceEmployeeMemoryV4';
export const NativeMemorySourceSchema =
  StoredHumanSourceSelectorProjectionSchema.extend({
    version: z.literal(1),
    canonicalTool: z.literal('workspace.memory.remember'),
    nativeOwnerRef: z.string().min(1),
    nativeProfileRef: z.string().min(1),
    kind: z.enum(['ordinary-human-message', 'adopted-steering']),
    proof: z
      .object({ version: z.string().min(1), digest: z.string().min(1) })
      .strict(),
  }).strict();
export type NativeMemorySource = z.infer<typeof NativeMemorySourceSchema>;

export function nativeMemorySource(
  metadata: unknown,
): NativeMemorySource | null {
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    !(nativeMemoryMetadataKey in metadata)
  )
    return null;
  return NativeMemorySourceSchema.parse(
    Reflect.get(metadata, nativeMemoryMetadataKey),
  );
}

export function memoryBusinessScope(scope: EmployeeMemoryScope) {
  return EmployeeBusinessScopeProjectionSchema.parse({
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    ownerId: scope.ownerId,
    employeeInstanceId: scope.instanceId,
    employeeId: scope.employeeId,
  });
}
export function sameMemoryBusinessScope(left: unknown, right: unknown) {
  const a = EmployeeBusinessScopeProjectionSchema.parse(left),
    b = EmployeeBusinessScopeProjectionSchema.parse(right);
  return Object.keys(a).every(
    (key) => Reflect.get(a, key) === Reflect.get(b, key),
  );
}

export async function requireStoredNativeMemorySource(
  reads: Pick<MemoryRuntimeOwnerReads, 'storedSource'>,
  scope: EmployeeMemoryScope,
  origin: { source_type: string; source_id: string | null; metadata: unknown },
  signal: AbortSignal,
) {
  const stored = nativeMemorySource(origin.metadata);
  if (!stored) return false;
  if (
    origin.source_type !== 'message' ||
    origin.source_id !== null ||
    !sameMemoryBusinessScope(stored.scope, memoryBusinessScope(scope))
  )
    throw new DataAccessError('authorization_denied');
  const selector = StoredHumanSourceSelectorProjectionSchema.parse({
    scope: stored.scope,
    threadId: stored.threadId,
    b: stored.b,
    executionBoundaryRef: stored.executionBoundaryRef,
    rootOriginRef: stored.rootOriginRef,
    nativeCall: stored.nativeCall,
    sourceRef: stored.sourceRef,
  });
  const current = AdoptedHumanSourceProjectionSchema.parse(
    await reads.storedSource(selector),
  );
  signal.throwIfAborted();
  const currentSelector = StoredHumanSourceSelectorProjectionSchema.parse({
    scope: current.scope,
    threadId: current.threadId,
    b: current.b,
    executionBoundaryRef: current.executionBoundaryRef,
    rootOriginRef: current.rootOriginRef,
    nativeCall: current.nativeCall,
    sourceRef: current.sourceRef,
  });
  if (
    JSON.stringify(currentSelector) !== JSON.stringify(selector) ||
    current.kind !== stored.kind ||
    current.proof.version !== stored.proof.version ||
    current.proof.digest !== stored.proof.digest
  )
    throw new DataAccessError('authorization_denied');
  return true;
}

/** Called only after the original management transaction's identity -> memory
 * order -> source/row admission. Original execution liveness is irrelevant;
 * storedSource must independently prove CURRENT permission to that real source. */
export async function requirePendingNativeMemorySource(
  tx: Sql | TransactionSql,
  context: RequestContext,
  scope: EmployeeMemoryScope,
  origin: { source_type: string; source_id: string | null; metadata?: unknown },
) {
  const stored = nativeMemorySource(origin.metadata);
  if (!stored) return false;
  const signal = new AbortController().signal;
  const assembly = requireMemoryRuntimeAssembly();
  const target = {
    workspaceId: UuidSchema.parse(scope.workspaceId).toLowerCase(),
    employeeInstanceId: UuidSchema.parse(scope.instanceId).toLowerCase(),
    threadId: stored.threadId,
    access: 'management' as const,
    module: { kind: 'not-applicable' as const },
  };
  const reads = await assembly.bind(tx, context, target, signal);
  await requireStoredNativeMemorySource(
    reads,
    scope,
    { ...origin, metadata: origin.metadata },
    signal,
  );
  return true;
}

export function sourceMetadata(
  source: AdoptedHumanSourceProjection,
  original: { nativeOwnerRef: string; nativeProfileRef: string },
) {
  return NativeMemorySourceSchema.parse({
    version: 1,
    canonicalTool: 'workspace.memory.remember',
    nativeOwnerRef: original.nativeOwnerRef,
    nativeProfileRef: original.nativeProfileRef,
    scope: source.scope,
    threadId: source.threadId,
    b: source.b,
    executionBoundaryRef: source.executionBoundaryRef,
    rootOriginRef: source.rootOriginRef,
    nativeCall: source.nativeCall,
    sourceRef: source.sourceRef,
    kind: source.kind,
    proof: source.proof,
  });
}
