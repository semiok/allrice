/** Resolve only IDs from the current Run's authenticated Artifact list.
 * Models sometimes invent an origin for a relative tool download URL. Neither
 * that origin nor its query parameters are authority for our file endpoint. */
export function artifactForDownloadLink<
  T extends {
    object: { id: string };
    version: { fileName: string };
  },
>(
  href: string | undefined,
  artifacts: readonly T[],
  label?: string,
): T | undefined {
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
    const match = /^\/api\/v1\/files\/([a-f0-9-]{36})(?:\/download)?$/.exec(
      url.pathname,
    );
    if (match) return artifacts.find((a) => a.object.id === match[1]);

    // Repair a malformed local file ID only when the explicit link label
    // identifies exactly one real delivery. Never guess from a UUID prefix.
    if (
      !label ||
      !href.startsWith('/api/v1/files/') ||
      !/^\/api\/v1\/files\/[^/]+(?:\/download)?$/.test(url.pathname)
    )
      return undefined;
    const matches = artifacts.filter((a) =>
      [a.version.fileName, `下载 ${a.version.fileName}`].includes(label.trim()),
    );
    return matches.length === 1 ? matches[0] : undefined;
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
  label?: string,
): string | undefined {
  const artifact = artifactForDownloadLink(href, artifacts, label);
  return artifact
    ? `/api/v1/files/${artifact.object.id}/download?name=${encodeURIComponent(artifact.version.fileName)}`
    : href;
}
