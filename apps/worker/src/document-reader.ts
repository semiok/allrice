import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

import { HandlerError } from './errors.js';

const maximumDocumentBytes = 20 * 1024 * 1024;
const defaultMaximumCharacters = 120_000;
const absoluteMaximumCharacters = 300_000;

export interface ParsedDocument {
  kind: 'text' | 'pdf' | 'docx' | 'xlsx' | 'pptx';
  text: string;
  truncated: boolean;
  units: { label: string; text: string }[];
  warnings: string[];
}

function normalizeText(value: string) {
  return value
    .replaceAll('\u0000', '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function decodeXml(value: string) {
  return value
    .replace(/<a:br\s*\/>/g, '\n')
    .replace(/<a:tab\s*\/>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function limitDocument(
  kind: ParsedDocument['kind'],
  units: ParsedDocument['units'],
  maximumCharacters: number,
  warnings: string[] = [],
): ParsedDocument {
  const boundedMaximum = Math.min(
    Math.max(Math.trunc(maximumCharacters), 1_000),
    absoluteMaximumCharacters,
  );
  const joined = units
    .map((unit) => `## ${unit.label}\n\n${normalizeText(unit.text)}`)
    .join('\n\n');
  const truncated = joined.length > boundedMaximum;
  return {
    kind,
    text: truncated ? joined.slice(0, boundedMaximum) : joined,
    truncated,
    units,
    warnings: [
      ...warnings,
      ...(truncated
        ? [`内容超过 ${boundedMaximum} 字符，已在安全上限处截断。`]
        : []),
    ],
  };
}

async function parsePdf(bytes: Buffer, maximumCharacters: number) {
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    const pages = result.pages.map((page, index) => ({
      label: `第 ${page.num ?? index + 1} 页`,
      text: page.text,
    }));
    return limitDocument('pdf', pages, maximumCharacters);
  } finally {
    await parser.destroy();
  }
}

async function parseDocx(bytes: Buffer, maximumCharacters: number) {
  const result = await mammoth.extractRawText({ buffer: bytes });
  return limitDocument(
    'docx',
    [{ label: '正文', text: result.value }],
    maximumCharacters,
    result.messages.map((message) => message.message),
  );
}

async function parseXlsx(bytes: Buffer, maximumCharacters: number) {
  const workbook = new ExcelJS.Workbook();
  const workbookBytes = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  await workbook.xlsx.load(workbookBytes);
  const units: ParsedDocument['units'] = [];
  workbook.eachSheet((worksheet) => {
    const rows: string[] = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values;
      if (!Array.isArray(values)) return;
      rows.push(
        values
          .slice(1)
          .map((value) => {
            if (value === null || value === undefined) return '';
            if (typeof value === 'object') {
              if ('text' in value && typeof value.text === 'string') {
                return value.text;
              }
              if ('formula' in value || 'sharedFormula' in value)
                return `=${'formula' in value ? value.formula : `[共享公式 ${value.sharedFormula}]`}${'result' in value && value.result !== undefined ? `（缓存：${value.result}）` : '（未计算）'}`;
              if ('result' in value) return String(value.result ?? '');
              if ('richText' in value && Array.isArray(value.richText)) {
                return value.richText
                  .map((part) =>
                    typeof part === 'object' && part !== null && 'text' in part
                      ? String(part.text)
                      : '',
                  )
                  .join('');
              }
            }
            return String(value);
          })
          .join('\t'),
      );
    });
    units.push({ label: `工作表：${worksheet.name}`, text: rows.join('\n') });
  });
  return limitDocument('xlsx', units, maximumCharacters);
}

async function parsePptx(bytes: Buffer, maximumCharacters: number) {
  const archive = await JSZip.loadAsync(bytes);
  const slidePaths = Object.keys(archive.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((left, right) => {
      const leftIndex = Number(left.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
      const rightIndex = Number(right.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
      return leftIndex - rightIndex;
    });
  const units = await Promise.all(
    slidePaths.map(async (path, index) => {
      const xml = await archive.file(path)!.async('string');
      const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) =>
        decodeXml(match[1] ?? ''),
      );
      return { label: `第 ${index + 1} 页`, text: runs.join('\n') };
    }),
  );
  return limitDocument('pptx', units, maximumCharacters);
}

export async function parseDocument(input: {
  bytes: Buffer;
  mediaType: string;
  fileName: string;
  maximumCharacters?: number;
}): Promise<ParsedDocument> {
  if (input.bytes.byteLength > maximumDocumentBytes) {
    throw new HandlerError(
      'TOOL_FILE_TOO_LARGE',
      '文档超过 20 MB 的安全解析上限',
      false,
    );
  }
  const maximumCharacters = input.maximumCharacters ?? defaultMaximumCharacters;
  const extension = input.fileName.toLowerCase().split('.').pop() ?? '';
  if (input.mediaType === 'application/pdf' || extension === 'pdf') {
    return parsePdf(input.bytes, maximumCharacters);
  }
  if (
    input.mediaType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    extension === 'docx'
  ) {
    return parseDocx(input.bytes, maximumCharacters);
  }
  if (
    input.mediaType ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    extension === 'xlsx'
  ) {
    return parseXlsx(input.bytes, maximumCharacters);
  }
  if (
    input.mediaType ===
      'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    extension === 'pptx'
  ) {
    return parsePptx(input.bytes, maximumCharacters);
  }
  if (
    input.mediaType.startsWith('text/') ||
    input.mediaType === 'application/json' ||
    ['md', 'txt', 'json', 'csv', 'tsv', 'yaml', 'yml'].includes(extension)
  ) {
    return limitDocument(
      'text',
      [{ label: '正文', text: input.bytes.toString('utf8') }],
      maximumCharacters,
    );
  }
  throw new HandlerError(
    'TOOL_FILE_TYPE_UNSUPPORTED',
    '当前支持 PDF、DOCX、XLSX、PPTX、Markdown、文本和 JSON；图片请作为消息附件直接发送给 Rice。',
    false,
  );
}
