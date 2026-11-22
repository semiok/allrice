import { z } from 'zod';
import type { RequestContext } from './authorization.ts';
import { UuidSchema } from './common.ts';
import {
  ReferenceActionSchema,
  ReferenceInputSelectionResultSchema,
  ReferenceLibraryOptionsSchema,
  ReferencePublicationActionSchema,
  ReferencePublishInputSchema,
  ReferenceRevisionSchema,
  ReferenceSaveResultSchema,
  ReferenceUploadInputSchema,
} from './reference-library.ts';
import {
  ReferencePublicationQueryResultSchema,
  ReferencePublicationQuerySchema,
} from './reference-search.ts';

export const MaterialsScopeQueryProjectionSchema = z
  .object({ workspaceId: UuidSchema })
  .strict();
export const MaterialsCurrentListProjectionSchema = z
  .object({
    references: z.array(ReferenceRevisionSchema),
    options: ReferenceLibraryOptionsSchema,
  })
  .strict();
export const MaterialsSelectionQueryProjectionSchema = z
  .object({
    workspaceId: UuidSchema,
    revisionId: UuidSchema,
  })
  .strict();
/** A new file only. Source revision replacement is not a 4.0 public method.
 * Reuse the existing scope/department refinement and defaults. */
export const MaterialsSaveInputProjectionSchema = z
  .object({
    workspaceId: ReferenceUploadInputSchema.shape.workspaceId,
    requestId: ReferenceUploadInputSchema.shape.requestId,
    scope: ReferenceUploadInputSchema.shape.scope,
    departmentId: ReferenceUploadInputSchema.shape.departmentId,
    fileName: ReferenceUploadInputSchema.shape.fileName,
    purpose: ReferenceUploadInputSchema.shape.purpose,
    mediaType: ReferenceUploadInputSchema.shape.mediaType,
    contentBase64: ReferenceUploadInputSchema.shape.contentBase64,
  })
  .strict()
  .superRefine((value, context) => {
    const original = ReferenceUploadInputSchema.safeParse(value);
    if (!original.success)
      for (const issue of original.error.issues)
        context.addIssue({
          code: 'custom',
          message: issue.message,
          path: issue.path,
        });
  });
export const MaterialsUploadPublicationInputProjectionSchema =
  ReferencePublishInputSchema.options[1]!;
export const MaterialsPublicationCommandProjectionSchema = z
  .object({
    target: z.object({ sourceId: UuidSchema }).strict(),
    body: ReferencePublicationActionSchema,
  })
  .strict();
export const MaterialsActionCommandProjectionSchema = z
  .object({
    target: z.object({ sourceId: UuidSchema }).strict(),
    body: ReferenceActionSchema,
  })
  .strict();
export const MaterialsActionResultProjectionSchema = z
  .object({ sourceId: UuidSchema })
  .strict();

/** Implemented owner service subset. No file history/replacement/sync method.
 * MCP receipt, stream/export and file-origin copy dependencies are registered
 * separately when their physical owners supply their public interfaces. */
export interface EnterpriseMaterialsPort {
  listCurrent(
    context: RequestContext,
    input: z.input<typeof MaterialsScopeQueryProjectionSchema>,
    signal: AbortSignal,
  ): Promise<z.infer<typeof MaterialsCurrentListProjectionSchema>>;
  options(
    context: RequestContext,
    input: z.input<typeof MaterialsScopeQueryProjectionSchema>,
    signal: AbortSignal,
  ): Promise<z.infer<typeof ReferenceLibraryOptionsSchema>>;
  query(
    context: RequestContext,
    input: z.input<typeof ReferencePublicationQuerySchema>,
    signal: AbortSignal,
  ): Promise<z.infer<typeof ReferencePublicationQueryResultSchema>>;
  captureSelection(
    context: RequestContext,
    input: z.input<typeof MaterialsSelectionQueryProjectionSchema>,
    signal: AbortSignal,
  ): Promise<z.infer<typeof ReferenceInputSelectionResultSchema>>;
  save(
    context: RequestContext,
    input: z.input<typeof MaterialsSaveInputProjectionSchema>,
    signal: AbortSignal,
  ): Promise<z.infer<typeof ReferenceSaveResultSchema>>;
  publishUpload(
    context: RequestContext,
    input: z.input<typeof MaterialsUploadPublicationInputProjectionSchema>,
    signal: AbortSignal,
  ): Promise<z.infer<typeof ReferenceSaveResultSchema>>;
  changePublication(
    context: RequestContext,
    input: z.input<typeof MaterialsPublicationCommandProjectionSchema>,
    signal: AbortSignal,
  ): Promise<z.infer<typeof MaterialsActionResultProjectionSchema>>;
  changeSource(
    context: RequestContext,
    input: z.input<typeof MaterialsActionCommandProjectionSchema>,
    signal: AbortSignal,
  ): Promise<z.infer<typeof MaterialsActionResultProjectionSchema>>;
}
