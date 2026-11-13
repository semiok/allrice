import { createHash } from 'node:crypto';
import {
  claimReferenceProcessing,
  finishReferenceProcessing,
  failReferenceProcessing,
  isIndexableKnowledgeTextSource,
  type ReferenceFullText,
  type ReferenceProcessingClaim,
} from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import {
  hasExtractablePdfText,
  PDF_MAXIMUM_RESULT_BYTES,
} from '@allrice/office-runtime/pdf-reader';
import { chunkKnowledgeText, readKnowledgeText } from './knowledge.js';
import { HandlerError } from './errors.js';
import {
  defaultMaximumCharacters,
  maximumDocumentBytes,
  parseDocument,
  type ParsedDocument,
} from './document-reader.js';

const documentMediaTypes = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];

class IncompleteReferenceText extends Error {}

async function verifiedDocumentBytes(
  storage: LocalStorageAdapter,
  object: ReferenceProcessingClaim['object'],
) {
  const reader = (await storage.get(object)).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximumDocumentBytes)
        throw new IncompleteReferenceText(
          '文档超过现有安全解析上限，尚不可全文检索。',
        );
      parts.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(parts);
  if (
    bytes.length !== object.sizeBytes ||
    'sha256:' + createHash('sha256').update(bytes).digest('hex') !==
      object.checksum
  )
    throw new Error('资料文件校验失败');
  return bytes;
}

function addParsedUnits(fullText: ReferenceFullText, parsed: ParsedDocument) {
  const base = fullText.text.length;
  const separator = base ? '\n\n' : '';
  fullText.text += separator + parsed.text;
  let cursor = 0;
  for (const unit of parsed.units) {
    const heading = `${cursor ? '\n\n' : ''}## ${unit.label}\n\n`;
    const start = cursor + heading.length;
    if (!parsed.text.startsWith(heading + unit.text, cursor))
      throw new Error('资料正文定位不完整');
    fullText.units.push({
      label: unit.label,
      start: base + separator.length + start,
      end: base + separator.length + start + unit.text.length,
      ...(unit.pageNumber === undefined ? {} : { pageNumber: unit.pageNumber }),
      ...(unit.sheetName === undefined ? {} : { sheetName: unit.sheetName }),
    });
    cursor = start + unit.text.length;
  }
  if (cursor !== parsed.text.length) throw new Error('资料正文定位不完整');
  fullText.warnings = [
    ...new Set([
      ...fullText.warnings,
      ...parsed.warnings.filter(
        (_, index) => parsed.warningCodes?.[index] !== 'PDF_PAGES_TRUNCATED',
      ),
    ]),
  ];
  if (parsed.tables) (fullText.tables ??= []).push(...parsed.tables);
}

