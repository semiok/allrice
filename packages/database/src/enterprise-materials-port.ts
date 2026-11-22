import {
  MaterialsActionCommandProjectionSchema,
  MaterialsActionResultProjectionSchema,
  MaterialsCurrentListProjectionSchema,
  MaterialsPublicationCommandProjectionSchema,
  MaterialsSaveInputProjectionSchema,
  MaterialsScopeQueryProjectionSchema,
  MaterialsSelectionQueryProjectionSchema,
  MaterialsUploadPublicationInputProjectionSchema,
  MaterialsFilePublicationInputProjectionSchema,
  MaterialsPreparedReferenceQuerySchema,
  PanelWriteReceiptQuerySchema,
  ReferenceRevisionSchema,
  ReferenceLibraryOptionsSchema,
  ReferencePublicationQuerySchema,
  ReferenceSaveResultSchema,
  RequestContextSchema,
  type EnterpriseMaterialsPort,
  type RequestContext,
  type StoragePort,
} from '@allrice/contracts';
import { DataAccessError } from './data.ts';
import {
  changeReference,
  changeReferencePublication,
  completeReferenceUpload,
  listReferenceRevisions,
  prepareReferenceUpload,
  publishReference,
  referenceLibraryOptions,
  getAuthorizedReferenceFile,
  readReferenceWriteReceipt,
} from './reference-library.ts';
import { createAuthorizedFileResource } from './authorized-file-resource.ts';
import { queryReferencePublications } from './reference-search.ts';
import { readReferenceInputSelection } from './reference-runtime.ts';

export interface EnterpriseMaterialsPortOptions {
  storage: StoragePort;
  /** Host-only current qualification dependency, not established by parsing
   * RequestContext. Missing 271/273 wiring denies access; tests name a substitute.
   * Existing owner primitives separately recheck live resource/maintenance ACLs. */
  requireCurrentAccess?: (
    context: RequestContext,
    signal: AbortSignal,
  ) => Promise<void>;
}

