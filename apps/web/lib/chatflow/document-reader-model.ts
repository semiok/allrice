export function isToolResultFile(fileName: string, objectId: string) {
  return (
    fileName.startsWith('tool-result-') && fileName.endsWith(`-${objectId}.txt`)
  );
}

export function isToolResultExport(version: {
  fileName: string;
  objectId: string;
  changeSummary: string | null;
}) {
  const tool = /^Tool result ([\w.]+); Run [\w-]+; call .+$/.exec(
    version.changeSummary ?? '',
  )?.[1];
  return (
    !!tool &&
    version.fileName ===
      `tool-result-${tool.replaceAll('.', '-')}-${version.objectId}.txt`
  );
}

/** An actual stored web-search response, never a synthesized research summary. */
export function searchResultDocument(text: string) {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record.query !== 'string' ||
      typeof record.output !== 'string' ||
      typeof record.provider !== 'string'
    )
      return null;
    // Provider citation tokens are opaque outside the original model response.
    return {
      query: record.query,
      body: record.output
        .replace(/\uE200[^\uE201]*\uE201/g, '')
        .replace(/\[wordlim:\s*\d+\]/g, ''),
    };
  } catch {
    return null;
  }
}
