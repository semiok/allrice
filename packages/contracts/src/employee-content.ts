import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import {
  ContentOwnershipSchema,
  ContentAccessDecisionSchema,
} from './content-maintenance.ts';

export const employeeContentLimits = {
  scenes: 16,
  references: 128,
  textEdits: 16,
  textBytes: 32_000,
} as const;

/** A company employee is the existing tenant materialization of a template.
 * Personal configuration belongs to one stable instance, never a shared template. */
export const EmployeeContentTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('employee'), employeeId: UuidSchema }).strict(),
  z.object({ kind: z.literal('instance'), instanceId: UuidSchema }).strict(),
]);
export const EmployeeContentOwnershipSchema = z.discriminatedUnion('scope', [
  ContentOwnershipSchema.options[1],
  ContentOwnershipSchema.options[2],
  ContentOwnershipSchema.options[3],
]);
export const EmployeeContentReferenceSchema = z
  .object({
    sourceKind: z.enum([
      'requirement',
      'procedure',
      'company_rule',
      'knowledge',
      'workflow',
      'experience',
    ]),
    contentId: UuidSchema,
    revisionId: UuidSchema,
    digest: ChecksumSchema,
  })
  .strict();
export type EmployeeContentReference = z.infer<
  typeof EmployeeContentReferenceSchema
>;
export const EmployeeDraftReferenceSchema = z.union([
  EmployeeContentReferenceSchema,
  z
    .object({ sourceKind: z.literal('draft_text'), contentId: UuidSchema })
    .strict(),
]);
const sceneFields = {
  id: UuidSchema,
  name: z.string().trim().min(1).max(100),
  appliesWhen: z.string().trim().min(1).max(1000),
};
const conflictSchema = z
  .object({
    contentIds: z.array(UuidSchema).min(1).max(8),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export const EmployeeContentManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    common: z
      .array(EmployeeContentReferenceSchema)
      .max(employeeContentLimits.references),
    scenes: z
      .array(
        z
          .object({
            ...sceneFields,
            references: z
              .array(EmployeeContentReferenceSchema)
              .max(employeeContentLimits.references),
          })
          .strict(),
      )
      .max(employeeContentLimits.scenes),
    declaredConflicts: z.array(conflictSchema).max(16),
  })
  .strict();
const draftManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    common: z
      .array(EmployeeDraftReferenceSchema)
      .max(employeeContentLimits.references),
    scenes: z
      .array(
        z
          .object({
            ...sceneFields,
            references: z
              .array(EmployeeDraftReferenceSchema)
              .max(employeeContentLimits.references),
          })
          .strict(),
      )
      .max(employeeContentLimits.scenes),
    declaredConflicts: z.array(conflictSchema).max(16),
  })
  .strict();
export const EmployeeContentTextSchema = z
  .object({
    kind: z.enum(['requirement', 'procedure']),
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(8000),
  })
  .strict();
const textEditSchema = EmployeeContentTextSchema.extend({
  contentId: UuidSchema,
  revisionId: UuidSchema,
  expectedRevision: z.number().int().nonnegative(),
});
const mutationFields = {
  workspaceId: UuidSchema,
  setId: UuidSchema,
  ownership: EmployeeContentOwnershipSchema,
  target: EmployeeContentTargetSchema,
  requestId: UuidSchema,
  expectedRevision: z.number().int().nonnegative(),
  changeSummary: z.string().trim().min(1).max(1000),
};
export const EmployeeContentMutationSchema = z
  .discriminatedUnion('operation', [
    z
      .object({
        ...mutationFields,
        operation: z.literal('save_draft'),
        manifest: draftManifestSchema,
        textEdits: z.array(textEditSchema).max(employeeContentLimits.textEdits),
      })
      .strict(),
    z
      .object({
        ...mutationFields,
        operation: z.enum(['validate', 'activate']),
        candidateRevisionId: UuidSchema,
        candidateDigest: ChecksumSchema,
      })
      .strict(),
  ])
  .superRefine((input, ctx) => {
    if (
      (input.ownership.scope === 'personal') !==
      (input.target.kind === 'instance')
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Personal content must bind an instance; shared content must bind a company employee.',
      });
    if (input.operation !== 'save_draft') return;
    if (
      new Set(input.manifest.scenes.map((s) => s.id)).size !==
      input.manifest.scenes.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Scene identities must be unique.',
      });
    const refs = [
      ...input.manifest.common,
      ...input.manifest.scenes.flatMap((s) => s.references),
    ];
    if (refs.length > employeeContentLimits.references)
      ctx.addIssue({ code: 'custom', message: 'Too many source references.' });
    if (
      new Set(input.textEdits.map((t) => t.contentId)).size !==
        input.textEdits.length ||
      new Set(input.textEdits.map((t) => t.revisionId)).size !==
        input.textEdits.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Text edit identities must be unique.',
      });
    if (
      input.textEdits.some(
        (t) =>
          !refs.some(
            (r) => r.sourceKind === 'draft_text' && r.contentId === t.contentId,
          ),
      ) ||
      refs.some(
        (r) =>
          r.sourceKind === 'draft_text' &&
          !input.textEdits.some((t) => t.contentId === r.contentId),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Each draft text reference must resolve to one included edit.',
      });
    if (
      input.textEdits.reduce(
        (n, t) => n + new TextEncoder().encode(t.body).length,
        0,
      ) > employeeContentLimits.textBytes
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Text edits exceed the content budget.',
      });
  });

