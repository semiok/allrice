import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import {
  LocalFilePathSchema,
  LocalFileVersionSchema,
  LocalFileObjectSchema,
  localFileMaximumBytes,
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
export const FileDerivationRequestSchema = z.discriminatedUnion('kind', [
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
        message: 'ZIP input total exceeds the bounded archive size',
      });
    if (v.request.kind !== 'zip_pack' && v.inputs.length !== 1)
      ctx.addIssue({
        code: 'custom',
        message: 'choose one ZIP for listing or extraction',
      });
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
  })
  .strict()
  .refine((v) => (v.status === 'listed') === (v.object === null));
export type FileDerivationResult = z.infer<typeof FileDerivationResultSchema>;
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
  return request.kind === 'zip_list'
    ? result.status === 'listed' && result.object === null
    : result.status === 'derived' &&
        result.entries.length === 0 &&
        result.object?.objectId === payload.outputObjectId &&
        result.object.fileName === request.fileName &&
        result.object.mediaType ===
          (request.kind === 'zip_pack'
            ? 'application/zip'
            : 'application/octet-stream');
}
