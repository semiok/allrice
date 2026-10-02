import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import type { PDFParse as PdfParser } from 'pdf-parse';

export const PDF_MAXIMUM_INPUT_BYTES = 20 * 1024 * 1024;
export const PDF_MAXIMUM_RESULT_BYTES = 400_000;
export const PDF_MAXIMUM_PAGES = 10;

const defaultMaximumCharacters = 120_000;
const absoluteMaximumCharacters = 300_000;
type PdfReaderRuntime = {
  PDFParse: typeof PdfParser;
  resourcesDirectory: string;
};
let trustedRuntime: PdfReaderRuntime | undefined;

/** Fixed packaged native resources only. This is a trusted loader seam, never
 * a document option or a model-provided module/worker path. */
export function configureTrustedPdfReaderRuntime(runtime: PdfReaderRuntime) {
  if (trustedRuntime) throw Error('PDF_RUNTIME_ALREADY_CONFIGURED');
  trustedRuntime = runtime;
}

async function pdfReaderRuntime(): Promise<PdfReaderRuntime> {
  if (trustedRuntime) return trustedRuntime;
  const { PDFParse } = await import('pdf-parse');
  const packageRequire = createRequire(import.meta.url);
  const pdfParseRequire = createRequire(packageRequire.resolve('pdf-parse'));
  return {
    PDFParse,
    resourcesDirectory: dirname(
      pdfParseRequire.resolve('pdfjs-dist/package.json'),
    ),
  };
}

export type PdfReadErrorCode =
  | 'PDF_INPUT_TOO_LARGE'
  | 'PDF_INVALID_OPTIONS'
  | 'PDF_PAGE_OUT_OF_RANGE'
  | 'PDF_PASSWORD_REQUIRED'
  | 'PDF_PARSE_FAILED';

export class PdfReadError extends Error {
  constructor(
    public readonly code: PdfReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PdfReadError';
  }
}

export type PdfWarningCode =
  | 'PDF_PAGES_TRUNCATED'
  | 'PDF_CONTENT_TRUNCATED'
  | 'PDF_NO_EXTRACTABLE_TEXT'
  | 'PDF_TABLE_HEURISTIC'
  | 'PDF_TABLE_NOT_DETECTED'
  | 'PDF_TABLE_FRAGMENTS_NOT_MERGED';

export interface PdfReadResult {
  kind: 'pdf';
  text: string;
  truncated: boolean;
  units: { label: string; text: string; pageNumber: number }[];
  warnings: string[];
  totalPages: number;
  requestedPages: number[];
  nextPages: number[];
  quality: 'digital_text' | 'no_extractable_text';
  warningCodes: PdfWarningCode[];
  parser: { name: 'pdf-parse'; version: '2.4.5' };
  tables?: {
    pageNumber: number;
    tableNumber: number;
    rows: { rowNumber: number; cells: string[] }[];
  }[];
}

const warningMessages: Record<PdfWarningCode, string> = {
  PDF_PAGES_TRUNCATED:
    '本批只读取 requestedPages 所列的物理页；其他页未包含在结果中。',
  PDF_CONTENT_TRUNCATED:
    '返回内容达到字符或 JSON 字节上限；nextPages 包含未完整返回的页。重新读取该页仍从页首开始，没有可恢复的文字偏移；表格只保留完整行。',
  PDF_NO_EXTRACTABLE_TEXT:
    '本批未提取到可用文字层；可能是图片、空白页或文字编码问题。当前读取不执行 OCR。',
  PDF_TABLE_HEURISTIC:
    '表格由 pdf-parse 的原生线框识别提取，可能遗漏或误识别；单元格保持原始字符串，数字与合并单元格需核对原页。',
  PDF_TABLE_NOT_DETECTED:
    '本批未识别到线框表格；无边框布局不保证可恢复为表格，可参照带页码的文本核对。',
  PDF_TABLE_FRAGMENTS_NOT_MERGED:
    '不同页的表格分别保留页码、表号和行号；未自动合并跨页片段或删除重复表头。',
};

