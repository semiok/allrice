import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import { ReferenceSelectionSchema } from './reference-library.ts';

/** v1.8: these bounds govern new reference reads, not ordinary uploads/tools. */
export const referenceImagePolicy = {
  maximumBytes: 20 * 1024 * 1024,
  maximumDimension: 8192,
  maximumPixels: 64_000_000,
  operationMilliseconds: 30_000,
} as const;

export const ReferenceReadImageInputSchema = z
  .object({
    sourceId: UuidSchema,
    revisionId: UuidSchema,
    digest: ChecksumSchema,
    checksum: ChecksumSchema,
  })
  .strict();

/** Wire validation of the public DSH ImageAttachmentRef, including normalized
 * WebP output. The source media admission remains static PNG/JPEG only. */
export const ReferenceImageAttachmentSchema = z
  .object({
    attachmentId: ChecksumSchema,
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    bytes: z.number().int().positive().max(referenceImagePolicy.maximumBytes),
    width: z
      .number()
      .int()
      .positive()
      .max(referenceImagePolicy.maximumDimension),
    height: z
      .number()
      .int()
      .positive()
      .max(referenceImagePolicy.maximumDimension),
    name: z.string().max(255).optional(),
    originalDimensions: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => v.width * v.height <= referenceImagePolicy.maximumPixels);
export type ReferenceImageAttachment = z.infer<
  typeof ReferenceImageAttachmentSchema
>;

export const ReferenceImageCitationSchema = z
  .object({
    type: z.literal('reference'),
    id: UuidSchema,
    label: z.string().min(1).max(200),
    reference: ReferenceSelectionSchema,
    referenceLabel: z.string().regex(/^R[1-9]\d?$/),
    locator: z
      .object({
        kind: z.literal('image'),
        // R4b will add its strict member identity when archive reading ships.
        member: z.null(),
        sourceChecksum: ChecksumSchema,
        image: ReferenceImageAttachmentSchema,
      })
      .strict(),
  })
  .strict();
export type ReferenceImageCitation = z.infer<
  typeof ReferenceImageCitationSchema
>;

export const ReferenceReadImageResultSchema = z
  .object({
    kind: z.literal('image'),
    reference: ReferenceSelectionSchema,
    image: ReferenceImageAttachmentSchema,
    sourceChecksum: ChecksumSchema,
    citation: ReferenceImageCitationSchema,
    receiptId: UuidSchema,
    warnings: z.array(z.string()),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.receiptId !== value.citation.id ||
      value.sourceChecksum !== value.reference.checksum ||
      value.citation.locator.sourceChecksum !== value.sourceChecksum ||
      JSON.stringify(value.citation.reference) !==
        JSON.stringify(value.reference) ||
      JSON.stringify(value.citation.locator.image) !==
        JSON.stringify(value.image)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Image result identities must agree',
      });
  });

export const ReferenceImageBlocksSchema = z.tuple([
  z.object({ type: z.literal('text'), text: z.string().max(12_000) }).strict(),
  z
    .object({
      type: z.literal('image'),
      attachment: ReferenceImageAttachmentSchema,
    })
    .strict(),
]);
export type ReferenceImageBlocks = z.infer<typeof ReferenceImageBlocksSchema>;

export const ReferenceImageCallSchema = z
  .object({
    id: z.string().min(1).max(240),
    name: z.literal('workspace.reference.read_image'),
    nativeSessionId: z.string().min(1).max(240),
  })
  .strict();

export const ReferenceImageErrorSchema = z
  .object({
    code: z.enum([
      'REFERENCE_READ_UNSUPPORTED',
      'REFERENCE_READ_INVALID',
      'REFERENCE_READ_LIMIT',
      'REFERENCE_READ_TIMEOUT',
    ]),
    reason: z.enum([
      'media_type',
      'image_route',
      'image_decode',
      'image_type_mismatch',
      'image_bytes',
      'image_dimensions',
      'image_pixels',
      'native_image_budget',
      'receipt_budget',
      'operation_budget',
    ]),
    message: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();

export type ReferenceReadImageResult = z.infer<
  typeof ReferenceReadImageResultSchema
>;
export type ReferenceImageError = z.infer<typeof ReferenceImageErrorSchema>;
/** Private native/Broker envelope preserves pre-existing fault classifications. */
export const ReferenceImageFailureSchema = z.union([
  ReferenceImageErrorSchema,
  z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean(),
    })
    .strict()
    .refine((value) => !value.code.startsWith('REFERENCE_READ_')),
]);
export const ReferenceImageRouteResultSchema = z.union([
  z.object({ supported: z.literal(true) }).strict(),
  z.object({ error: ReferenceImageErrorSchema }).strict(),
]);
export const ReferenceImageSaveResultSchema = z.union([
  z.object({ image: ReferenceImageAttachmentSchema }).strict(),
  z.object({ error: ReferenceImageErrorSchema }).strict(),
]);
