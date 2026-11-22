import { z } from 'zod';
import type { RequestContext } from './authorization.ts';
import { UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import {
  ArtifactSourceFileSchema,
  WorkbenchArtifactSchema,
  WorkbenchCursorSchema,
} from './runtime-v2/artifact-review.ts';
import {
  WorkbenchDeliverablesCatalogSchema,
  WorkbenchDeliverablesFilterSchema,
  WorkbenchFileFavoriteSchema,
  WorkbenchFileUploadSchema,
} from './workbench-files.ts';

/** Existing workspace.file.read bounds, now shared with the business Port.
 * These are UTF-16 offsets and UTF-8 source bytes, not an instructions budget. */
export const deliverableReadPolicy = {
  maximumBytes: 2_000_000,
  maximumOffset: 2_000_000,
  pageCharacters: 4_000,
} as const;

export const DeliverableReadInputProjectionSchema =
  ArtifactSourceFileSchema.extend({
    offset: z
      .number()
      .int()
      .min(0)
      .max(deliverableReadPolicy.maximumOffset)
      .default(0),
    limit: z
      .number()
      .int()
      .min(1)
      .max(deliverableReadPolicy.pageCharacters)
      .default(deliverableReadPolicy.pageCharacters),
  });
export const DeliverableReadMcpProjectionSchema = z
  .object({
    id: UuidSchema,
    checksum: ChecksumSchema,
    downloadUrl: z.string(),
    fileName: z.string(),
    mediaType: z.string(),
    content: z.string(),
    offset: z.number().int().nonnegative(),
    totalCharacters: z.number().int().nonnegative(),
    truncated: z.boolean(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();
export const DeliverableFavoriteCommandProjectionSchema = z
  .object({
    target: z.object({ objectId: UuidSchema }).strict(),
    body: WorkbenchFileFavoriteSchema,
  })
  .strict();
export const DeliverableFavoriteResultProjectionSchema = z
  .object({
    viewerId: UuidSchema,
    objectId: UuidSchema,
    favorite: z.boolean(),
  })
  .strict();
export const DeliverableUploadResultProjectionSchema = z
  .object({ objectId: UuidSchema })
  .strict();
export const DeliverableObjectQueryProjectionSchema = z
  .object({ objectId: UuidSchema })
  .strict();
export const DeliverableArtifactQueryProjectionSchema = z
  .object({
    workspaceId: UuidSchema,
    sessionId: UuidSchema,
    before: WorkbenchCursorSchema.optional(),
  })
  .strict();
export const DeliverableArtifactIdentityProjectionSchema = z
  .object({
    workspaceId: UuidSchema,
    sessionId: UuidSchema,
    artifactId: UuidSchema,
  })
  .strict();
export const DeliverableArtifactListProjectionSchema = z
  .object({
    artifacts: z.array(WorkbenchArtifactSchema),
    nextCursor: WorkbenchCursorSchema.nullable(),
  })
  .strict();

/** Host-only, current-authority resource. No storage key, host path or grant.
 * open rechecks current access; its stream checks size/checksum at EOF. A
 * consumer must finish verification before treating the bytes as a copy. */
export interface AuthorizedDeliverableResource {
  source: z.infer<typeof ArtifactSourceFileSchema>;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  open(signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

/** API v1 subset implemented by the business owner. No file history, parent
 * selection, replacement, synchronization, sharing or archive method. */
export interface DeliverablesPort {
  list(
    context: RequestContext,
    input: z.input<typeof WorkbenchDeliverablesFilterSchema>,
    signal: AbortSignal,
  ): Promise<z.infer<typeof WorkbenchDeliverablesCatalogSchema>>;
  upload(
    context: RequestContext,
    input: z.input<typeof WorkbenchFileUploadSchema>,
    signal: AbortSignal,
  ): Promise<z.infer<typeof DeliverableUploadResultProjectionSchema>>;
  favorite(
    context: RequestContext,
    input: z.input<typeof DeliverableFavoriteCommandProjectionSchema>,
    signal: AbortSignal,
  ): Promise<z.infer<typeof DeliverableFavoriteResultProjectionSchema>>;
  listSessionArtifacts(
    context: RequestContext,
    input: z.input<typeof DeliverableArtifactQueryProjectionSchema>,
    signal: AbortSignal,
  ): Promise<z.infer<typeof DeliverableArtifactListProjectionSchema>>;
  getArtifact(
    context: RequestContext,
    input: z.input<typeof DeliverableArtifactIdentityProjectionSchema>,
    signal: AbortSignal,
  ): Promise<z.infer<typeof WorkbenchArtifactSchema>>;
  authorizedResource(
    context: RequestContext,
    input: z.input<typeof ArtifactSourceFileSchema>,
    signal: AbortSignal,
  ): Promise<AuthorizedDeliverableResource>;
  download(
    context: RequestContext,
    input: z.input<typeof DeliverableObjectQueryProjectionSchema>,
    signal: AbortSignal,
  ): Promise<AuthorizedDeliverableResource>;
  readExact(
    context: RequestContext,
    input: z.input<typeof DeliverableReadInputProjectionSchema>,
    signal: AbortSignal,
  ): Promise<z.infer<typeof DeliverableReadMcpProjectionSchema>>;
}
