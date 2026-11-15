import {
  ReferenceImageReadError,
  checkReferenceImageSignal,
  maximumKnowledgeTextBytes,
} from '@allrice/database';
import { decodeReferenceText } from './knowledge.js';
import {
  extractReferenceDocumentBytes,
  IncompleteReferenceText,
} from './reference-processing.js';
import { HandlerError } from './errors.js';

function rejected(
  reason: 'media_type' | 'nested_archive' | 'text_unavailable' | 'member_bytes',
): never {
  throw new ReferenceImageReadError({
    code:
      reason === 'member_bytes'
        ? 'REFERENCE_READ_LIMIT'
        : 'REFERENCE_READ_UNSUPPORTED',
    reason,
    message: '该成员无法按当前规则获得完整可分页正文，未返回截断前缀。',
    retryable: false,
  });
}
/** In-memory parser adapter only. No publication, temporary ordinary file or
 * independent member authority is created. Parser failures never become text. */
export async function parseReferenceArchiveText(
  bytes: Buffer,
  path: string,
  signal: AbortSignal,
) {
  checkReferenceImageSignal(signal);
  const extension = path.toLowerCase().split('.').pop() ?? '';
  const documents: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  const plain: Record<string, string> = {
    txt: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
  };
  if (plain[extension]) {
    if (
      bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      (bytes.length >= 2 && bytes.readUInt16BE(0) === 0xffd8)
    )
      rejected('media_type');
    if (bytes.length > maximumKnowledgeTextBytes) rejected('member_bytes');
    if (
      bytes.length >= 4 &&
      [0x04034b50, 0x06054b50, 0x06064b50].includes(bytes.readUInt32LE(0))
    )
      rejected('nested_archive');
    if (
      bytes.subarray(0, 2).toString('ascii') === 'MZ' ||
      bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) ||
      bytes.includes(0)
    )
      rejected('media_type');
    let text: string;
    try {
      text = decodeReferenceText(bytes);
    } catch {
      rejected('text_unavailable');
    }
    if (!text.trim()) rejected('text_unavailable');
    return {
      mediaType: plain[extension],
      fullText: {
        kind: 'text' as const,
        text,
        warnings: [],
        units: [{ label: '正文', start: 0, end: text.length }],
      },
    };
  }
  const mediaType = documents[extension];
  if (!mediaType) rejected('media_type');
  try {
    const fullText = await extractReferenceDocumentBytes(
      bytes,
      mediaType,
      path,
      signal,
    );
    checkReferenceImageSignal(signal);
    return { fullText, mediaType };
  } catch (error) {
    checkReferenceImageSignal(signal);
    if (error instanceof IncompleteReferenceText) rejected('text_unavailable');
    if (error instanceof HandlerError) {
      if (
        [
          'OFFICE_CHART_TEXT_INCOMPLETE',
          'PDF_PASSWORD_REQUIRED',
          'PDF_INVALID',
          'TOOL_FILE_TYPE_UNSUPPORTED',
        ].includes(error.code)
      )
        rejected('text_unavailable');
      throw error;
    }
    // Local document libraries reject malformed package bytes with untyped
    // parser errors; infrastructure errors with a code retain that code.
    if (error instanceof Error && !('code' in error))
      rejected('text_unavailable');
    throw error;
  }
}
