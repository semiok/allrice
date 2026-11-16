import {
  ReferenceArchiveCallSchema,
  ReferenceArchiveDirectoryCitationSchema,
  ReferenceArchiveTextCitationSchema,
} from './reference-archive.ts';
import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import { KnowledgeCitationSchema } from './knowledge.ts';
import { ReferenceSelectionSchema } from './reference-library.ts';
import {
  ReferenceImageCitationSchema,
  ReferenceImageCallSchema,
} from './reference-image.ts';

/** Evidence of bounded excerpts returned to an authorized execution, not an
 * assertion that the whole file was read or that the model used every excerpt. */
export const ReferenceTextReadSchema = z
  .object({
    receiptId: UuidSchema,
    origin: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('explicit') }).strict(),
      z.object({ kind: z.literal('common') }).strict(),
      z
        .object({
          kind: z.literal('tool'),
          toolName: z.enum([
            'workspace.reference.search',
            'workspace.reference.read',
          ]),
        })
        .strict(),
      z
        .object({
          kind: z.literal('scene'),
          sceneId: UuidSchema,
          sceneDigest: ChecksumSchema,
        })
        .strict(),
    ]),
    citation: KnowledgeCitationSchema.extend({
      reference: ReferenceSelectionSchema,
      referenceLabel: z.string().regex(/^R[1-9]\d?$/),
    }),
    contentChecksum: ChecksumSchema,
    runId: UuidSchema,
    generationId: UuidSchema,
    jobId: UuidSchema,
    workerId: z.string().min(1).max(255),
    readAt: TimestampSchema,
  })
  .strict();
export type ReferenceTextRead = z.infer<typeof ReferenceTextReadSchema>;
export const ReferenceImageReadSchema = ReferenceTextReadSchema.omit({
  origin: true,
  citation: true,
})
  .extend({
    schemaVersion: z.literal(2),
    readKind: z.literal('image'),
    origin: z
      .object({
        kind: z.literal('tool'),
        toolName: z.enum([
          'workspace.reference.read_image',
          'workspace.reference.archive_read',
        ]),
      })
      .strict(),
    call: ReferenceImageCallSchema,
    citation: ReferenceImageCitationSchema,
  })
  .strict()
  .superRefine((read, ctx) => {
    if (
      read.contentChecksum !== read.citation.locator.image.attachmentId ||
      read.citation.locator.sourceChecksum !==
        (read.citation.locator.member?.checksum ??
          read.citation.reference.checksum) ||
      read.origin.toolName !== read.call.name ||
      (read.call.name === 'workspace.reference.read_image'
        ? read.citation.locator.member !== null
        : read.citation.locator.member === null)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Image receipt must retain original and normalized identities',
      });
  });
const archiveReadBase = ReferenceTextReadSchema.omit({
  origin: true,
  citation: true,
})
  .extend({
    schemaVersion: z.literal(2),
    call: ReferenceArchiveCallSchema,
    origin: z
      .object({
        kind: z.literal('tool'),
        toolName: z.enum([
          'workspace.reference.archive_list',
          'workspace.reference.archive_read',
        ]),
      })
      .strict(),
  })
  .strict();
export const ReferenceArchiveReadSchema = z
  .union([
    archiveReadBase
      .extend({
        readKind: z.literal('archive_directory'),
        citation: ReferenceArchiveDirectoryCitationSchema,
      })
      .strict(),
    archiveReadBase
      .extend({
        readKind: z.literal('archive_member_text'),
        citation: ReferenceArchiveTextCitationSchema,
      })
      .strict(),
  ])
  .superRefine((read, ctx) => {
    if (
      read.origin.toolName !== read.call.name ||
      read.call.name !==
        (read.readKind === 'archive_directory'
          ? 'workspace.reference.archive_list'
          : 'workspace.reference.archive_read') ||
      (read.readKind === 'archive_directory' &&
        read.contentChecksum !== read.citation.locator.pageChecksum)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Archive receipt must retain exact read identity',
      });
  });
export const ReferenceReadSchema = z.union([
  ReferenceTextReadSchema,
  ReferenceImageReadSchema,
  ReferenceArchiveReadSchema,
]);
export type ReferenceRead = z.infer<typeof ReferenceReadSchema>;
export const ReferenceReadsSchema = z
  .array(ReferenceReadSchema)
  .max(64)
  .superRefine((reads, ctx) => {
    if (
      new Set(reads.map((r) => r.receiptId)).size !== reads.length ||
      reads.some(
        (r, i) =>
          r.citation.id !== r.receiptId ||
          r.citation.referenceLabel !== `R${i + 1}` ||
          (r.citation.type === 'knowledge' &&
            r.citation.knowledgeRevisionId !==
              r.citation.reference.revisionId) ||
          r.runId !== reads[0]?.runId ||
          r.generationId !== reads[0]?.generationId,
      )
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Reference receipts must retain stable Run identity and labels',
      });
  });
