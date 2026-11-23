import { z } from 'zod';
import {
  DEntrySelectionInputSchema,
  DeliverableFavoriteResultProjectionSchema,
  DeliverableUploadResultProjectionSchema,
  MaterialsActionResultProjectionSchema,
  PanelWriteReceiptQuerySchema,
  PanelWriteReceiptSchema,
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
  type DEntrySelectionInput,
} from '@allrice/contracts';
import { WorkbenchDeliverablesActionsCatalogSchema } from './workbench-file-actions';
import { parseArtifactPreview } from './workbench-model';
import { checkReferenceSelectionFailure } from './reference-selection';

export class EmployeePanelsWriteUnknownError extends Error {
  constructor(
    readonly operation: string,
    readonly requestId: string,
    readonly originalInput: unknown,
    options: ErrorOptions,
  ) {
    super('保存结果未知，请按原请求核对。', options);
    this.name = 'EmployeePanelsWriteUnknownError';
  }
}
export interface EmployeePanelsHttpOptions {
  fetch?: typeof globalThis.fetch;
  expectedViewerId?: string;
  lifetimeSignal?: AbortSignal;
}
const workspace = z.object({ workspaceId: UuidSchema }).strict();
const material = workspace.extend({ revisionId: UuidSchema });
const file = workspace.extend({ objectId: UuidSchema });
const page = {
  source: z.boolean().optional(),
  offset: z.number().int().positive().optional(),
};
const queryInput = workspace.extend({ query: ReferencePublicationQuerySchema });
const materialPreview = material.extend(page);
const catalog = ReferencePublicationQueryResultSchema.extend({
  viewerId: UuidSchema,
  options: ReferenceLibraryOptionsSchema,
});

/** Named fixed routes only. Cookie remains with same-origin fetch. These
 * selectors neither mint identity nor grant native execution/read receipts. */
