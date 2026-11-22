import {
  MaterialsActionCommandProjectionSchema,
  MaterialsActionResultProjectionSchema,
  MaterialsCurrentListProjectionSchema,
  MaterialsPublicationCommandProjectionSchema,
  MaterialsSaveInputProjectionSchema,
  MaterialsScopeQueryProjectionSchema,
  MaterialsSelectionQueryProjectionSchema,
  MaterialsUploadPublicationInputProjectionSchema,
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
} from './reference-library.ts';
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
