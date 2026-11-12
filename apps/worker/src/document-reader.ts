import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import {
  PdfReadError,
  readPdfDocument,
  type PdfReadResult,
} from '@allrice/office-runtime/pdf-reader';

import { HandlerError } from './errors.js';
import { OfficePackage, children, elements, ns } from './office/package.js';

export const maximumDocumentBytes = 20 * 1024 * 1024;
export const defaultMaximumCharacters = 120_000;
const absoluteMaximumCharacters = 300_000;

export interface ParsedDocument extends Partial<
  Omit<PdfReadResult, 'kind' | 'text' | 'truncated' | 'units' | 'warnings'>
> {
  kind: 'text' | 'pdf' | 'docx' | 'xlsx' | 'pptx';
  text: string;
  truncated: boolean;
  units: {
    label: string;
    text: string;
    pageNumber?: number;
    sheetName?: string;
  }[];
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
  const normalizedUnits = units.map((unit) => ({
    ...unit,
    text: normalizeText(unit.text),
  }));
  const joined = normalizedUnits
    .map((unit) => `## ${unit.label}\n\n${unit.text}`)
    .join('\n\n');
  const truncated = joined.length > boundedMaximum;
  return {
    kind,
    text: truncated ? joined.slice(0, boundedMaximum) : joined,
    truncated,
    units: normalizedUnits,
    warnings: [
      ...warnings,
      ...(truncated
        ? [`内容超过 ${boundedMaximum} 字符，已在安全上限处截断。`]
        : []),
    ],
  };
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
    units.push({
      label: `工作表：${worksheet.name}`,
      sheetName: worksheet.name,
      text: rows.join('\n'),
    });
  });
  return limitDocument('xlsx', units, maximumCharacters);
}

async function parsePptx(bytes: Buffer, maximumCharacters: number) {
  // Reuse the Office reader's relationship order and namespace-aware XML.
  const pkg = await OfficePackage.open(bytes, 'pptx', { readOnly: true });
  const units: ParsedDocument['units'] = [];
  const warnings: string[] = [];
  for (const part of await pkg.orderedParts()) {
    const doc = await pkg.xml(part.path);
    const text = elements(doc, ns.a, 't').map((element) => element.textContent);
    const chartNamespace =
      'http://schemas.openxmlformats.org/drawingml/2006/chart';
    const extendedChartNamespace =
      'http://schemas.microsoft.com/office/drawing/2014/chartex';
    if (
      elements(doc, ns.a, 'graphicData').some(
        (node) => node.getAttribute('uri') === extendedChartNamespace,
      )
    )
      incompleteChartText();
    const charts = elements(doc, chartNamespace, 'chart');
    if (charts.length) {
      const links = await pkg.links(part.path);
      for (const [index, chart] of charts.entries()) {
        const path = links.get(chart.getAttributeNS(ns.r, 'id') ?? '');
        if (!path) incompleteChartText();
        const chartDoc = await pkg.xml(path);
        // Cached values are source strings, never JS numbers or recalculated
        // formulas. Missing/sparse caches cannot establish complete chart text.
        const cacheNames = [
          'strCache',
          'numCache',
          'multiLvlStrCache',
          'strLit',
          'numLit',
        ];
        for (const [ref, cache] of [
          ['strRef', 'strCache'],
          ['numRef', 'numCache'],
          ['multiLvlStrRef', 'multiLvlStrCache'],
        ] as const)
          for (const node of elements(chartDoc, chartNamespace, ref))
            if (children(node, chartNamespace, cache).length !== 1)
              incompleteChartText();
        const caches = cacheNames.flatMap((name) =>
          elements(chartDoc, chartNamespace, name),
        );
        if (!caches.length) incompleteChartText();
        for (const name of ['cat', 'val', 'xVal', 'yVal', 'bubbleSize'])
          for (const data of elements(chartDoc, chartNamespace, name))
            if (
              !cacheNames.some(
                (cache) => elements(data, chartNamespace, cache).length,
              )
            )
              incompleteChartText();
        for (const cache of caches) {
          const countText = children(
            cache,
            chartNamespace,
            'ptCount',
          )[0]?.getAttribute('val');
          const count = Number(countText);
          if (
            countText === null ||
            countText === undefined ||
            !/^\d+$/.test(countText) ||
            !Number.isSafeInteger(count)
          )
            incompleteChartText();
          const groups =
            cache.localName === 'multiLvlStrCache'
              ? children(cache, chartNamespace, 'lvl')
              : [cache];
          if (!groups.length && count) incompleteChartText();
          for (const group of groups) {
            const points = children(group, chartNamespace, 'pt');
            const indexes = points.map((point) =>
              Number(point.getAttribute('idx')),
            );
            if (
              points.length !== count ||
              new Set(indexes).size !== count ||
              points.some(
                (point) =>
                  !/^\d+$/.test(point.getAttribute('idx') ?? '') ||
                  !Number.isSafeInteger(Number(point.getAttribute('idx'))) ||
                  Number(point.getAttribute('idx')) >= count ||
                  children(point, chartNamespace, 'v').length !== 1,
              )
            )
              incompleteChartText();
          }
        }
        text.push(
          `图表 ${index + 1}`,
          ...elements(chartDoc, ns.a, 't').map((node) => node.textContent),
          ...elements(chartDoc, chartNamespace, 'v').map(
            (node) => node.textContent,
          ),
        );
      }
      warnings.push('图表数值来自文件内的完整缓存，未重新计算公式。');
    }
    units.push({
      label: `第 ${part.index} 页`,
      pageNumber: part.index,
      text: text.join('\n'),
    });
  }
  return limitDocument('pptx', units, maximumCharacters, [
    ...new Set(warnings),
  ]);
}

function incompleteChartText(): never {
  throw new HandlerError(
    'OFFICE_CHART_TEXT_INCOMPLETE',
    'PPTX 图表正文缺少完整缓存，当前无法完整提取。',
    false,
  );
}

export async function parseDocument(input: {
  bytes: Buffer;
  mediaType: string;
  fileName: string;
  maximumCharacters?: number;
  pages?: number[];
  includeStructure?: boolean;
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
    try {
      return await readPdfDocument({
        bytes: input.bytes,
        maximumCharacters,
        ...(input.pages === undefined ? {} : { pages: input.pages }),
        ...(input.includeStructure === undefined
          ? {}
          : { includeStructure: input.includeStructure }),
      });
    } catch (error) {
      if (error instanceof PdfReadError) {
        throw new HandlerError(error.code, error.message, false);
      }
      throw error;
    }
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
