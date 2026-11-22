import { z } from 'zod';
import {
  ReferenceActionSchema,
  ReferenceInputSelectionResultSchema,
  ReferenceLibraryOptionsSchema,
  ReferencePublicationActionSchema,
  ReferencePublicationQueryResultSchema,
  ReferencePublicationQuerySchema,
  ReferencePublishInputSchema,
  ReferenceRevisionSchema,
  ReferenceSaveResultSchema,
  UuidSchema,
  WorkbenchDeliverablesFilterSchema,
  WorkbenchFileFavoriteSchema,
  WorkbenchFileUploadSchema,
} from '@allrice/contracts';
import { WorkbenchDeliverablesActionsCatalogSchema } from './workbench-file-actions';
import { parseArtifactPreview } from './workbench-model';

/** Browser display projections already used by the existing panels. These do
 * not issue identity, module qualification or resource access. */
export const MaterialsCatalogSchema =
  ReferencePublicationQueryResultSchema.extend({
    viewerId: UuidSchema,
    options: ReferenceLibraryOptionsSchema,
  });
export const PublicationOptionsResultSchema = z.object({
  viewerId: UuidSchema,
  options: ReferenceLibraryOptionsSchema,
});
export const FileFavoriteResultSchema = z.object({
  viewerId: UuidSchema,
  objectId: UuidSchema,
  favorite: z.boolean(),
});
const workspace = z.object({ workspaceId: UuidSchema }).strict();
const material = workspace.extend({ revisionId: UuidSchema });
const file = workspace.extend({ objectId: UuidSchema });
const previewPage = {
  source: z.boolean().optional(),
  offset: z.number().int().positive().optional(),
};
const sourceResult = z.object({ sourceId: UuidSchema }).strict();
const uploadResult = z.object({ objectId: UuidSchema }).strict();
const blob = (value: unknown): Blob => {
  if (!(value instanceof Blob)) throw Error('文件下载失败，请重试。');
  return value;
};
function method<I extends z.ZodType, O>(
  input: I,
  output: (value: unknown) => O,
) {
  return { input, output };
}

/** UI-only seam. The authenticated BFF owner supplies implementations. Host
 * RequestContext, grants, arbitrary URLs and database services are absent. */
const methods = {
  queryMaterials: method(
    workspace.extend({ query: ReferencePublicationQuerySchema }),
    MaterialsCatalogSchema.parse,
  ),
  publicationOptions: method(workspace, PublicationOptionsResultSchema.parse),
  selectMaterial: method(material, ReferenceInputSelectionResultSchema.parse),
  previewMaterial: method(material.extend(previewPage), parseArtifactPreview),
  downloadMaterial: method(material, blob),
  publishFile: method(
    ReferencePublishInputSchema.options[0]!,
    ReferenceSaveResultSchema.parse,
  ),
  publishUpload: method(
    ReferencePublishInputSchema.options[1]!,
    ReferenceSaveResultSchema.parse,
  ),
  changePublication: method(
    z
      .object({ sourceId: UuidSchema, body: ReferencePublicationActionSchema })
      .strict(),
    sourceResult.parse,
  ),
  changeSource: method(
    z.object({ sourceId: UuidSchema, body: ReferenceActionSchema }).strict(),
    sourceResult.parse,
  ),
  listDeliverables: method(
    WorkbenchDeliverablesFilterSchema,
    WorkbenchDeliverablesActionsCatalogSchema.parse,
  ),
  captureReference: method(
    file.extend({ requestId: UuidSchema }),
    z.object({ reference: ReferenceRevisionSchema }).parse,
  ),
  readPreparedReference: method(
    material.extend({ sourceId: UuidSchema }),
    ReferenceRevisionSchema.parse,
  ),
  favorite: method(
    file.extend({ body: WorkbenchFileFavoriteSchema }),
    FileFavoriteResultSchema.parse,
  ),
  previewDeliverable: method(
    file.extend({ ...previewPage, fileName: z.string() }),
    parseArtifactPreview,
  ),
  downloadDeliverable: method(file, blob),
  uploadDeliverable: method(WorkbenchFileUploadSchema, uploadResult.parse),
};
export type EmployeePanelDataMethod = keyof typeof methods;
export type EmployeePanelDataClient = {
  readonly [K in EmployeePanelDataMethod]: (
    input: z.input<(typeof methods)[K]['input']>,
    signal: AbortSignal,
  ) => Promise<ReturnType<(typeof methods)[K]['output']>>;
};
export type EmployeePanelDataHandlers = Partial<{
  [K in EmployeePanelDataMethod]: (
    input: z.output<(typeof methods)[K]['input']>,
    signal: AbortSignal,
  ) => Promise<unknown>;
}>;

export class EmployeePanelDataUnavailableError extends Error {
  constructor(readonly method: EmployeePanelDataMethod) {
    super('资料与文件服务暂未接通，请稍后重试。');
    this.name = 'EmployeePanelDataUnavailableError';
  }
}

/** Missing methods reject; there is deliberately no URL/fetch/default owner.
 * Parsing is a data-shape check, never an authorization decision. */
export function createEmployeePanelDataClient(
  handlers: EmployeePanelDataHandlers,
): EmployeePanelDataClient {
  return Object.fromEntries(
    Object.entries(methods).map(([key, definition]) => {
      const name = key as EmployeePanelDataMethod;
      return [
        name,
        async (input: unknown, signal: AbortSignal) => {
          signal.throwIfAborted();
          const handler = handlers[name] as
            | ((input: unknown, signal: AbortSignal) => Promise<unknown>)
            | undefined;
          if (!handler) throw new EmployeePanelDataUnavailableError(name);
          const value = await handler(definition.input.parse(input), signal);
          signal.throwIfAborted();
          return definition.output(value);
        },
      ];
    }),
  ) as EmployeePanelDataClient;
}

export const unboundEmployeePanelDataClient = createEmployeePanelDataClient({});

/** Download only bytes returned by the bound resource operation. */
export function savePanelDownload(bytes: Blob, fileName: string) {
  const url = URL.createObjectURL(bytes);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a turn to accept the download before releasing its URL.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
