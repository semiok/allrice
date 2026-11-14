import { UuidSchema } from '@allrice/contracts';

/** Application location only; each read still authenticates the current viewer. */
export function referencePublicationLink(
  workspaceId: string,
  sourceId: string,
  revisionId: string,
) {
  const url = new URL('/chatflow', window.location.origin);
  url.search = new URLSearchParams({
    workspaceId,
    referenceSource: sourceId,
    referenceRevision: revisionId,
  }).toString();
  return url.href;
}

export function readReferencePublicationLocation() {
  const params = new URLSearchParams(window.location.search);
  const source = UuidSchema.safeParse(params.get('referenceSource'));
  const revision = UuidSchema.safeParse(params.get('referenceRevision'));
  const workspace = UuidSchema.safeParse(params.get('workspaceId'));
  return source.success && revision.success && workspace.success
    ? {
        sourceId: source.data,
        revisionId: revision.data,
        workspaceId: workspace.data,
      }
    : null;
}

export function clearReferencePublicationLocation() {
  const url = new URL(window.location.href);
  if (
    !url.searchParams.has('referenceSource') &&
    !url.searchParams.has('referenceRevision')
  )
    return;
  url.searchParams.delete('referenceSource');
  url.searchParams.delete('referenceRevision');
  url.searchParams.delete('workspaceId');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}
