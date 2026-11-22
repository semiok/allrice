import { ReferenceRevisionSchema } from '@allrice/contracts';
import { createEmployeePanelDataClient } from './employee-panel-data';
import { checkReferenceSelectionFailure } from './reference-selection';
import { workbenchJson } from './workbench-model';
import { readJson } from '../../app/chatflow/chatflow-utils';

/** Compatibility for existing 3.x consumers only. A 4.0 owner must supply an
 * explicit data client; an unbound 4.0 method never reaches this adapter. */
export function legacyEmployeePanelDataClient(
  headers: Record<string, string>,
  viewerId?: string,
) {
  const expectedViewer = viewerId
    ? { ...headers, 'X-AllRice-Expected-Viewer-Id': viewerId }
    : headers;
  const query = (input: Record<string, unknown>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input))
      if (value !== undefined)
        params.set(
          key,
          typeof value === 'object' ? JSON.stringify(value) : String(value),
        );
    return params.toString();
  };
  const write = (
    url: string,
    body: unknown,
    signal: AbortSignal,
    method = 'POST',
  ) =>
    workbenchJson(url, expectedViewer, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  return createEmployeePanelDataClient({
    queryMaterials: (input, signal) =>
      workbenchJson(
        '/api/v1/references/publications?' +
          query({ workspaceId: input.workspaceId, ...input.query }),
        headers,
        { signal },
      ),
    publicationOptions: (input, signal) =>
      workbenchJson(
        '/api/v1/references/publications?' +
          query({ ...input, category: 'all', limit: 1 }),
        headers,
        { signal },
      ),
    async selectMaterial(input, signal) {
      const response = await fetch(
        `/api/v1/references/revisions/${input.revisionId}/selection?` +
          query({ workspaceId: input.workspaceId }),
        {
          cache: 'no-store',
          credentials: 'same-origin',
          headers,
          signal,
        },
      );
      await checkReferenceSelectionFailure(response, [input.revisionId]);
      return readJson(response, { read: true });
    },
    previewMaterial: (input, signal) =>
      workbenchJson(
        `/api/v1/references/revisions/${input.revisionId}/preview?` +
          query({
            workspaceId: input.workspaceId,
            source: input.source ? 1 : undefined,
            offset: input.offset,
          }),
        headers,
        { signal },
      ),
    publishFile: (input, signal) =>
      write('/api/v1/references/publications', input, signal),
    publishUpload: (input, signal) =>
      write('/api/v1/references/publications', input, signal),
    changePublication: (input, signal) =>
      write(
        `/api/v1/references/publications/${input.sourceId}`,
        input.body,
        signal,
      ),
    changeSource: (input, signal) =>
      write(`/api/v1/references/${input.sourceId}`, input.body, signal),
    listDeliverables: (input, signal) =>
      workbenchJson(
        '/api/v1/workbench/files?' + query({ view: 'deliverables', ...input }),
        headers,
        { signal },
      ),
    captureReference: (input, signal) =>
      write(
        `/api/v1/workbench/files/${input.objectId}/reference?` +
          query({ workspaceId: input.workspaceId }),
        { requestId: input.requestId },
        signal,
      ),
    async readPreparedReference(input, signal) {
      const raw = (await workbenchJson(
        '/api/v1/references?' +
          query({ workspaceId: input.workspaceId, sourceId: input.sourceId }),
        headers,
        { signal },
      )) as { references: unknown[] };
      const reference = raw.references
        .map((value) => ReferenceRevisionSchema.parse(value))
        .find((r) => r.revisionId === input.revisionId);
      if (!reference) throw Error('所选文件的访问权限已变化，请重新选择。');
      return reference;
    },
    favorite: (input, signal) =>
      write(
        `/api/v1/workbench/files/${input.objectId}/favorite?` +
          query({ workspaceId: input.workspaceId }),
        input.body,
        signal,
        'PUT',
      ),
    previewDeliverable: (input, signal) =>
      workbenchJson(
        `/api/v1/workbench/files/${input.objectId}/preview?` +
          query({
            workspaceId: input.workspaceId,
            name: input.fileName,
            source: input.source ? 1 : undefined,
            offset: input.offset,
          }),
        headers,
        { signal },
      ),
    uploadDeliverable: (input, signal) =>
      write('/api/v1/workbench/files', input, signal),
  });
}
