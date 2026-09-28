import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import type { WorkbenchArtifact } from '@allrice/contracts';
const ports = vi.hoisted(() => ({
  read: vi.fn(),
  storage: { get: vi.fn() },
  office: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  readArtifactBytes: ports.read,
}));
vi.mock('@allrice/office-runtime/preview', () => ({
  previewOfficePdf: ports.office,
}));
vi.mock('../storage/runtime', () => ({
  getStorageAdapter: () => ports.storage,
}));
import { readStaticArtifactPreview } from './static-artifact-preview';
const object = {
  id: 'object',
  sizeBytes: 100,
  checksum: 'sha256:' + 'a'.repeat(64),
  mediaType: 'application/octet-stream',
} as WorkbenchArtifact['object'];
beforeEach(() => {
  vi.resetAllMocks();
  ports.read.mockResolvedValue(Buffer.from('fixture'));
  ports.office.mockResolvedValue({
    pdf: Buffer.from('%PDF-fixture'),
    missingFonts: [],
  });
});
const file = (
  name: string,
  sizeBytes = 100,
  mediaType = 'application/octet-stream',
) => ({
  kind: 'file' as const,
  version: { fileName: name },
  object: { ...object, sizeBytes, mediaType },
});
describe('native preview dispatch', () => {
  it.each(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'])(
    'uses native image mode for %s and the 32 MiB complete-file cap',
    async (extension) => {
      const result = await readStaticArtifactPreview(
        file(`image.${extension}`, 9_000_000),
      );
      expect(result.kind).toBe('image');
      expect(ports.read).toHaveBeenCalledWith(
        ports.storage,
        expect.anything(),
        32 * 1024 * 1024,
      );
    },
  );
  it.each(['doc', 'docx', 'ppt', 'pptx'])(
    'uses DSH PDF conversion for %s, preserving the immutable source',
    async (extension) => {
      const result = await readStaticArtifactPreview(
        file(`office.${extension}`, 9_000_000),
      );
      expect(result).toMatchObject({ kind: 'pdf', converted: true });
      expect(ports.office).toHaveBeenCalledWith(
        expect.objectContaining({
          objectId: 'object',
          checksum: object.checksum,
          format: extension,
        }),
      );
    },
  );
  it.each(['xlsx', 'xls', 'csv', 'tsv'])(
    'uses the browser spreadsheet parser for %s',
    async (format) => {
      const result = await readStaticArtifactPreview(file(`book.${format}`));
      expect(result).toMatchObject({ kind: 'spreadsheet', format });
      expect(ports.office).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['large.png', 32 * 1024 * 1024 + 1],
    ['large.pdf', 32 * 1024 * 1024 + 1],
    ['large.xlsx', 16 * 1024 * 1024 + 1],
    ['large.docx', 50 * 1024 * 1024 + 1],
  ] as const)('rejects oversized %s before storage IO', async (name, size) => {
    expect(await readStaticArtifactPreview(file(name, size))).toMatchObject({
      kind: 'download_only',
    });
    expect(ports.read).not.toHaveBeenCalled();
    expect(ports.office).not.toHaveBeenCalled();
  });
  it.each(['html', 'htm'])(
    'returns isolated HTML bytes for %s',
    async (extension) => {
      expect(
        await readStaticArtifactPreview(file(`page.${extension}`)),
      ).toMatchObject({ kind: 'html' });
    },
  );
  it.each(['ts', 'py', 'yaml', 'json', 'xml', 'unknown'])(
    'reads %s as paged text even when MIME is generic',
    async (extension) => {
      const bytes = Buffer.from('text\n中文');
      const input = file(`source.${extension}`, bytes.length);
      input.object.checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      ports.storage.get.mockResolvedValue(new Blob([bytes]).stream());
      expect(await readStaticArtifactPreview(input)).toMatchObject({
        kind: 'text',
        text: 'text\n中文',
        offset: 1,
        lines: 2,
        eof: true,
      });
    },
  );
  it.each(['zip', 'mp4', 'avif'])(
    'keeps unsupported binary %s out of the text reader',
    async (extension) => {
      expect(
        await readStaticArtifactPreview(file(`file.${extension}`)),
      ).toMatchObject({ kind: 'download_only' });
      expect(ports.storage.get).not.toHaveBeenCalled();
    },
  );
});