export function createEmployeePanelsHttpClient(
  selectionInput: DEntrySelectionInput,
  options: EmployeePanelsHttpOptions = {},
) {
  const selection = DEntrySelectionInputSchema.parse(selectionInput);
  const root = `/api/v1/d-entry/panels/${encodeURIComponent(selection.employeeInstanceId)}`;
  const fetcher = options.fetch ?? globalThis.fetch;
  async function call(
    path: string,
    signal: AbortSignal,
    input: { workspaceId: string },
    config: {
      method?: 'POST' | 'PUT';
      body?: unknown;
      query?: Record<string, unknown>;
      revisions?: string[];
      operation?: string;
      requestId?: string;
      blob?: boolean;
    } = {},
  ) {
    if (input.workspaceId !== selection.workspaceId)
      throw Error('文件视图已失效。');
    const active = options.lifetimeSignal
      ? AbortSignal.any([signal, options.lifetimeSignal])
      : signal;
    active.throwIfAborted();
    const query = new URLSearchParams({ workspaceId: selection.workspaceId });
    if (selection.threadId) query.set('threadId', selection.threadId);
    for (const [key, value] of Object.entries(config.query ?? {}))
      if (value !== undefined)
        query.set(
          key,
          typeof value === 'object' ? JSON.stringify(value) : String(value),
        );
    try {
      const response = await fetcher(`${root}${path}?${query}`, {
        method: config.method ?? 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: active,
        headers: {
          ...(config.body === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
          ...(options.expectedViewerId
            ? { 'x-allrice-expected-viewer-id': options.expectedViewerId }
            : {}),
        },
        ...(config.body === undefined
          ? {}
          : { body: JSON.stringify(config.body) }),
      });
      await checkReferenceSelectionFailure(response, config.revisions ?? []);
      if (!response.ok) throw Error(`文件服务请求失败 (${response.status})。`);
      const result: unknown = config.blob
        ? await response.blob()
        : await response.json();
      active.throwIfAborted();
      return result;
    } catch (error) {
      // No automatic replay or new requestId. Caller can only read the original
      // receipt; an absent receipt still does not establish that nothing ran.
      if (config.operation && config.requestId)
        throw new EmployeePanelsWriteUnknownError(
          config.operation,
          config.requestId,
          config.body,
          { cause: error },
        );
      throw error;
    }
  }
  const preview = async (
    value: z.infer<typeof material> | z.infer<typeof file>,
    path: string,
    signal: AbortSignal,
    options: { source?: boolean; offset?: number },
  ) =>
    parseArtifactPreview(
      await call(path, signal, value, {
        query: {
          source:
            options.source === undefined ? undefined : options.source ? 1 : 0,
          offset: options.offset,
        },
      }),
    );
  const download = async (
    value: z.infer<typeof material> | z.infer<typeof file>,
    path: string,
    signal: AbortSignal,
  ) => {
    const result = await call(path, signal, value, { blob: true });
    if (!(result instanceof Blob)) throw Error('文件下载失败。');
    return result;
  };
  return {
    async queryMaterials(
      input: z.input<typeof queryInput>,
      signal: AbortSignal,
    ) {
      const value = queryInput.parse(input);
      return catalog.parse(
        await call('/materials', signal, value, { query: value.query }),
      );
    },
    async publicationOptions(
      input: z.input<typeof workspace>,
      signal: AbortSignal,
    ) {
      const value = workspace.parse(input);
      return z
        .object({
          viewerId: UuidSchema,
          options: ReferenceLibraryOptionsSchema,
        })
        .parse(await call('/materials/options', signal, value));
    },
    async selectMaterial(input: z.input<typeof material>, signal: AbortSignal) {
      const value = material.parse(input);
      return ReferenceInputSelectionResultSchema.parse(
        await call(
          `/materials/revisions/${value.revisionId}/selection`,
          signal,
          value,
          { revisions: [value.revisionId] },
        ),
      );
    },
    async previewMaterial(
      input: z.input<typeof materialPreview>,
      signal: AbortSignal,
    ) {
      const value = materialPreview.parse(input);
      return preview(
        value,
        `/materials/revisions/${value.revisionId}/preview`,
        signal,
        value,
      );
    },
    async downloadMaterial(
      input: z.input<typeof material>,
      signal: AbortSignal,
    ) {
      const value = material.parse(input);
      return download(
        value,
        `/materials/revisions/${value.revisionId}/download`,
        signal,
      );
    },
    async publishFile(
      input: z.input<(typeof ReferencePublishInputSchema.options)[0]>,
      signal: AbortSignal,
    ) {
      const value = ReferencePublishInputSchema.options[0]!.parse(input);
      return ReferenceSaveResultSchema.parse(
        await call('/materials/publications', signal, value, {
          method: 'POST',
          body: value,
          operation: 'publish-file',
          requestId: value.requestId,
        }),
      );
    },
    async publishUpload(
      input: z.input<(typeof ReferencePublishInputSchema.options)[1]>,
      signal: AbortSignal,
    ) {
      const value = ReferencePublishInputSchema.options[1]!.parse(input);
      return ReferenceSaveResultSchema.parse(
        await call('/materials/publications', signal, value, {
          method: 'POST',
          body: value,
          operation: 'publish-upload',
          requestId: value.requestId,
        }),
      );
    },
    async changePublication(
      input: {
        sourceId: string;
        body: z.input<typeof ReferencePublicationActionSchema>;
      },
      signal: AbortSignal,
    ) {
      const value = z
        .object({
          sourceId: UuidSchema,
          body: ReferencePublicationActionSchema,
        })
        .strict()
        .parse(input);
      return MaterialsActionResultProjectionSchema.parse(
        await call(
          `/materials/publications/${value.sourceId}`,
          signal,
          value.body,
          {
            method: 'POST',
            body: value.body,
            operation: 'change-publication',
            requestId: value.body.requestId,
          },
        ),
      );
    },
    async changeSource(
      input: { sourceId: string; body: z.input<typeof ReferenceActionSchema> },
      signal: AbortSignal,
    ) {
      const value = z
        .object({ sourceId: UuidSchema, body: ReferenceActionSchema })
        .strict()
        .parse(input);
      return MaterialsActionResultProjectionSchema.parse(
        await call(`/materials/sources/${value.sourceId}`, signal, value.body, {
          method: 'POST',
          body: value.body,
          operation: 'change-source',
          requestId: value.body.requestId,
        }),
      );
    },
    async listDeliverables(
      input: z.input<typeof WorkbenchDeliverablesFilterSchema>,
      signal: AbortSignal,
    ) {
      const value = WorkbenchDeliverablesFilterSchema.parse(input);
      const { workspaceId, ...query } = value;
      return WorkbenchDeliverablesActionsCatalogSchema.parse(
        await call('/deliverables', signal, { workspaceId }, { query }),
      );
    },
    async captureReference(
      input: { workspaceId: string; objectId: string; requestId: string },
      signal: AbortSignal,
    ) {
      const value = file.extend({ requestId: UuidSchema }).parse(input);
      return z.object({ reference: ReferenceRevisionSchema }).parse(
        await call(`/deliverables/${value.objectId}/reference`, signal, value, {
          method: 'POST',
          body: { requestId: value.requestId },
          operation: 'capture',
          requestId: value.requestId,
        }),
      );
    },
    async readPreparedReference(
      input: { workspaceId: string; sourceId: string; revisionId: string },
      signal: AbortSignal,
    ) {
      const value = material.extend({ sourceId: UuidSchema }).parse(input);
      return ReferenceRevisionSchema.parse(
        await call(`/materials/revisions/${value.revisionId}`, signal, value, {
          query: { sourceId: value.sourceId },
        }),
      );
    },
    async favorite(
      input: {
        workspaceId: string;
        objectId: string;
        body: z.input<typeof WorkbenchFileFavoriteSchema>;
      },
      signal: AbortSignal,
    ) {
      const value = file
        .extend({ body: WorkbenchFileFavoriteSchema })
        .parse(input);
      return DeliverableFavoriteResultProjectionSchema.parse(
        await call(`/deliverables/${value.objectId}/favorite`, signal, value, {
          method: 'PUT',
          body: value.body,
        }),
      );
    },
    async previewDeliverable(
      input: {
        workspaceId: string;
        objectId: string;
        fileName: string;
        source?: boolean;
        offset?: number;
      },
      signal: AbortSignal,
    ) {
      const value = file.extend({ ...page, fileName: z.string() }).parse(input);
      return preview(
        value,
        `/deliverables/${value.objectId}/preview`,
        signal,
        value,
      );
    },
    async downloadDeliverable(
      input: z.input<typeof file>,
      signal: AbortSignal,
    ) {
      const value = file.parse(input);
      return download(
        value,
        `/deliverables/${value.objectId}/download`,
        signal,
      );
    },
    async uploadDeliverable(
      input: z.input<typeof WorkbenchFileUploadSchema>,
      signal: AbortSignal,
    ) {
      const value = WorkbenchFileUploadSchema.parse(input);
      return DeliverableUploadResultProjectionSchema.parse(
        await call('/deliverables', signal, value, {
          method: 'POST',
          body: value,
          operation: 'upload',
          requestId: value.requestId,
        }),
      );
    },
  };
}

/** Auxiliary read only. No result (including unknown) triggers a write. */
export async function readEmployeePanelsWriteReceipt(
  selectionInput: DEntrySelectionInput,
  input: z.input<typeof PanelWriteReceiptQuerySchema>,
  signal: AbortSignal,
  options: EmployeePanelsHttpOptions = {},
) {
  const selection = DEntrySelectionInputSchema.parse(selectionInput),
    value = PanelWriteReceiptQuerySchema.parse(input);
  if (value.workspaceId !== selection.workspaceId)
    throw Error('文件视图已失效。');
  const query = new URLSearchParams({
    workspaceId: value.workspaceId,
    operation: value.operation,
  });
  if (selection.threadId) query.set('threadId', selection.threadId);
  if (value.sourceId) query.set('sourceId', value.sourceId);
  const active = options.lifetimeSignal
    ? AbortSignal.any([signal, options.lifetimeSignal])
    : signal;
  active.throwIfAborted();
  const response = await (options.fetch ?? globalThis.fetch)(
    `/api/v1/d-entry/panels/${selection.employeeInstanceId}/write-receipts/${value.requestId}?${query}`,
    {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: active,
      headers: options.expectedViewerId
        ? { 'x-allrice-expected-viewer-id': options.expectedViewerId }
        : {},
    },
  );
  if (!response.ok) throw Error(`文件请求对账失败 (${response.status})。`);
  const result = PanelWriteReceiptSchema.parse(await response.json());
  active.throwIfAborted();
  if (
    result.operation !== value.operation ||
    result.requestId !== value.requestId
  )
    throw Error('文件请求对账不匹配。');
  return result;
}

export function createEmployeePanelsHttpResolver<T>(
  resolve: (
    nativeSessionId: string,
    snapshot: T,
  ) => { selection: DEntrySelectionInput; viewerId: string } | null,
  lifetimeSignal: AbortSignal,
  options: Pick<EmployeePanelsHttpOptions, 'fetch'> = {},
) {
  return (nativeSessionId: string, snapshot: T) => {
    lifetimeSignal.throwIfAborted();
    const value = resolve(nativeSessionId, snapshot);
    return value
      ? createEmployeePanelsHttpClient(value.selection, {
          ...options,
          expectedViewerId: UuidSchema.parse(value.viewerId),
          lifetimeSignal,
        })
      : null;
  };
}
