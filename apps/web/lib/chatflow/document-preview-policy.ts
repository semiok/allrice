/** DSH 0.1.7-rc.1 defaults. Shared by authenticated readers and browser admission. */
export const documentPreviewLimits = {
  fileBytes: 32 * 1024 * 1024,
  pageBytes: 2 * 1024 * 1024,
  pageLines: 5000,
  excel: { maxBytes: 16 * 1024 * 1024, maxCells: 250_000, timeoutMs: 15_000 },
  officeInputBytes: 50 * 1024 * 1024,
  officeOutputBytes: 100 * 1024 * 1024,
} as const;

export const previewImageMediaTypes = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
} as const;
export type PreviewImageMediaType =
  (typeof previewImageMediaTypes)[keyof typeof previewImageMediaTypes];
export type SpreadsheetFormat = 'xlsx' | 'xls' | 'csv' | 'tsv';
export type OfficePreviewFormat = 'doc' | 'docx' | 'ppt' | 'pptx';

const mediaExtensions: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/markdown': 'md',
  'text/html': 'html',
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'application/msword': 'doc',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  ...Object.fromEntries(
    Object.entries(previewImageMediaTypes).map(([extension, media]) => [
      media,
      extension,
    ]),
  ),
};
export function previewExtension(
  fileName: string | undefined,
  mediaType: string,
) {
  const name = fileName?.replaceAll('\\', '/').split('/').at(-1) ?? '';
  return (
    (name.includes('.') ? name.split('.').at(-1)!.toLowerCase() : '') ||
    mediaExtensions[mediaType.toLowerCase().split(';')[0]!] ||
    ''
  );
}
export function base64WithinLimit(
  value: unknown,
  maximum: number,
): value is string {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(maximum / 3) * 4 ||
    value.length % 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    return false;
  return (
    (value.length / 4) * 3 -
      (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0) <=
    maximum
  );
}
