import { createAuthorizedFileResource } from './authorized-file-resource.ts';
import {
  ArtifactSourceFileSchema,
  DeliverableArtifactIdentityProjectionSchema,
  DeliverableArtifactListProjectionSchema,
  DeliverableArtifactQueryProjectionSchema,
  DeliverableFavoriteCommandProjectionSchema,
  DeliverableFavoriteResultProjectionSchema,
  DeliverableObjectQueryProjectionSchema,
  DeliverableReadInputProjectionSchema,
  DeliverableReadMcpProjectionSchema,
  DeliverableUploadResultProjectionSchema,
  DeliverableCaptureReferenceQuerySchema,
  PanelWriteReceiptQuerySchema,
  RequestContextSchema,
  WorkbenchDeliverablesFilterSchema,
  WorkbenchFileUploadSchema,
  deliverableReadPolicy,
  type AuthorizedDeliverableResource,
  type DeliverablesPort,
  type RequestContext,
  type StoragePort,
} from '@allrice/contracts';
import {
  getWorkbenchArtifact,
  listWorkbenchArtifacts,
} from './artifact-review.ts';
import { DataAccessError } from './data.ts';
import {
  readWorkbenchDeliverables,
  readPersonalWorkbenchFile,
  setWorkbenchFileFavorite,
  uploadWorkbenchFile,
  captureWorkbenchFileReference,
  readWorkbenchUploadReceipt,
} from './workbench-files.ts';
import { readReferenceWriteReceipt } from './reference-library.ts';

export interface DeliverablesPortOptions {
  storage: StoragePort;
  /** Trusted host qualification dependency (271/273), never model arguments.
   * Unbound production wiring fails closed. Tests must name their substitute.
   * The resource owner still checks live membership and owner-only eligibility. */
  requireCurrentAccess?: (
    context: RequestContext,
    signal: AbortSignal,
  ) => Promise<void>;
}

export class DeliverableReadError extends Error {
  constructor(
    readonly code:
      | 'TOOL_FILE_TYPE_UNSUPPORTED'
      | 'TOOL_FILE_TOO_LARGE'
      | 'TOOL_FILE_CHECKSUM_MISMATCH',
  ) {
    super(code);
  }
}

