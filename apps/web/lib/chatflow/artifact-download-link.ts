/** Resolve only IDs from the current Run's authenticated Artifact list.
 * Models sometimes invent an origin for a relative tool download URL. Neither
 * that origin nor its query parameters are authority for our file endpoint. */
export function artifactForDownloadLink<
  T extends {
    object: { id: string };
    version: { fileName: string };
  },
>(href: string | undefined, artifacts: readonly T[]): T | undefined {
  if (!href || !artifacts.length) return undefined;
  try {
    // Some model replies JSON-escape path separators, even twice. Repair
    // only a URL that still identifies an authenticated delivery below.
    const url = new URL(
      href.replace(/\\+\//g, '/'),
      'https://artifact-link.invalid',
    );
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return undefined;
    const match = /^\/api\/v1\/files\/([a-f0-9-]{36})\/download$/.exec(
      url.pathname,
    );
    return match ? artifacts.find((a) => a.object.id === match[1]) : undefined;
  } catch {
    return undefined;
  }
}

export function artifactDownloadLink(
  href: string | undefined,
  artifacts: readonly {
    object: { id: string };
    version: { fileName: string };
  }[],
): string | undefined {
  const artifact = artifactForDownloadLink(href, artifacts);
  return artifact
    ? `/api/v1/files/${artifact.object.id}/download?name=${encodeURIComponent(artifact.version.fileName)}`
    : href;
}
