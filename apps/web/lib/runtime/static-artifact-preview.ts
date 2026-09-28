import type { WorkbenchArtifact } from '@allrice/contracts';
import {
  ArtifactReviewError,
  parseChangesetBytes,
  readArtifactBytes,
} from '@allrice/database';
import { previewOfficePdf } from '@allrice/office-runtime/preview';
import { getStorageAdapter } from '../storage/runtime';
import { readDocumentTextPage } from './document-text-page';
import { reportPreviewFailure } from './preview-diagnostics';
import {
  documentPreviewLimits as limits,
  previewExtension,
  previewImageMediaTypes,
  type OfficePreviewFormat,
  type SpreadsheetFormat,
} from '../chatflow/document-preview-policy';
import { unviewableBinaryPath } from '../../app/chatflow/dsh-upstream/document/document/unviewable';

/** DSH renderers and defaults, fed authorized immutable AllRice objects.
 * Routes authorize both before this read and after it completes. */
export async function readStaticArtifactPreview(
  artifact: Pick<WorkbenchArtifact, 'object' | 'kind'> & {
    version?: { fileName: string };
  },
  options: { offset?: number; source?: boolean; signal?: AbortSignal } = {},
) {
  const object = artifact.object;
  const extension = previewExtension(
    artifact.version?.fileName,
    object.mediaType,
  );
  const storage = getStorageAdapter();
  const download = (reason: string) => ({
    kind: 'download_only' as const,
    reason,
  });
  const bytes = (maximum: number) =>
    readArtifactBytes(storage, object, maximum);
  if (artifact.kind === 'changeset')
    return {
      kind: 'changeset',
      changeset: parseChangesetBytes(await bytes(512_000)),
    };
  if (!options.source && ['doc', 'docx', 'ppt', 'pptx'].includes(extension)) {
    if (object.sizeBytes > limits.officeInputBytes)
      return download('此文档超过 50 MiB 预览上限，请下载查看。');
    try {
      const result = await previewOfficePdf({
        objectId: object.id,
        checksum: object.checksum,
        sizeBytes: object.sizeBytes,
        format: extension as OfficePreviewFormat,
        signal: options.signal,
        read: async (signal, maximum) => {
          signal.throwIfAborted();
          const data = await bytes(maximum);
          signal.throwIfAborted();
          return data;
        },
      });
      return {
        kind: 'pdf',
        base64: Buffer.from(result.pdf).toString('base64'),
        missingFonts: result.missingFonts,
        converted: true,
      };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      reportPreviewFailure('office-conversion', error, object.id);
      return download('文档转换暂不可用，请重试预览或下载查看。');
    }
  }
  if (!options.source && ['xlsx', 'xls', 'csv', 'tsv'].includes(extension)) {
    if (object.sizeBytes > limits.excel.maxBytes)
      return download('此表格超过 16 MiB 预览上限，请下载查看。');
    return {
      kind: 'spreadsheet',
      format: extension as SpreadsheetFormat,
      base64: (await bytes(limits.excel.maxBytes)).toString('base64'),
    };
  }
  const imageMediaType =
    previewImageMediaTypes[extension as keyof typeof previewImageMediaTypes];
  if (
    !options.source &&
    (imageMediaType || ['pdf', 'html', 'htm'].includes(extension))
  ) {
    if (object.sizeBytes > limits.fileBytes)
      return download('此文件超过 32 MiB 预览上限，请下载查看。');
    const base64 = (await bytes(limits.fileBytes)).toString('base64');
    if (imageMediaType)
      return { kind: 'image', mediaType: imageMediaType, base64 };
    return { kind: extension === 'pdf' ? 'pdf' : 'html', base64 };
  }
  if (unviewableBinaryPath(artifact.version?.fileName || `file.${extension}`))
    return download('此文件格式暂不支持预览，请下载查看。');
  try {
    const page = await readDocumentTextPage(
      storage,
      object,
      options.offset,
      options.signal,
    );
    return {
      kind: 'text',
      ...page,
      mediaType: ['md', 'markdown'].includes(extension)
        ? 'text/markdown'
        : object.mediaType,
    };
  } catch (error) {
    if (
      error instanceof ArtifactReviewError &&
      error.code === 'preview_not_text'
    )
      return download('文件不是可读取的 UTF-8 文本，请下载查看。');
    if (
      error instanceof ArtifactReviewError &&
      error.code === 'preview_page_too_large'
    )
      return download('文本单页超过 2 MiB 预览上限，请下载查看。');
    throw error;
  }
}
