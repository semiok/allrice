/** Resolve only IDs from the current Run's authenticated Artifact list.
 * Models sometimes invent an origin for a relative tool download URL. Neither
 * that origin nor its query parameters are authority for our file endpoint. */
export function artifactDownloadLink(
  href: string | undefined,
  artifacts: readonly {
    object: { id: string };
    version: { fileName: string };
  }[],
): string | undefined {
  if (!href || !artifacts.length) return href;
  try {
    const url = new URL(href, 'https://artifact-link.invalid');
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return href;
    const match = /^\/api\/v1\/files\/([a-f0-9-]{36})\/download$/.exec(
      url.pathname,
    );
    const artifact = match && artifacts.find((a) => a.object.id === match[1]);
    return artifact
      ? `/api/v1/files/${artifact.object.id}/download?name=${encodeURIComponent(artifact.version.fileName)}`
      : href;
  } catch {
    return href;
  }
}