function normalizeText(value: string) {
  return value
    .replaceAll('\u0000', '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function hasExtractableText(text: string) {
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (
      code > 0x1f &&
      code !== 0x7f &&
      code !== 0xfffd &&
      !/\s/u.test(character)
    )
      return true;
  }
  return false;
}

function stringCharacters(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + stringCharacters(item), 0);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).reduce<number>(
      (sum, item) => sum + stringCharacters(item),
      0,
    );
  }
  return 0;
}

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function stringJsonBytes(value: string) {
  // Quotes, control characters, backslashes and non-ASCII all count here.
  return jsonBytes(value) - 2;
}

interface Cost {
  bytes: number;
  characters: number;
}

class ResultBudget {
  private bytes: number;
  private characters: number;

  constructor(
    reserved: PdfReadResult,
    private readonly maximumCharacters: number,
  ) {
    this.bytes = jsonBytes(reserved);
    this.characters = stringCharacters(reserved);
  }

  fits(cost: Cost) {
    return (
      this.bytes + cost.bytes <= PDF_MAXIMUM_RESULT_BYTES &&
      this.characters + cost.characters <= this.maximumCharacters
    );
  }

  add(cost: Cost) {
    this.bytes += cost.bytes;
    this.characters += cost.characters;
  }

  textPrefix(text: string, cost: (value: string) => Cost) {
    let low = 0;
    let high = Math.min(text.length, this.maximumCharacters);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.fits(cost(text.slice(0, middle)))) low = middle;
      else high = middle - 1;
    }
    // Do not split a surrogate pair at the output boundary.
    if (
      low > 0 &&
      low < text.length &&
      /[\uD800-\uDBFF]/.test(text.charAt(low - 1)) &&
      /[\uDC00-\uDFFF]/.test(text.charAt(low))
    ) {
      low -= 1;
    }
    return text.slice(0, low);
  }
}

function canonicalPages(pages: number[] | undefined) {
  if (pages === undefined) return undefined;
  if (
    !Array.isArray(pages) ||
    pages.length === 0 ||
    pages.some((page) => !Number.isSafeInteger(page) || page < 1)
  ) {
    throw new PdfReadError(
      'PDF_INVALID_OPTIONS',
      'PDF 页码必须是从 1 开始的正安全整数，且页码列表不能为空。',
    );
  }
  if (pages.length > PDF_MAXIMUM_PAGES) {
    throw new PdfReadError(
      'PDF_INVALID_OPTIONS',
      `每批最多提供 ${PDF_MAXIMUM_PAGES} 个 PDF 页码（包括重复项）。`,
    );
  }
  return [...new Set(pages)].sort((left, right) => left - right);
}

function followingPages(lastPage: number, totalPages: number) {
  return Array.from(
    { length: Math.min(PDF_MAXIMUM_PAGES, totalPages - lastPage) },
    (_, index) => lastPage + index + 1,
  );
}

function parserError(error: unknown): PdfReadError {
  if (error instanceof PdfReadError) return error;
  if (error instanceof Error && error.name === 'PasswordException') {
    return new PdfReadError(
      'PDF_PASSWORD_REQUIRED',
      'PDF 需要密码，当前读取不支持提供解密密码。',
    );
  }
  return new PdfReadError(
    'PDF_PARSE_FAILED',
    '无法解析 PDF；请检查文件是否完整且为有效 PDF。',
  );
}

