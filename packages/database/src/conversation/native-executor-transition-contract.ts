import { posix } from 'node:path';
import { z } from 'zod';
import { UuidSchema } from '@allrice/contracts';
import { nativeRootDigest } from './native-identity-digest.ts';
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ExecutorTransitionScopeSchema = z
  .object({
    contextKind: z.literal('chat'),
    contextId: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
  })
  .strict();
export type ExecutorTransitionScope = z.infer<
  typeof ExecutorTransitionScopeSchema
>;
const tuple = z
  .object({
    artifactId: digest,
    generation: z.literal('dsh-0.2.1-rc.2-687f282'),
    profileId: z.literal('restricted'),
  })
  .strict();
const namespace = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) => posix.isAbsolute(p) && posix.normalize(p) === p && !p.includes('\0'),
  );
export const ExecutorTransitionRefSchema = z
  .object({
    requestId: UuidSchema,
    sequence: integer.refine((x) => x > 0),
    digest,
    scope: ExecutorTransitionScopeSchema,
    originDigest: digest,
    target: tuple,
    storageNamespace: namespace,
  })
  .strict()
  .superRefine((r, c) => {
    if (
      !r.storageNamespace.endsWith(
        `/${r.scope.organizationId}/${r.scope.workspaceId}/${r.scope.ownerId}/${r.scope.contextId}/sessions`,
      )
    )
      c.addIssue({
        code: 'custom',
        message: 'EXECUTOR_TRANSITION_NAMESPACE_INVALID',
      });
  });
export type ExecutorTransitionRef = z.infer<typeof ExecutorTransitionRefSchema>;
export const ExecutorTransitionReceiptSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    kind: z.literal('chat-executor-transition'),
    requestId: UuidSchema,
    sequence: integer.refine((x) => x > 0),
    previousDigest: digest.nullable(),
    scope: ExecutorTransitionScopeSchema,
    originDigest: digest,
    from: tuple.extend({
      generation: z.enum(['dsh-0.2.1-rc.2-687f282', 'dsh-0.1.5-rc.3-a4c74a9']),
    }),
    target: tuple,
    storageNamespace: namespace,
    factsDigest: digest,
    facts: z.record(z.string(), z.unknown()),
    approvalDigest: digest,
    historyEvidenceDigest: digest,
    closeEvidenceDigest: digest,
    appliedAt: z.iso.datetime(),
    // Only first transition may explicitly adopt a NULL-origin, unpinned legacy
    // root. The original origin/Run/pin remains unchanged. This is execution
    // identity, not a claim that the original chat was born on the new code.
    adoption: z
      .object({
        kind: z.literal('null-origin-legacy-v1'),
        originalOrigin: z.null(),
        effectiveOrigin: z.record(z.string(), z.unknown()),
        sourceVersionId: UuidSchema,
        sourceManifestDigest: digest,
        sourceNamespace: namespace,
        sourceByteFactsDigest: digest,
        conversionEvidenceDigest: digest,
        nativeSessionIds: z
          .array(z.string().regex(/^dsh-[a-zA-Z0-9._:-]+$/))
          .min(1),
      })
      .strict()
      .optional(),
    digest,
  })
  .strict()
  .superRefine((r, c) => {
    const { digest: expected, ...payload } = r;
    if (
      nativeRootDigest(payload) !== expected ||
      nativeRootDigest(r.facts) !== r.factsDigest ||
      r.from.artifactId === r.target.artifactId ||
      (r.sequence === 1) !== (r.previousDigest === null)
    )
      c.addIssue({
        code: 'custom',
        message: 'EXECUTOR_TRANSITION_RECEIPT_INVALID',
      });
    if (
      r.schemaVersion === 2
        ? !r.adoption ||
          r.sequence !== 1 ||
          r.previousDigest !== null ||
          r.from.generation !== 'dsh-0.1.5-rc.3-a4c74a9' ||
          r.facts.origin !== null ||
          !Array.isArray(r.facts.bindings) ||
          r.facts.bindings.length !== 0 ||
          nativeRootDigest(r.adoption.effectiveOrigin) !== r.originDigest ||
          r.adoption.sourceNamespace === r.storageNamespace ||
          r.adoption.sourceVersionId !== r.facts.sourceVersionId ||
          new Set(r.adoption.nativeSessionIds).size !==
            r.adoption.nativeSessionIds.length
        : r.adoption !== undefined || r.from.generation !== r.target.generation
    ) {
      c.addIssue({
        code: 'custom',
        message: 'EXECUTOR_ADOPTION_SHAPE_INVALID',
      });
    }
    const checked = ExecutorTransitionRefSchema.safeParse({
      requestId: r.requestId,
      sequence: r.sequence,
      digest: r.digest,
      scope: r.scope,
      originDigest: r.originDigest,
      target: r.target,
      storageNamespace: r.storageNamespace,
    });
    if (!checked.success)
      c.addIssue({
        code: 'custom',
        message: 'EXECUTOR_TRANSITION_SCOPE_INVALID',
      });
  });
export type ExecutorTransitionReceipt = z.infer<
  typeof ExecutorTransitionReceiptSchema
>;
export function executorTransitionRef(value: unknown): ExecutorTransitionRef {
  const r = ExecutorTransitionReceiptSchema.parse(value);
  return ExecutorTransitionRefSchema.parse({
    requestId: r.requestId,
    sequence: r.sequence,
    digest: r.digest,
    scope: r.scope,
    originDigest: r.originDigest,
    target: r.target,
    storageNamespace: r.storageNamespace,
  });
}
/** Comparing a descriptor is not registry approval. The Worker still resolves
 * the exact target via its independently measured native artifact registry. */
export function assertTransitionDescriptor(
  ref: ExecutorTransitionRef,
  d: {
    artifactId: string;
    artifactManifestDigest: string;
    distributionGeneration: string;
    profileId: string;
    storageNamespace: string;
    storageContextKey: string;
  },
) {
  const r = ExecutorTransitionRefSchema.parse(ref);
  if (
    d.artifactId !== r.target.artifactId ||
    d.artifactManifestDigest !== d.artifactId ||
    d.distributionGeneration !== r.target.generation ||
    d.profileId !== r.target.profileId ||
    d.storageNamespace !== r.storageNamespace ||
    d.storageContextKey !== r.scope.contextId
  )
    throw Error('EXECUTOR_TRANSITION_DESCRIPTOR_MISMATCH');
}
