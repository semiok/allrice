import { z } from 'zod';

import { UuidSchema } from '../common.ts';
import { ChecksumSchema } from '../runs.ts';
import { ExecutionLocationSchema } from '../execution-choice.ts';

export const localPdfProfileVersionV1 = 1 as const;
export const localPdfInputBytesV1 = 20 * 1024 * 1024;
export const localPdfResultBytesV1 = 400_000;
export const localPdfWireBytesV1 = 512_000;
export const localPdfTimeoutMsV1 = 30_000;
export const localPdfMemoryBudgetBytesV1 = 512 * 1024 * 1024;
/** Known denials before a child exists. Existing attempts are never in this list. */
export const localPdfPreExecutionDenialCodes = Object.freeze([
  'PDF_RESOURCE_CHANGED',
  'PDF_RESOURCE_INTEGRITY_FAILED',
  'PDF_GUARDIAN_INTEGRITY_FAILED',
  'PDF_SOURCE_CHANGED',
  'PDF_INPUT_LIMIT',
  'PDF_EXECUTION_REVOKED',
  'PDF_SOURCE_UNAVAILABLE',
] as const);
const utf8Bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
// The mature reader counts every string value, including duplicate unit text,
// table cells and metadata, against the requested character budget.
function stringCharacters(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value))
    return value.reduce<number>((sum, item) => sum + stringCharacters(item), 0);
  if (typeof value === 'object' && value !== null)
    return Object.values(value).reduce<number>(
      (sum, item) => sum + stringCharacters(item),
      0,
    );
  return 0;
}

/** No defaults: admission preserves the original tool JSON and its digest. */
export const WorkspaceDocumentReadArgsSchema = z
  .object({
    objectId: UuidSchema,
    maxCharacters: z.number().int().min(1_000).max(300_000).optional(),
    includeStructure: z.boolean().optional(),
    pages: z
      .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
      .min(1)
      .max(10)
      .optional(),
    location: ExecutionLocationSchema.optional(),
  })
  .strict();
export type WorkspaceDocumentReadArgs = z.infer<
  typeof WorkspaceDocumentReadArgsSchema
>;

