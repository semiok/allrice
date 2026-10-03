import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import {
  LocalFilePathSchema,
  LocalFileVersionSchema,
  LocalFileObjectSchema,
  localFileMaximumBytes,
  localFileMediaType,
} from './local-files.ts';

const outputName = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      LocalFilePathSchema.safeParse(name).success && !name.includes('/'),
    'choose one output filename, not a host path',
  );
const pdfName = outputName.refine((name) =>
  name.toLowerCase().endsWith('.pdf'),
);
const pages = z
  .array(z.number().int().min(1).max(500))
  .min(1)
  .max(500)
  .refine((v) => new Set(v).size === v.length);
const imageFormat = z.enum(['png', 'jpeg', 'webp']);
export const DocumentDerivationRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pdf_merge'), fileName: pdfName }).strict(),
  z
    .object({ kind: z.literal('pdf_extract'), fileName: pdfName, pages })
    .strict(),
  z
    .object({
      kind: z.literal('pdf_rotate'),
      fileName: pdfName,
      degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]),
      pages: pages.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('image_resize'),
      fileName: outputName,
      format: imageFormat,
      width: z.number().int().min(1).max(8192),
      height: z.number().int().min(1).max(8192),
      quality: z.number().min(0.01).max(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('image_format'),
      fileName: outputName,
      format: imageFormat,
      quality: z.number().min(0.01).max(1).optional(),
    })
    .strict(),
]);
export type DocumentDerivationRequest = z.infer<
  typeof DocumentDerivationRequestSchema
>;
export const FileDerivationRequestSchema = z.discriminatedUnion('kind', [
  ...DocumentDerivationRequestSchema.options,
  z
    .object({
      kind: z.literal('zip_pack'),
      fileName: outputName.refine((n) => n.toLowerCase().endsWith('.zip')),
    })
    .strict(),
  z.object({ kind: z.literal('zip_list') }).strict(),
  z
    .object({
      kind: z.literal('zip_extract'),
      entry: LocalFilePathSchema,
      fileName: outputName,
    })
    .strict(),
]);
export const FileDerivationArgumentsSchema = z
  .object({
    path: z.literal('.').default('.'),
    inputs: z
      .array(
        z
          .object({
            path: LocalFilePathSchema,
            expected: LocalFileVersionSchema,
          })
          .strict(),
      )
      .min(1)
      .max(32),
    request: FileDerivationRequestSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      new Set(v.inputs.map((i) => i.path.normalize('NFC').toLowerCase()))
        .size !== v.inputs.length
    )
      ctx.addIssue({ code: 'custom', message: 'duplicate input paths' });
    if (
      v.inputs.reduce((n, i) => n + i.expected.sizeBytes, 0) >
      localFileMaximumBytes
    )
      ctx.addIssue({
        code: 'custom',
        message: 'input total exceeds the bounded file size',
      });
    if (
      !['zip_pack', 'pdf_merge'].includes(v.request.kind) &&
      v.inputs.length !== 1
    )
      ctx.addIssue({
        code: 'custom',
        message: 'choose one source except for ZIP packing or PDF merging',
      });
    if (
      v.request.kind === 'image_resize' &&
      v.request.width * v.request.height > 16_000_000
    )
      ctx.addIssue({ code: 'custom', message: 'image exceeds 16 megapixels' });
    if (
      v.request.kind === 'image_resize' ||
      v.request.kind === 'image_format'
    ) {
      const ext = v.request.fileName.toLowerCase().split('.').at(-1);
      if (
        !(v.request.format === 'jpeg'
          ? ext === 'jpg' || ext === 'jpeg'
          : ext === v.request.format)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'filename extension must match image format',
        });
    }
  });
export type FileDerivationArguments = z.infer<
  typeof FileDerivationArgumentsSchema
>;
export const FileDerivationPayloadSchema = z
  .object({
    capability: z.literal('local.file.derive'),
    arguments: FileDerivationArgumentsSchema,
    outputObjectId: UuidSchema.nullable(),
  })
  .strict()
  .refine(
    (v) =>
      (v.arguments.request.kind === 'zip_list') === (v.outputObjectId === null),
    'only a listed archive has no reserved output',
  );
export type FileDerivationPayload = z.infer<typeof FileDerivationPayloadSchema>;
export const FileDerivationContentSchema = z
  .object({
    checksum: ChecksumSchema,
    sizeBytes: z.number().int().min(0).max(localFileMaximumBytes),
    mediaType: z.string().min(1).max(255),
    fileName: outputName,
  })
  .strict();
export const FileDerivationResultSchema = z
  .object({
    contractVersion: z.literal(1),
    status: z.enum(['listed', 'derived']),
    inputs: FileDerivationArgumentsSchema.shape.inputs,
    request: FileDerivationRequestSchema,
    entries: z
      .array(
        z
          .object({
            path: LocalFilePathSchema,
            checksum: ChecksumSchema,
            sizeBytes: z.number().int().min(0).max(localFileMaximumBytes),
          })
          .strict(),
      )
      .max(32),
    object: LocalFileObjectSchema.nullable(),
    processing: z
      .object({
        stopped: z.literal(true),
        reason: z.literal('completed'),
        guardianPid: z.number().int().min(2),
        readerPid: z.number().int().min(2),
        observedPeakRssBytes: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => (v.status === 'listed') === (v.object === null));
export type FileDerivationResult = z.infer<typeof FileDerivationResultSchema>;
export function fileDerivationMediaType(
  request: z.infer<typeof FileDerivationRequestSchema>,
) {
  if (request.kind === 'zip_pack') return 'application/zip';
  if (request.kind.startsWith('pdf_')) return 'application/pdf';
  if (request.kind === 'image_format' || request.kind === 'image_resize')
    return `image/${request.format}`;
  if (request.kind === 'zip_extract')
    return localFileMediaType(request.fileName);
  return 'application/octet-stream';
}
export function fileDerivationResultMatches(
  payload: FileDerivationPayload,
  result: FileDerivationResult,
) {
  if (
    JSON.stringify(result.request) !==
      JSON.stringify(payload.arguments.request) ||
    result.inputs.length !== payload.arguments.inputs.length ||
    result.inputs.some(
      (i, n) =>
        i.path !== payload.arguments.inputs[n]!.path ||
        Object.entries(i.expected).some(
          ([k, v]) =>
            payload.arguments.inputs[n]!.expected[
              k as keyof typeof i.expected
            ] !== v,
        ),
    )
  )
    return false;
  const request = payload.arguments.request;
  if (!request.kind.startsWith('zip_') && !result.processing?.stopped)
    return false;
  return request.kind === 'zip_list'
    ? result.status === 'listed' && result.object === null
    : result.status === 'derived' &&
        result.entries.length === 0 &&
        result.object?.objectId === payload.outputObjectId &&
        result.object.fileName === request.fileName &&
        result.object.mediaType === fileDerivationMediaType(request);
}