export function createEnterpriseMaterialsPort(
  options: EnterpriseMaterialsPortOptions,
): EnterpriseMaterialsPort {
  async function current(
    contextInput: RequestContext,
    workspaceId: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const context = RequestContextSchema.parse(contextInput);
    if (
      context.actor.type !== 'user' ||
      !context.workspaceId ||
      context.workspaceId !== workspaceId ||
      !options.requireCurrentAccess
    )
      throw new DataAccessError('authorization_denied');
    await options.requireCurrentAccess(context, signal);
    signal.throwIfAborted();
    return context;
  }
  return {
    async authorizedRevisionResource(contextInput, input, signal) {
      const value = MaterialsSelectionQueryProjectionSchema.parse(input);
      const context = await current(contextInput, value.workspaceId, signal);
      const original = await getAuthorizedReferenceFile(
        context,
        value.workspaceId,
        value.revisionId,
      );
      const pin = {
        sourceId: original.sourceId,
        revisionId: value.revisionId,
        revision: original.reference.revision,
        digest:
          original.reference.manifestDigest ?? original.reference.checksum,
        checksum: original.object.checksum,
      };
      const recheck = async (reading: AbortSignal) => {
        await current(context, value.workspaceId, reading);
        const file = await getAuthorizedReferenceFile(
          context,
          value.workspaceId,
          value.revisionId,
        );
        if (
          file.sourceId !== pin.sourceId ||
          file.object.id !== original.object.id ||
          file.object.checksum !== pin.checksum ||
          file.object.sizeBytes !== original.object.sizeBytes ||
          file.reference.revision !== pin.revision ||
          (file.reference.manifestDigest ?? file.reference.checksum) !==
            pin.digest
        )
          throw new DataAccessError('not_found');
        await current(context, value.workspaceId, reading);
        return file;
      };
      await recheck(signal);
      return {
        pin,
        objectId: original.object.id,
        fileName: original.fileName,
        mediaType: original.object.mediaType,
        sizeBytes: original.object.sizeBytes,
        open: createAuthorizedFileResource({
          signal,
          checksum: pin.checksum,
          sizeBytes: original.object.sizeBytes,
          recheck,
          openSource: async (reading) =>
            options.storage.get((await recheck(reading)).object),
          changed: () => new DataAccessError('not_found'),
        }),
      };
    },
    async readPreparedReference(contextInput, input, signal) {
      const value = MaterialsPreparedReferenceQuerySchema.parse(input);
      const context = await current(contextInput, value.workspaceId, signal);
      const result = (
        await listReferenceRevisions(context, value.workspaceId, value.sourceId)
      ).find(
        (reference) =>
          reference.revisionId === value.revisionId &&
          reference.sourceId === value.sourceId,
      );
      if (!result) throw new DataAccessError('not_found');
      await current(context, value.workspaceId, signal);
      return ReferenceRevisionSchema.parse(result);
    },
    async publishFile(contextInput, input, source, signal) {
      const value = MaterialsFilePublicationInputProjectionSchema.parse(input);
      const context = await current(contextInput, value.workspaceId, signal);
      if (source.source.objectId !== value.objectId)
        throw new DataAccessError('not_found');
      const result = await publishReference(context, value, options.storage, {
        namePolicy: 'independent-material',
        source,
        signal,
        requireCurrentAccess: async () => {
          await current(context, value.workspaceId, signal);
        },
      });
      await current(context, value.workspaceId, signal);
      return ReferenceSaveResultSchema.parse(result);
    },
    async readWriteReceipt(contextInput, input, signal) {
      const value = PanelWriteReceiptQuerySchema.parse(input);
      const context = await current(contextInput, value.workspaceId, signal);
      const result = await readReferenceWriteReceipt(context, value);
      await current(context, value.workspaceId, signal);
      return result;
    },
    async listCurrent(contextInput, input, signal) {
      const value = MaterialsScopeQueryProjectionSchema.parse(input);
      const context = await current(contextInput, value.workspaceId, signal);
      // No source-history selector. The owner returns its one current fixed
      // revision per source, including legacy/platform material still in use.
      const references = await listReferenceRevisions(
        context,
        value.workspaceId,
      );
      const libraryOptions = await referenceLibraryOptions(
        context,
        value.workspaceId,
      );
      await current(context, value.workspaceId, signal);
      return MaterialsCurrentListProjectionSchema.parse({
        references,
        options: libraryOptions,
      });
    },
    async options(contextInput, input, signal) {
      const value = MaterialsScopeQueryProjectionSchema.parse(input);
      const context = await current(contextInput, value.workspaceId, signal);
      const result = await referenceLibraryOptions(context, value.workspaceId);
      await current(context, value.workspaceId, signal);
      return ReferenceLibraryOptionsSchema.parse(result);
    },
    async query(contextInput, input, signal) {
      const value = ReferencePublicationQuerySchema.parse(input);
      const context = await current(
        contextInput,
        contextInput.workspaceId ?? '',
        signal,
      );
      const result = await queryReferencePublications(context, value);
      await current(context, context.workspaceId!, signal);
      return result;
    },
    async captureSelection(contextInput, input, signal) {
      const value = MaterialsSelectionQueryProjectionSchema.parse(input);
      const context = await current(contextInput, value.workspaceId, signal);
      const result = await readReferenceInputSelection(
        context,
        value.workspaceId,
        value.revisionId,
      );
      await current(context, value.workspaceId, signal);
      return result;
    },
    async save(contextInput, input, signal) {
      const value = MaterialsSaveInputProjectionSchema.parse(input);
      const context = await current(contextInput, value.workspaceId, signal);
      const prepared = await prepareReferenceUpload(context, value, undefined, {
        namePolicy: 'independent-material',
      });
      signal.throwIfAborted();
      if (!prepared.alreadyReady) {
        if (!prepared.object) throw new Error('Reference reservation missing');
        await options.storage.put(
          prepared.object,
          new Blob([new Uint8Array(prepared.bytes)]).stream(),
        );
        signal.throwIfAborted();
        await completeReferenceUpload(
          context,
          value.workspaceId,
          prepared.revisionId,
        );
      }
      await current(context, value.workspaceId, signal);
      return ReferenceSaveResultSchema.parse({
        sourceId: prepared.sourceId,
        revisionId: prepared.revisionId,
      });
    },
    async publishUpload(contextInput, input, signal) {
      const value =
        MaterialsUploadPublicationInputProjectionSchema.parse(input);
      const context = await current(contextInput, value.workspaceId, signal);
      const result = await publishReference(context, value, options.storage, {
        namePolicy: 'independent-material',
        signal,
        requireCurrentAccess: async () => {
          await current(context, value.workspaceId, signal);
        },
      });
      // Owner Promise joins storage/transaction. A revoked response does not
      // roll back a publication; reconcile this original requestId.
      await current(context, value.workspaceId, signal);
      return ReferenceSaveResultSchema.parse(result);
    },
    async changePublication(contextInput, input, signal) {
      const value = MaterialsPublicationCommandProjectionSchema.parse(input);
      const context = await current(
        contextInput,
        value.body.workspaceId,
        signal,
      );
      const result = await changeReferencePublication(
        context,
        value.target.sourceId,
        value.body,
      );
      await current(context, value.body.workspaceId, signal);
      return MaterialsActionResultProjectionSchema.parse(result);
    },
    async changeSource(contextInput, input, signal) {
      const value = MaterialsActionCommandProjectionSchema.parse(input);
      const context = await current(
        contextInput,
        value.body.workspaceId,
        signal,
      );
      const result = await changeReference(
        context,
        value.target.sourceId,
        value.body,
      );
      await current(context, value.body.workspaceId, signal);
      return MaterialsActionResultProjectionSchema.parse(result);
    },
  };
}
