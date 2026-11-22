import { z } from 'zod';
import {
  MaterialsActionCommandProjectionSchema,
  MaterialsPublicationCommandProjectionSchema,
  PanelWriteReceiptQuerySchema,
  ReferencePublicationQuerySchema,
  ReferencePublishInputSchema,
  UuidSchema,
  WorkbenchDeliverablesFilterSchema,
  WorkbenchFileFavoriteSchema,
  WorkbenchFileUploadSchema,
} from '@allrice/contracts';
import {
  DataAccessError,
  isIndexableKnowledgeTextSource,
} from '@allrice/database';
import { workbenchFileError, workbenchFileHeaders } from '../workbench-files';
import { readStaticArtifactPreview } from '../runtime/static-artifact-preview';
import {
  requireEmployeePanelsContext,
  employeePanelsDependencies,
} from './employee-panels-context';
import {
  preparePanelDownload,
  readPanelResourceBytes,
} from './employee-panels-download';

type Scope = Awaited<ReturnType<typeof requireEmployeePanelsContext>>;
export type PanelRoute = {
  params: Promise<{
    panelEmployeeInstanceId: string;
    revisionId?: string;
    sourceId?: string;
    objectId?: string;
    requestId?: string;
  }>;
};
type Params = Awaited<PanelRoute['params']>;
export function createEmployeePanelsHandlers(
  dependencies = employeePanelsDependencies,
) {
  const route =
    (
      write: boolean,
      action: (
        scope: Scope,
        params: Params,
        request: Request,
      ) => Promise<unknown>,
    ) =>
    async (request: Request, input: PanelRoute) => {
      try {
        const params = await input.params;
        const scope = await requireEmployeePanelsContext(
          request,
          params.panelEmployeeInstanceId,
          write,
          dependencies,
        );
        const result = await action(scope, params, request);
        try {
          await scope.current();
        } catch (error) {
          if (result instanceof Response) {
            try {
              await result.body?.cancel(error);
            } catch (cleanup) {
              throw new AggregateError(
                [error, cleanup],
                'Panel response cleanup failed',
                { cause: error },
              );
            }
          }
          throw error;
        }
        return result instanceof Response
          ? result
          : Response.json(result, { headers: workbenchFileHeaders });
      } catch (error) {
        return workbenchFileError(error);
      }
    };
  const workspace = (scope: Scope, input: { workspaceId: string }) => {
    if (input.workspaceId !== scope.selection.workspaceId)
      throw new DataAccessError('authorization_denied');
  };
  const materialInput = (scope: Scope, params: Params) => ({
    workspaceId: scope.selection.workspaceId,
    revisionId: UuidSchema.parse(params.revisionId),
  });
  const fileInput = (params: Params) => ({
    objectId: UuidSchema.parse(params.objectId),
  });
  async function resource(
    scope: Scope,
    params: Params,
    request: Request,
    kind: 'material' | 'file',
  ) {
    const get = () =>
      kind === 'material'
        ? scope.materials.authorizedRevisionResource(
            scope.context,
            materialInput(scope, params),
            request.signal,
          )
        : scope.deliverables.download(
            scope.context,
            fileInput(params),
            request.signal,
          );
    const original = await get();
    const checksum =
      'pin' in original ? original.pin.checksum : original.source.checksum;
    const objectId =
      'pin' in original ? original.objectId : original.source.objectId;
    const pin =
      'pin' in original
        ? JSON.stringify(original.pin)
        : JSON.stringify(original.source);
    const authorize = async () => {
      const fresh = await get();
      if (
        JSON.stringify('pin' in fresh ? fresh.pin : fresh.source) !== pin ||
        fresh.sizeBytes !== original.sizeBytes ||
        fresh.fileName !== original.fileName ||
        fresh.mediaType !== original.mediaType
      )
        throw new DataAccessError('not_found');
      await scope.current();
    };
    return { original, checksum, objectId, authorize };
  }
  const preview = (kind: 'material' | 'file') =>
    route(false, async (scope, params, request) => {
      const { original, checksum, objectId, authorize } = await resource(
        scope,
        params,
        request,
        kind,
      );
      const query = new URL(request.url).searchParams;
      const source =
        z.enum(['0', '1']).parse(query.get('source') ?? '0') === '1';
      const offset = z
        .number()
        .int()
        .positive()
        .parse(Number(query.get('offset') ?? 1));
      const result = await readStaticArtifactPreview(
        {
          object: {
            id: objectId,
            checksum,
            mediaType: original.mediaType,
            sizeBytes: original.sizeBytes,
          },
          kind: 'file',
          version: { fileName: original.fileName },
          resource: {
            open: (signal) => original.open(signal),
            bytes: (maximum) =>
              readPanelResourceBytes(original, maximum, request.signal),
          },
        },
        { source, offset, signal: request.signal },
      );
      await authorize();
      return result;
    });
  const download = (kind: 'material' | 'file') =>
    route(false, async (scope, params, request) => {
      const { original, checksum, authorize } = await resource(
        scope,
        params,
        request,
        kind,
      );
      return preparePanelDownload(
        original,
        checksum,
        request.signal,
        authorize,
      );
    });
  return {
    queryMaterials: route(false, async (scope, _params, request) => {
      const params = new URL(request.url).searchParams;
      const query = ReferencePublicationQuerySchema.parse({
        ...(params.has('category') ? { category: params.get('category') } : {}),
        ...(params.has('query') ? { query: params.get('query') } : {}),
        ...(params.has('sourceId') ? { sourceId: params.get('sourceId') } : {}),
        ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
        ...(params.has('cursor')
          ? { cursor: JSON.parse(params.get('cursor')!) }
          : {}),
      });
      const result = await scope.materials.query(
        scope.context,
        query,
        request.signal,
      );
      const options = await scope.materials.options(
        scope.context,
        { workspaceId: scope.selection.workspaceId },
        request.signal,
      );
      if (options.workspaceId !== scope.selection.workspaceId)
        throw new DataAccessError('authorization_denied');
      return { ...result, viewerId: scope.context.actor.id, options };
    }),
    publicationOptions: route(false, async (scope, _params, request) => ({
      viewerId: scope.context.actor.id,
      options: await scope.materials.options(
        scope.context,
        { workspaceId: scope.selection.workspaceId },
        request.signal,
      ),
    })),
    selectMaterial: route(false, (scope, params, request) =>
      scope.materials.captureSelection(
        scope.context,
        materialInput(scope, params),
        request.signal,
      ),
    ),
    previewMaterial: preview('material'),
    downloadMaterial: download('material'),
    publish: route(true, async (scope, _params, request) => {
      const value = ReferencePublishInputSchema.parse(await request.json());
      workspace(scope, value);
      if (value.origin === 'upload')
        return scope.materials.publishUpload(
          scope.context,
          value,
          request.signal,
        );
      const source = await scope.deliverables.download(
        scope.context,
        { objectId: value.objectId },
        request.signal,
      );
      return scope.materials.publishFile(
        scope.context,
        value,
        source,
        request.signal,
      );
    }),
    changePublication: route(true, async (scope, params, request) => {
      const value = MaterialsPublicationCommandProjectionSchema.parse({
        target: { sourceId: params.sourceId },
        body: await request.json(),
      });
      workspace(scope, value.body);
      return scope.materials.changePublication(
        scope.context,
        value,
        request.signal,
      );
    }),
    changeSource: route(true, async (scope, params, request) => {
      const value = MaterialsActionCommandProjectionSchema.parse({
        target: { sourceId: params.sourceId },
        body: await request.json(),
      });
      workspace(scope, value.body);
      if (value.body.action !== 'retry')
        throw new DataAccessError('authorization_denied');
      return scope.materials.changeSource(scope.context, value, request.signal);
    }),
    listDeliverables: route(false, async (scope, _params, request) => {
      const params = new URL(request.url).searchParams;
      const filter = WorkbenchDeliverablesFilterSchema.parse({
        workspaceId: scope.selection.workspaceId,
        employeeInstanceId: params.get('employeeInstanceId') ?? undefined,
        category: params.get('category') ?? undefined,
        query: params.get('query') ?? '',
        cursor: params.get('cursor') ?? undefined,
        objectId: params.get('objectId') ?? undefined,
      });
      const catalog = await scope.deliverables.list(
        scope.context,
        filter,
        request.signal,
      );
      if (catalog.viewerId !== scope.context.actor.id)
        throw new DataAccessError('authorization_denied');
      return {
        ...catalog,
        quotableFileIds: catalog.files
          .filter((file) => {
            if (file.reference?.companyTemplate) return true;
            const current =
              file.reference?.checksum === file.checksum
                ? file.reference
                : null;
            if (current?.status === 'archived') return false;
            if (current?.processing === 'ready') return true;
            if (
              current &&
              ['unsupported', 'failed', 'uploading'].includes(
                current.processing,
              )
            )
              return false;
            return isIndexableKnowledgeTextSource(file);
          })
          .map((file) => file.objectId),
      };
    }),
    captureReference: route(true, async (scope, params, request) => {
      const value = z
        .object({ requestId: UuidSchema })
        .strict()
        .parse(await request.json());
      return {
        reference: await scope.deliverables.captureReference(
          scope.context,
          {
            ...fileInput(params),
            workspaceId: scope.selection.workspaceId,
            requestId: value.requestId,
          },
          request.signal,
        ),
      };
    }),
    readPreparedReference: route(false, (scope, params, request) =>
      scope.materials.readPreparedReference(
        scope.context,
        {
          ...materialInput(scope, params),
          sourceId: UuidSchema.parse(
            new URL(request.url).searchParams.get('sourceId'),
          ),
        },
        request.signal,
      ),
    ),
    favorite: route(true, async (scope, params, request) =>
      scope.deliverables.favorite(
        scope.context,
        {
          target: fileInput(params),
          body: WorkbenchFileFavoriteSchema.parse(await request.json()),
        },
        request.signal,
      ),
    ),
    previewDeliverable: preview('file'),
    downloadDeliverable: download('file'),
    uploadDeliverable: route(true, async (scope, _params, request) => {
      const value = WorkbenchFileUploadSchema.parse(await request.json());
      workspace(scope, value);
      return scope.deliverables.upload(scope.context, value, request.signal);
    }),
    readWriteReceipt: route(false, (scope, params, request) => {
      const query = new URL(request.url).searchParams;
      const input = PanelWriteReceiptQuerySchema.parse({
        workspaceId: scope.selection.workspaceId,
        requestId: params.requestId,
        operation: query.get('operation'),
        sourceId: query.get('sourceId') ?? undefined,
      });
      return ['capture', 'upload'].includes(input.operation)
        ? scope.deliverables.readWriteReceipt(
            scope.context,
            input,
            request.signal,
          )
        : scope.materials.readWriteReceipt(
            scope.context,
            input,
            request.signal,
          );
    }),
  };
}
export const employeePanelsHandlers = createEmployeePanelsHandlers();
