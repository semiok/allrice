import { z } from 'zod';

/** Selection by suffix; callers still verify the actual bytes for parsing. */
export function localFileMediaType(path: string): string {
  const types: Record<string, string> = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    zip: 'application/zip',
  };
  return (
    types[path.split('/').at(-1)?.split('.').at(-1)?.toLowerCase() ?? ''] ??
    'application/octet-stream'
  );
}

import { UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import { platformFileMaximumBytes } from './storage.ts';

export const localFileMaximumBytes = platformFileMaximumBytes;
export const LocalFilePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !Array.from(path).some(
        (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
      ) &&
      path
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..'),
    'choose a file inside the authorized folder',
  );
/** Content plus filesystem identity. A moved/replaced file requires a new selection. */
export const LocalFileVersionSchema = z
  .object({
    checksum: ChecksumSchema,
    sizeBytes: z.number().int().min(0).max(localFileMaximumBytes),
    version: ChecksumSchema,
    mediaType: z.string().min(1).max(255),
  })
  .strict();
export type LocalFileVersion = z.infer<typeof LocalFileVersionSchema>;

export const LocalFileObjectSchema = z
  .object({
    objectId: UuidSchema,
    checksum: ChecksumSchema,
    sizeBytes: z.number().int().min(0).max(localFileMaximumBytes),
    mediaType: z.string().min(1).max(255),
    fileName: z.string().min(1).max(255),
    deliverableVersionId: UuidSchema.nullable().default(null),
    deliverableVersion: z.number().int().positive().nullable().default(null),
  })
  .strict();
export type LocalFileObject = z.infer<typeof LocalFileObjectSchema>;

export const LocalFileToolArguments = {
  'local.file.inspect': z.object({ path: LocalFilePathSchema }).strict(),
  'local.file.import': z
    .object({ path: LocalFilePathSchema, expected: LocalFileVersionSchema })
    .strict(),
  'local.file.save': z
    .object({
      path: LocalFilePathSchema,
      objectId: UuidSchema,
      checksum: ChecksumSchema,
    })
    .strict(),
  'local.file.open': z
    .object({ path: LocalFilePathSchema, expected: LocalFileVersionSchema })
    .strict(),
  'local.file.reveal': z
    .object({ path: LocalFilePathSchema, expected: LocalFileVersionSchema })
    .strict(),
} as const;
export const localFileCapabilities = [
  'local.file.inspect',
  'local.file.import',
  'local.file.save',
  'local.file.open',
  'local.file.reveal',
  'local.file.select',
] as const;

/** Bytes travel on authenticated streams, never in a tool argument or receipt. */
export const LocalFilePayloadSchema = z.discriminatedUnion('capability', [
  z
    .object({
      capability: z.literal('local.file.inspect'),
      arguments: LocalFileToolArguments['local.file.inspect'],
    })
    .strict(),
  z
    .object({
      capability: z.literal('local.file.import'),
      arguments: LocalFileToolArguments['local.file.import']
        .extend({ object: LocalFileObjectSchema })
        .strict(),
    })
    .strict(),
  z
    .object({
      capability: z.literal('local.file.save'),
      arguments: z
        .object({ path: LocalFilePathSchema, object: LocalFileObjectSchema })
        .strict(),
    })
    .strict(),
  z
    .object({
      capability: z.literal('local.file.open'),
      arguments: LocalFileToolArguments['local.file.open'],
    })
    .strict(),
  z
    .object({
      capability: z.literal('local.file.reveal'),
      arguments: LocalFileToolArguments['local.file.reveal'],
    })
    .strict(),
  // A direct user gesture opens the native picker; selected bytes are uploaded only after its confirmation.
  z
    .object({
      capability: z.literal('local.file.select'),
      arguments: z
        .object({ path: z.literal('.'), objectId: UuidSchema })
        .strict(),
    })
    .strict(),
]);
export type LocalFilePayload = z.infer<typeof LocalFilePayloadSchema>;

export const LocalFileResultSchema = z
  .object({
    contractVersion: z.literal(1),
    status: z.enum(['inspected', 'uploaded', 'saved', 'opened', 'revealed']),
    path: LocalFilePathSchema,
    file: LocalFileVersionSchema,
    object: LocalFileObjectSchema.nullable(),
    platformUploaded: z.boolean(),
    localSaved: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.platformUploaded !== (value.status === 'uploaded') ||
      value.localSaved !== (value.status === 'saved') ||
      (value.status === 'uploaded' &&
        (!value.platformUploaded || !value.object)) ||
      (value.status === 'saved' && (!value.localSaved || !value.object)) ||
      (value.object &&
        (value.file.checksum !== value.object.checksum ||
          value.file.sizeBytes !== value.object.sizeBytes))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'file result must match actual bytes and destination evidence',
      });
  });
export type LocalFileResult = z.infer<typeof LocalFileResultSchema>;

/** A factual receipt cannot describe another action, input version or object. */
export function localFileResultMatchesPayload(
  payload: LocalFilePayload,
  output: LocalFileResult,
) {
  const statuses = {
    'local.file.inspect': 'inspected',
    'local.file.import': 'uploaded',
    'local.file.select': 'uploaded',
    'local.file.save': 'saved',
    'local.file.open': 'opened',
    'local.file.reveal': 'revealed',
  } as const;
  if (
    output.status !== statuses[payload.capability] ||
    (payload.capability !== 'local.file.select' &&
      output.path !== payload.arguments.path)
  )
    return false;
  if (
    'expected' in payload.arguments &&
    Object.entries(payload.arguments.expected).some(
      ([key, value]) => output.file[key as keyof LocalFileVersion] !== value,
    )
  )
    return false;
  if (
    'object' in payload.arguments &&
    Object.entries(payload.arguments.object).some(
      ([key, value]) => output.object?.[key as keyof LocalFileObject] !== value,
    )
  )
    return false;
  if (
    payload.capability === 'local.file.select' &&
    output.object?.objectId !== payload.arguments.objectId
  )
    return false;
  return (
    !['inspected', 'opened', 'revealed'].includes(output.status) ||
    output.object === null
  );
}

export const LocalFileUserRequestSchema = z
  .object({
    workspaceId: UuidSchema,
    deviceId: UuidSchema,
    folderGrantId: UuidSchema,
    idempotencyKey: UuidSchema,
    sessionId: UuidSchema.nullable().default(null),
    action: z.enum(['select', 'inspect', 'import', 'save', 'open', 'reveal']),
    path: LocalFilePathSchema.optional(),
    expected: LocalFileVersionSchema.optional(),
    objectId: UuidSchema.optional(),
    checksum: ChecksumSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      (v.action !== 'select' && !v.path) ||
      (['import', 'open', 'reveal'].includes(v.action) && !v.expected) ||
      (v.action === 'save' && (!v.objectId || !v.checksum))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'select the exact file version before this action',
      });
  });
