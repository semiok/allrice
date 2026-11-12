/** An authenticated application locator, never a storage grant or download URL. */
export function workbenchFileLink(workspaceId: string, objectId: string) {
  const url = new URL('/chatflow', window.location.origin);
  url.search = new URLSearchParams({ file: objectId, workspaceId }).toString();
  return url.href;
}
export function copyWorkbenchFileLink(workspaceId: string, objectId: string) {
  return navigator.clipboard.writeText(
    workbenchFileLink(workspaceId, objectId),
  );
}
export function clearWorkbenchFileLink() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('file')) return;
  url.searchParams.delete('file');
  url.searchParams.delete('workspaceId');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}