export const EmployeeContentIssueSchema = z
  .object({
    code: z.enum([
      'source_unavailable',
      'source_changed',
      'source_scope_mismatch',
      'mandatory_rule_conflict',
      'scene_conflict',
      'declared_conflict',
      'content_budget_exceeded',
    ]),
    contentId: UuidSchema.optional(),
    sceneId: UuidSchema.optional(),
    message: z.string(),
  })
  .strict();
export const EmployeeContentValidationSchema = z
  .object({
    valid: z.boolean(),
    issues: z.array(EmployeeContentIssueSchema),
    dependencyDigest: ChecksumSchema,
    semanticConsistency: z.literal('not_proven'),
  })
  .strict();
const revisionPointerSchema = z
  .object({ id: UuidSchema, digest: ChecksumSchema })
  .strict();
/** Stable receipts contain identifiers and validation results, not source bodies.
 * Detailed reads recheck source authority instead of replaying stale private text. */
export const EmployeeContentReceiptSchema = z
  .object({
    setId: UuidSchema,
    revision: z.number().int().positive(),
    candidate: revisionPointerSchema,
    active: revisionPointerSchema.nullable(),
    validation: EmployeeContentValidationSchema.nullable(),
  })
  .strict();
export const EmployeeContentRevisionSchema = z
  .object({
    id: UuidSchema,
    number: z.number().int().positive(),
    digest: ChecksumSchema,
    manifest: EmployeeContentManifestSchema,
    changeSummary: z.string(),
    createdAt: z.string(),
  })
  .strict();
export const EmployeeContentSetSchema = z
  .object({
    id: UuidSchema,
    workspaceId: UuidSchema,
    ownership: EmployeeContentOwnershipSchema,
    target: EmployeeContentTargetSchema,
    revision: z.number().int().positive(),
    candidate: EmployeeContentRevisionSchema.nullable(),
    active: EmployeeContentRevisionSchema.nullable(),
    validation: EmployeeContentValidationSchema.nullable(),
    access: ContentAccessDecisionSchema,
  })
  .strict();
export const EmployeeResolvedContentSchema = z
  .object({
    reference: EmployeeContentReferenceSchema,
    available: z.boolean(),
    title: z.string().optional(),
    body: z.string().optional(),
    ownership: ContentOwnershipSchema.nullable(),
    canMaintain: z.boolean(),
  })
  .strict();
export const EmployeeEffectiveContentSchema = z
  .object({
    instanceId: UuidSchema,
    employeeId: UuidSchema,
    platform: z
      .object({
        revisionId: UuidSchema.nullable(),
        digest: ChecksumSchema,
        requirements: z.array(z.string()),
      })
      .strict(),
    layers: z.array(EmployeeContentSetSchema),
    common: z.array(EmployeeContentReferenceSchema),
    scenes: z.array(
      z
        .object({
          ...sceneFields,
          references: z.array(EmployeeContentReferenceSchema),
        })
        .strict(),
    ),
    sources: z.array(EmployeeResolvedContentSchema),
    validation: EmployeeContentValidationSchema,
  })
  .strict();
export type EmployeeContentMutation = z.infer<
  typeof EmployeeContentMutationSchema
>;
export type EmployeeContentManifest = z.infer<
  typeof EmployeeContentManifestSchema
>;
export type EmployeeContentSet = z.infer<typeof EmployeeContentSetSchema>;
export type EmployeeContentReceipt = z.infer<
  typeof EmployeeContentReceiptSchema
>;
export type EmployeeContentValidation = z.infer<
  typeof EmployeeContentValidationSchema
>;
export type EmployeeContentIssue = z.infer<typeof EmployeeContentIssueSchema>;
export type EmployeeResolvedContent = z.infer<
  typeof EmployeeResolvedContentSchema
>;
export type EmployeeEffectiveContent = z.infer<
  typeof EmployeeEffectiveContentSchema
>;