export function createDeliverablesPort(
  options: DeliverablesPortOptions,
): DeliverablesPort {
  async function current(contextInput: RequestContext, signal: AbortSignal) {
    signal.throwIfAborted();
    const context = RequestContextSchema.parse(contextInput);
    if (
      context.actor.type !== 'user' ||
      !context.workspaceId ||
      !options.requireCurrentAccess
    )
      throw new DataAccessError('authorization_denied');
    await options.requireCurrentAccess(context, signal);
    signal.throwIfAborted();
    return context;
  }
  function workspace(context: RequestContext, workspaceId: string) {
    if (workspaceId !== context.workspaceId)
      throw new DataAccessError('authorization_denied');
  }
  async function ownedFile(
    context: RequestContext,
    objectId: string,
    signal: AbortSignal,
  ) {
    await current(context, signal);
    // Candidate eligibility is the same owner-only business directory used for
    // favorites. Reference copies and arbitrary storage objects are excluded.
    const file = await readPersonalWorkbenchFile(context, objectId);
    if (
      file.object.ownerId !== context.actor.id ||
      file.object.workspaceId !== context.workspaceId ||
      !file.object.immutable
    )
      throw new DataAccessError('not_found');
    await current(context, signal);
    return file;
  }
  async function resource(
    context: RequestContext,
    objectId: string,
    checksum: string | undefined,
    signal: AbortSignal,
  ): Promise<AuthorizedDeliverableResource> {
    const original = await ownedFile(context, objectId, signal);
    if (checksum !== undefined && original.object.checksum !== checksum)
      throw new DataAccessError('not_found');
    const source = ArtifactSourceFileSchema.parse({
      objectId,
      checksum: original.object.checksum,
    });
    async function recheck(transferSignal: AbortSignal) {
      const file = await ownedFile(context, objectId, transferSignal);
      if (
        file.object.checksum !== source.checksum ||
        file.object.sizeBytes !== original.object.sizeBytes
      )
        throw new DataAccessError('not_found');
      return file;
    }
    return {
      source,
      fileName: original.row.file_name,
      mediaType: original.object.mediaType,
      sizeBytes: original.object.sizeBytes,
      async open(openSignal) {
        return createAuthorizedFileResource({
          signal,
          checksum: source.checksum,
          sizeBytes: original.object.sizeBytes,
          recheck,
          async openSource(transferSignal) {
            const file = await recheck(transferSignal);
            return options.storage.get(file.object);
          },
          changed: () =>
            new DeliverableReadError('TOOL_FILE_CHECKSUM_MISMATCH'),
        })(openSignal);
      },
    };
  }
  return {
    async captureReference(contextInput, input, signal) {
      const value = DeliverableCaptureReferenceQuerySchema.parse(input);
      const context = await current(contextInput, signal);
      workspace(context, value.workspaceId);
      const source = await resource(context, value.objectId, undefined, signal);
      const reference = await captureWorkbenchFileReference(
        context,
        value.workspaceId,
        value.objectId,
        value.requestId,
        options.storage,
        {
          source,
          signal,
          requireCurrentAccess: async () => {
            await current(context, signal);
          },
        },
      );
      await current(context, signal);
      return reference;
    },
    async readWriteReceipt(contextInput, input, signal) {
      const value = PanelWriteReceiptQuerySchema.parse(input);
      const context = await current(contextInput, signal);
      workspace(context, value.workspaceId);
      if (!['upload', 'capture'].includes(value.operation))
        throw new DataAccessError('authorization_denied');
      const result =
        value.operation === 'upload'
          ? await readWorkbenchUploadReceipt(context, value)
          : await readReferenceWriteReceipt(context, value);
      await current(context, signal);
      return result;
    },
    async list(contextInput, input, signal) {
      const context = await current(contextInput, signal);
      const filter = WorkbenchDeliverablesFilterSchema.parse(input);
      workspace(context, filter.workspaceId);
      // Favorites deliberately span all the current person's employees.
      const result = await readWorkbenchDeliverables(
        context,
        filter.category === 'favorite'
          ? { ...filter, employeeInstanceId: undefined }
          : filter,
      );
      await current(context, signal);
      return result;
    },
    async upload(contextInput, input, signal) {
      const context = await current(contextInput, signal);
      const value = WorkbenchFileUploadSchema.parse(input);
      workspace(context, value.workspaceId);
      const result = await uploadWorkbenchFile(context, value, options.storage);
      // Join the owner's real I/O/transaction; cancellation is not rollback.
      await current(context, signal);
      return DeliverableUploadResultProjectionSchema.parse(result);
    },
    async favorite(contextInput, input, signal) {
      const context = await current(contextInput, signal);
      const value = DeliverableFavoriteCommandProjectionSchema.parse(input);
      const result = await setWorkbenchFileFavorite(
        context,
        value.target.objectId,
        value.body,
      );
      await current(context, signal);
      return DeliverableFavoriteResultProjectionSchema.parse(result);
    },
    async listSessionArtifacts(contextInput, input, signal) {
      const context = await current(contextInput, signal);
      const value = DeliverableArtifactQueryProjectionSchema.parse(input);
      workspace(context, value.workspaceId);
      const result = await listWorkbenchArtifacts(
        context,
        value.sessionId,
        value.before,
      );
      await current(context, signal);
      return DeliverableArtifactListProjectionSchema.parse(result);
    },
    async getArtifact(contextInput, input, signal) {
      const context = await current(contextInput, signal);
      const value = DeliverableArtifactIdentityProjectionSchema.parse(input);
      workspace(context, value.workspaceId);
      const result = await getWorkbenchArtifact(
        context,
        value.sessionId,
        value.artifactId,
      );
      await current(context, signal);
      return result;
    },
    async authorizedResource(contextInput, input, signal) {
      const context = await current(contextInput, signal);
      const value = ArtifactSourceFileSchema.parse(input);
      return resource(context, value.objectId, value.checksum, signal);
    },
    async download(contextInput, input, signal) {
      const context = await current(contextInput, signal);
      const value = DeliverableObjectQueryProjectionSchema.parse(input);
      return resource(context, value.objectId, undefined, signal);
    },
    async readExact(contextInput, input, signal) {
      const context = await current(contextInput, signal);
      const value = DeliverableReadInputProjectionSchema.parse(input);
      const file = await resource(
        context,
        value.objectId,
        value.checksum,
        signal,
      );
      const genericText =
        file.mediaType === 'application/octet-stream' &&
        /\.(txt|md|json)$/i.test(file.fileName);
      if (
        !['text/plain', 'text/markdown', 'application/json'].includes(
          file.mediaType,
        ) &&
        !genericText
      )
        throw new DeliverableReadError('TOOL_FILE_TYPE_UNSUPPORTED');
      if (file.sizeBytes > deliverableReadPolicy.maximumBytes)
        throw new DeliverableReadError('TOOL_FILE_TOO_LARGE');
      const bytes = await new Response(await file.open(signal)).arrayBuffer();
      let content: string;
      try {
        content = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
        if (content.includes('\u0000')) throw new Error('binary content');
      } catch {
        throw new DeliverableReadError('TOOL_FILE_TYPE_UNSUPPORTED');
      }
      await current(context, signal);
      return DeliverableReadMcpProjectionSchema.parse({
        id: value.objectId,
        checksum: file.source.checksum,
        downloadUrl: `/api/v1/files/${value.objectId}/download?name=${encodeURIComponent(file.fileName)}`,
        fileName: file.fileName,
        mediaType: file.mediaType,
        content: content.slice(value.offset, value.offset + value.limit),
        offset: value.offset,
        totalCharacters: content.length,
        truncated:
          value.offset > 0 || value.offset + value.limit < content.length,
        nextOffset:
          value.offset + value.limit < content.length
            ? value.offset + value.limit
            : null,
      });
    },
  };
}