export async function readPdfDocument(input: {
  bytes: Uint8Array;
  pages?: number[];
  maximumCharacters?: number;
  includeStructure?: boolean;
}): Promise<PdfReadResult> {
  if (!(input.bytes instanceof Uint8Array)) {
    throw new PdfReadError('PDF_INVALID_OPTIONS', 'PDF 输入必须是文件字节。');
  }
  if (input.bytes.byteLength > PDF_MAXIMUM_INPUT_BYTES) {
    throw new PdfReadError('PDF_INPUT_TOO_LARGE', 'PDF 超过 20 MiB 解析上限。');
  }
  const selectedPages = canonicalPages(input.pages);
  const maximumCharacters = input.maximumCharacters ?? defaultMaximumCharacters;
  if (
    !Number.isSafeInteger(maximumCharacters) ||
    maximumCharacters < 1 ||
    (input.includeStructure !== undefined &&
      typeof input.includeStructure !== 'boolean')
  ) {
    throw new PdfReadError('PDF_INVALID_OPTIONS', 'PDF 读取选项无效。');
  }
  const boundedCharacters = Math.min(
    Math.max(maximumCharacters, 1_000),
    absoluteMaximumCharacters,
  );
  const { PDFParse, resourcesDirectory: pdfJsResources } =
    await pdfReaderRuntime();
  const parser = new PDFParse({
    data: input.bytes,
    isEvalSupported: false,
    enableXfa: false,
    useSystemFonts: false,
    useWorkerFetch: false,
    cMapUrl: join(pdfJsResources, 'cmaps') + sep,
    cMapPacked: true,
    standardFontDataUrl: join(pdfJsResources, 'standard_fonts') + sep,
    wasmUrl: join(pdfJsResources, 'wasm') + sep,
  });
  let primaryError: PdfReadError | undefined;
  let parsedResult: PdfReadResult | undefined;
  try {
    const extracted = await parser.getText(
      selectedPages
        ? { partial: [...selectedPages] }
        : { first: PDF_MAXIMUM_PAGES },
    );
    const totalPages = extracted.total;
    if (!Number.isSafeInteger(totalPages) || totalPages < 1) {
      throw new PdfReadError('PDF_PARSE_FAILED', 'PDF 没有有效的物理页。');
    }
    if (selectedPages?.some((page) => page > totalPages)) {
      throw new PdfReadError(
        'PDF_PAGE_OUT_OF_RANGE',
        `PDF 页码超出实际页数 ${totalPages}。`,
      );
    }
    const requestedPages =
      selectedPages ??
      Array.from(
        { length: Math.min(PDF_MAXIMUM_PAGES, totalPages) },
        (_, index) => index + 1,
      );
    const rawPages = extracted.pages.map((page) => ({
      pageNumber: page.num,
      text: normalizeText(page.text),
    }));
    if (
      rawPages.length !== requestedPages.length ||
      rawPages.some((page, index) => page.pageNumber !== requestedPages[index])
    ) {
      throw new PdfReadError('PDF_PARSE_FAILED', 'PDF 分页读取结果不完整。');
    }
    const structured = input.includeStructure
      ? await parser.getTable({ partial: [...requestedPages] })
      : undefined;
    const tablePages = structured?.pages ?? [];
    const pagesWithTables = tablePages.filter((page) => page.tables.length > 0);
    const quality = rawPages.some((page) => hasExtractableText(page.text))
      ? 'digital_text'
      : 'no_extractable_text';
    const warningCodes: PdfWarningCode[] = [];
    if (requestedPages.length < totalPages)
      warningCodes.push('PDF_PAGES_TRUNCATED');
    if (quality === 'no_extractable_text')
      warningCodes.push('PDF_NO_EXTRACTABLE_TEXT');
    if (structured) {
      warningCodes.push('PDF_TABLE_HEURISTIC');
      if (pagesWithTables.length === 0)
        warningCodes.push('PDF_TABLE_NOT_DETECTED');
      if (pagesWithTables.length > 1)
        warningCodes.push('PDF_TABLE_FRAGMENTS_NOT_MERGED');
    }
    const futurePages = followingPages(requestedPages.at(-1)!, totalPages);
    const result: PdfReadResult = {
      kind: 'pdf',
      text: '',
      truncated: requestedPages.length < totalPages,
      units: [],
      warnings: warningCodes.map((code) => warningMessages[code]),
      totalPages,
      requestedPages,
      nextPages: futurePages,
      quality,
      warningCodes,
      parser: { name: 'pdf-parse', version: '2.4.5' },
      ...(structured ? { tables: [] } : {}),
    };
    // Reserve a possible truncation warning and the largest continuation list
    // before adding text or rows; later metadata cannot push us over either cap.
    const budget = new ResultBudget(
      {
        ...result,
        truncated: false,
        nextPages: Array<number>(PDF_MAXIMUM_PAGES).fill(
          Number.MAX_SAFE_INTEGER,
        ),
        warnings: [...result.warnings, warningMessages.PDF_CONTENT_TRUNCATED],
        warningCodes: [...warningCodes, 'PDF_CONTENT_TRUNCATED'],
      },
      boundedCharacters,
    );
    const incompletePages = new Set<number>();
    for (const [index, page] of rawPages.entries()) {
      const label = `第 ${page.pageNumber} 页`;
      const heading = `${result.units.length ? '\n\n' : ''}## ${label}\n\n`;
      const cost = (text: string): Cost => ({
        bytes:
          jsonBytes({ label, text, pageNumber: page.pageNumber }) +
          (result.units.length ? 1 : 0) +
          stringJsonBytes(heading + text),
        characters: label.length + heading.length + text.length * 2,
      });
      if (!budget.fits(cost(''))) {
        for (const remaining of rawPages.slice(index))
          incompletePages.add(remaining.pageNumber);
        break;
      }
      const text = budget.textPrefix(page.text, cost);
      budget.add(cost(text));
      result.units.push({ label, text, pageNumber: page.pageNumber });
      result.text += heading + text;
      if (text.length < page.text.length) {
        for (const remaining of rawPages.slice(index))
          incompletePages.add(remaining.pageNumber);
        break;
      }
    }
    tableLoop: for (const [pageIndex, page] of tablePages.entries()) {
      for (const [tableIndex, rawRows] of page.tables.entries()) {
        const table: NonNullable<PdfReadResult['tables']>[number] = {
          pageNumber: page.num,
          tableNumber: tableIndex + 1,
          rows: [],
        };
        const tableCost: Cost = {
          bytes: jsonBytes(table) + (result.tables!.length ? 1 : 0),
          characters: 0,
        };
        let addedTable = false;
        for (const [rowIndex, cells] of rawRows.entries()) {
          const wrapperBytes = addedTable ? 0 : tableCost.bytes;
          const minimumRowBytes = Math.max(0, cells.length * 3 - 1);
          let characters = 0;
          let fits = budget.fits({
            bytes: minimumRowBytes + wrapperBytes,
            characters,
          });
          if (fits) {
            for (const cell of cells) {
              characters += cell.length;
              if (!budget.fits({ bytes: 0, characters })) {
                fits = false;
                break;
              }
            }
          }
          // Native rows are already strings. Do not clone or JSON-encode a
          // massive row whose minimum size or characters cannot fit.
          const cost = fits
            ? {
                bytes:
                  jsonBytes({ rowNumber: rowIndex + 1, cells }) +
                  (table.rows.length ? 1 : 0) +
                  wrapperBytes,
                characters,
              }
            : undefined;
          if (!cost || !budget.fits(cost)) {
            for (const remaining of tablePages.slice(pageIndex))
              incompletePages.add(remaining.num);
            break tableLoop;
          }
          budget.add(cost);
          if (!addedTable) {
            result.tables!.push(table);
            addedTable = true;
          }
          table.rows.push({ rowNumber: rowIndex + 1, cells });
        }
      }
    }
    if (incompletePages.size > 0) {
      result.truncated = true;
      result.warningCodes.push('PDF_CONTENT_TRUNCATED');
      result.warnings.push(warningMessages.PDF_CONTENT_TRUNCATED);
      result.nextPages = [...new Set([...incompletePages, ...futurePages])]
        .sort((left, right) => left - right)
        .slice(0, PDF_MAXIMUM_PAGES);
    }
    if (
      jsonBytes(result) > PDF_MAXIMUM_RESULT_BYTES ||
      stringCharacters(result) > boundedCharacters
    ) {
      throw new PdfReadError('PDF_PARSE_FAILED', 'PDF 返回结果超出安全预算。');
    }
    parsedResult = result;
  } catch (error) {
    primaryError = parserError(error);
  } finally {
    try {
      await parser.destroy();
    } catch (error) {
      primaryError ??= parserError(error);
    }
  }
  if (primaryError) throw primaryError;
  if (!parsedResult)
    throw new PdfReadError('PDF_PARSE_FAILED', 'PDF 未返回解析结果。');
  return parsedResult;
}