export const RuntimeLocalPdfSourceSchema = z
  .object({
    objectId: UuidSchema,
    checksum: ChecksumSchema,
    sizeBytes: z.number().int().nonnegative().max(localPdfInputBytesV1),
    mediaType: z.string().min(1).max(255),
    artifactVersionId: UuidSchema.optional(),
    artifactVersion: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (v) =>
      (v.artifactVersionId === undefined) === (v.artifactVersion === undefined),
    'artifact version fields must describe the same actual version',
  );
export type RuntimeLocalPdfSource = z.infer<typeof RuntimeLocalPdfSourceSchema>;

export const RuntimeLocalPdfPinsSchema = z
  .object({
    nodeVersion: z.literal('22.23.2'),
    parserVersion: z.literal('2.4.5'),
    pdfJsVersion: z.literal('5.4.296'),
    canvasVersion: z.literal('0.1.80'),
    resourceManifestChecksum: ChecksumSchema,
    policyChecksum: ChecksumSchema,
  })
  .strict();
export type RuntimeLocalPdfPins = z.infer<typeof RuntimeLocalPdfPinsSchema>;

/** A release entry does not prove native readiness: only an actual probe does. */
export const RuntimeLocalPdfProfileSchema = z
  .object({
    contractVersion: z.literal(1),
    profileVersion: z.literal(localPdfProfileVersionV1),
    backend: z.literal('native-seatbelt-v1'),
    platform: z.enum(['macos-x64', 'macos-arm64']),
    pins: RuntimeLocalPdfPinsSchema,
    available: z.boolean(),
    readOnly: z.literal(true),
    ocr: z.literal(false),
    stopConfirmed: z.boolean(),
    isolation: z
      .object({
        network: z.literal('none'),
        hostFileAccess: z.literal('none'),
        childExecution: z.literal('none'),
        memoryEnforcement: z.literal('watchdog'),
        resourceBudgetBytes: z.literal(localPdfMemoryBudgetBytesV1),
        watchdogThresholdBytes: z.literal(localPdfMemoryBudgetBytesV1),
        timeoutMs: z.literal(localPdfTimeoutMsV1),
        deniedHostRead: z.boolean(),
        deniedHostWrite: z.boolean(),
        deniedNetwork: z.boolean(),
        deniedChildExecution: z.boolean(),
      })
      .strict(),
    limits: z
      .object({
        inputBytes: z.literal(localPdfInputBytesV1),
        resultBytes: z.literal(localPdfResultBytesV1),
        maximumPages: z.literal(10),
        maximumCharacters: z.literal(300_000),
      })
      .strict(),
  })
  .strict()
  .refine(
    (v) =>
      !v.available ||
      (v.stopConfirmed &&
        v.isolation.deniedHostRead &&
        v.isolation.deniedHostWrite &&
        v.isolation.deniedNetwork &&
        v.isolation.deniedChildExecution),
    'ready requires observed isolation and physical stop',
  );
export type RuntimeLocalPdfProfile = z.infer<
  typeof RuntimeLocalPdfProfileSchema
>;

const origin = z
  .object({
    toolName: z.literal('workspace.document.read'),
    callId: z.string().min(1).max(255),
    argumentsDigest: ChecksumSchema,
  })
  .strict();
const options = WorkspaceDocumentReadArgsSchema.pick({
  maxCharacters: true,
  includeStructure: true,
  pages: true,
});

/** Fixed parser of authorized bytes. No script, password, module, URL or host path. */
export const RuntimeLocalPdfPayloadSchema = z
  .object({
    capability: z.literal('local.pdf.read'),
    arguments: z
      .object({
        path: z.literal('.'),
        origin,
        source: RuntimeLocalPdfSourceSchema,
        fileName: z.string().min(1).max(1_024),
        options,
        profileVersion: z.literal(localPdfProfileVersionV1),
        pins: RuntimeLocalPdfPinsSchema,
        limits: z
          .object({
            inputBytes: z.literal(localPdfInputBytesV1),
            resultBytes: z.literal(localPdfResultBytesV1),
            timeoutMs: z.literal(localPdfTimeoutMsV1),
            resourceBudgetBytes: z.literal(localPdfMemoryBudgetBytesV1),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type RuntimeLocalPdfPayload = z.infer<
  typeof RuntimeLocalPdfPayloadSchema
>;

/** Matches the shared mature reader's output, without depending on its package. */
export const PdfReadDocumentSchema = z
  .object({
    kind: z.literal('pdf'),
    text: z.string().max(300_000),
    truncated: z.boolean(),
    units: z
      .array(
        z
          .object({
            label: z.string().max(100),
            text: z.string().max(300_000),
            pageNumber: z.number().int().positive(),
          })
          .strict(),
      )
      .max(10),
    warnings: z.array(z.string().max(1_000)).max(16),
    totalPages: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    requestedPages: z.array(z.number().int().positive()).min(1).max(10),
    nextPages: z.array(z.number().int().positive()).max(10),
    quality: z.enum(['digital_text', 'no_extractable_text']),
    warningCodes: z
      .array(
        z.enum([
          'PDF_PAGES_TRUNCATED',
          'PDF_CONTENT_TRUNCATED',
          'PDF_NO_EXTRACTABLE_TEXT',
          'PDF_TABLE_HEURISTIC',
          'PDF_TABLE_NOT_DETECTED',
          'PDF_TABLE_FRAGMENTS_NOT_MERGED',
        ]),
      )
      .max(16),
    parser: z
      .object({ name: z.literal('pdf-parse'), version: z.literal('2.4.5') })
      .strict(),
    tables: z
      .array(
        z
          .object({
            pageNumber: z.number().int().positive(),
            tableNumber: z.number().int().positive(),
            rows: z.array(
              z
                .object({
                  rowNumber: z.number().int().positive(),
                  cells: z.array(z.string()),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .refine(
    (v) => utf8Bytes(v) <= localPdfResultBytesV1,
    'entire PDF result exceeds the UTF-8 budget',
  );

export const RuntimeLocalPdfResultSchema = z
  .object({
    type: z.literal('local_pdf_read_result_v1'),
    origin,
    source: RuntimeLocalPdfSourceSchema,
    profileVersion: z.literal(localPdfProfileVersionV1),
    pins: RuntimeLocalPdfPinsSchema,
    document: PdfReadDocumentSchema.nullable(),
    error: z
      .object({
        code: z.string().min(1).max(100),
        message: z.string().min(1).max(1_000),
      })
      .strict()
      .nullable(),
    process: z
      .object({
        stopped: z.boolean(),
        exitCode: z.number().int().nullable(),
        reason: z.enum([
          'completed',
          'parse_failed',
          'canceled',
          'timeout',
          'memory_limit',
          'output_limit',
          'input_invalid',
          'process_unknown',
        ]),
        memoryEnforcement: z.literal('watchdog'),
        observedPeakRssBytes: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.document !== null &&
      (v.error !== null ||
        !v.process.stopped ||
        v.process.exitCode !== 0 ||
        v.process.reason !== 'completed')
    )
      ctx.addIssue({
        code: 'custom',
        message: 'PDF content requires a physically stopped successful parser',
      });
    if (v.document === null && v.error === null)
      ctx.addIssue({
        code: 'custom',
        message: 'Missing content requires an explicit parser failure',
      });
    if (utf8Bytes(v) > localPdfWireBytesV1)
      ctx.addIssue({
        code: 'custom',
        message: 'Entire PDF envelope exceeds UTF-8 wire budget',
      });
  });
export type RuntimeLocalPdfResult = z.infer<typeof RuntimeLocalPdfResultSchema>;

/** Receipt authority comes from the immutable admitted payload, not the client. */
export function localPdfResultMatchesPayload(
  result: RuntimeLocalPdfResult,
  payload: RuntimeLocalPdfPayload,
) {
  const expected = payload.arguments;
  if (
    result.origin.toolName !== expected.origin.toolName ||
    result.origin.callId !== expected.origin.callId ||
    result.origin.argumentsDigest !== expected.origin.argumentsDigest ||
    result.profileVersion !== expected.profileVersion ||
    Object.keys(expected.pins).some(
      (key) =>
        result.pins[key as keyof RuntimeLocalPdfPins] !==
        expected.pins[key as keyof RuntimeLocalPdfPins],
    ) ||
    Object.keys(expected.source).some(
      (key) =>
        result.source[key as keyof RuntimeLocalPdfSource] !==
        expected.source[key as keyof RuntimeLocalPdfSource],
    ) ||
    Object.keys(result.source).some(
      (key) =>
        expected.source[key as keyof RuntimeLocalPdfSource] !==
        result.source[key as keyof RuntimeLocalPdfSource],
    )
  )
    return false;
  const document = result.document;
  if (!document) return true;
  const requested = expected.options.pages
    ? [...new Set(expected.options.pages)].sort((a, b) => a - b)
    : Array.from(
        { length: Math.min(10, document.totalPages) },
        (_, i) => i + 1,
      );
  if (
    requested.length !== document.requestedPages.length ||
    requested.some(
      (page, i) =>
        page !== document.requestedPages[i] || page > document.totalPages,
    ) ||
    stringCharacters(document) > (expected.options.maxCharacters ?? 120_000) ||
    document.units.some((unit) => !requested.includes(unit.pageNumber)) ||
    new Set(document.units.map((unit) => unit.pageNumber)).size !==
      document.units.length ||
    document.nextPages.some((page) => page > document.totalPages) ||
    (expected.options.includeStructure !== true &&
      document.tables !== undefined) ||
    document.tables?.some((table) => !requested.includes(table.pageNumber))
  )
    return false;
  return true;
}