async function extractDocumentText(
  storage: LocalStorageAdapter,
  claim: ReferenceProcessingClaim,
): Promise<ReferenceFullText> {
  const bytes = await verifiedDocumentBytes(storage, claim.object);
  const input = {
    bytes,
    mediaType: claim.object.mediaType,
    fileName: claim.fileName,
    includeStructure: true,
    requireCompleteText: true as const,
  };
  let parsed = await parseDocument(input);
  const fullText: ReferenceFullText = {
    kind: parsed.kind,
    text: '',
    units: [],
    warnings: [],
    ...(parsed.totalPages === undefined
      ? {}
      : { totalPages: parsed.totalPages }),
    ...(parsed.parser ? { parser: parsed.parser } : {}),
  };
  const seenPages = new Set<number>();
  let returnedCharacters = 0;
  while (true) {
    // PDF truncated also means deliberately selected pages. Only the native
    // content warning is fatal here; every remaining physical page is visited.
    if (
      (parsed.kind !== 'pdf' && parsed.truncated) ||
      parsed.warningCodes?.includes('PDF_CONTENT_TRUNCATED')
    )
      throw new IncompleteReferenceText(
        '正文达到现有解析上限，尚不可全文检索。',
      );
    if (parsed.kind === 'pdf') {
      if (
        !parsed.totalPages ||
        !parsed.requestedPages?.length ||
        parsed.units.length !== parsed.requestedPages.length ||
        parsed.units.some(
          (unit, index) =>
            unit.pageNumber !== parsed.requestedPages![index] ||
            seenPages.has(unit.pageNumber!),
        )
      )
        throw new Error('资料分页提取不完整');
      if (
        parsed.quality === 'no_extractable_text' ||
        parsed.warningCodes?.includes('PDF_NO_EXTRACTABLE_TEXT') ||
        parsed.units.some((unit) => !hasExtractablePdfText(unit.text))
      )
        throw new IncompleteReferenceText(
          '部分页面没有可提取文字，尚不可全文检索；当前不执行 OCR。',
        );
      for (const unit of parsed.units) seenPages.add(unit.pageNumber!);
      // Keep the shared reader's existing character budget across all batches,
      // including its duplicate text/unit and table representation costs.
      returnedCharacters +=
        parsed.text.length +
        parsed.units.reduce(
          (sum, unit) => sum + unit.label.length + unit.text.length,
          0,
        ) +
        (parsed.tables ?? []).reduce(
          (sum, table) =>
            sum +
            table.rows.reduce(
              (rows, row) =>
                rows +
                row.cells.reduce((cells, cell) => cells + cell.length, 0),
              0,
            ),
          0,
        );
      if (returnedCharacters > defaultMaximumCharacters)
        throw new IncompleteReferenceText(
          '正文达到现有解析上限，尚不可全文检索。',
        );
    }
    addParsedUnits(fullText, parsed);
    if (
      fullText.kind === 'pdf' &&
      Buffer.byteLength(JSON.stringify(fullText)) > PDF_MAXIMUM_RESULT_BYTES
    )
      throw new IncompleteReferenceText(
        '正文达到现有解析上限，尚不可全文检索。',
      );
    if (parsed.kind !== 'pdf' || seenPages.size === parsed.totalPages) break;
    const pages = parsed.nextPages;
    if (!pages?.length || pages.some((page) => seenPages.has(page)))
      throw new Error('资料分页提取不完整');
    parsed = await parseDocument({
      ...input,
      pages,
      maximumCharacters: Math.max(
        1,
        defaultMaximumCharacters - returnedCharacters,
      ),
    });
  }
  if (
    !fullText.units.some((unit) =>
      fullText.text.slice(unit.start, unit.end).trim(),
    )
  )
    throw new Error('资料没有可检索的文本');
  return fullText;
}

/** Deterministic processing of published fixed files. No employee/model Run. */
export async function processNextReference(storageRoot: string) {
  const claim = await claimReferenceProcessing(true);
  if (!claim) return false;
  const textSource = isIndexableKnowledgeTextSource(claim.object);
  const documentSource =
    documentMediaTypes.includes(claim.object.mediaType) &&
    claim.object.sizeBytes >= 0 &&
    claim.object.sizeBytes <= maximumDocumentBytes;
  if (!textSource && !documentSource) {
    await failReferenceProcessing(
      claim,
      '文件已保存，可预览和下载；当前格式或大小暂不支持检索。',
      true,
    );
    return true;
  }
  try {
    const storage = new LocalStorageAdapter(storageRoot);
    let fullText: ReferenceFullText;
    if (textSource) {
      const text = await readKnowledgeText(storage, claim.object, true, {
        preserveText: true,
      });
      if (!text.trim()) throw new Error('资料没有可检索的文本');
      fullText = {
        kind: 'text',
        text,
        warnings: [],
        units: [{ label: '正文', start: 0, end: text.length }],
      };
    } else {
      fullText = await extractDocumentText(storage, claim);
    }
    await finishReferenceProcessing(
      claim,
      chunkKnowledgeText(fullText.text, { preserveOffsets: true }),
      fullText,
    );
  } catch (error) {
    if (error instanceof IncompleteReferenceText) {
      await failReferenceProcessing(claim, error.message, true);
      return true;
    }
    if (
      error instanceof HandlerError &&
      error.code === 'OFFICE_CHART_TEXT_INCOMPLETE'
    ) {
      await failReferenceProcessing(
        claim,
        '图表正文暂不能完整提取，尚不可全文检索；原文件已保留。',
        true,
      );
      return true;
    }
    if (
      error instanceof HandlerError &&
      error.code === 'PDF_PASSWORD_REQUIRED'
    ) {
      await failReferenceProcessing(
        claim,
        'PDF 需要密码，当前无法解析；原文件已保留。',
      );
      return true;
    }
    // Never publish filesystem details or arbitrary parser exceptions to tenants.
    const reason =
      error instanceof Error &&
      ['资料没有可检索的文本', '资料已停用', '资料文件校验失败'].includes(
        error.message,
      )
        ? error.message
        : '资料处理失败，请重试；原文件已保留。';
    await failReferenceProcessing(claim, reason);
  }
  return true;
}
