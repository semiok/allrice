import { readFileSync } from 'node:fs';
import { Document, Packer, Paragraph } from 'docx';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { parseDocument } from './document-reader.js';

const pdfFixtures = new URL('../../../tests/fixtures/pdf/', import.meta.url);
const readPdfFixture = (name: string) =>
  readFileSync(new URL(name, pdfFixtures));

describe('parseDocument', () => {
  it('parses common text with a stable section locator', async () => {
    const parsed = await parseDocument({
      bytes: Buffer.from('# Hello\n\nAllRice'),
      mediaType: 'text/markdown',
      fileName: 'brief.md',
    });
    expect(parsed.kind).toBe('text');
    expect(parsed.text).toContain('## 正文');
    expect(parsed.text).toContain('AllRice');
  });

  it('parses XLSX sheets into auditable tab-separated content', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('营收');
    sheet.addRow(['季度', '金额']);
    sheet.addRow(['Q1', 42]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const parsed = await parseDocument({
      bytes,
      mediaType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileName: 'revenue.xlsx',
    });
    expect(parsed.kind).toBe('xlsx');
    expect(parsed.text).toContain('工作表：营收');
    expect(parsed.text).toContain('Q1\t42');
  });

  it('parses PPTX slide text in slide order', async () => {
    const archive = new JSZip();
    archive.file(
      'ppt/slides/slide2.xml',
      '<p:sld><a:t>第二页</a:t><a:t>结论</a:t></p:sld>',
    );
    archive.file(
      'ppt/slides/slide1.xml',
      '<p:sld><a:t>第一页</a:t><a:t>目标</a:t></p:sld>',
    );
    const parsed = await parseDocument({
      bytes: await archive.generateAsync({ type: 'nodebuffer' }),
      mediaType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      fileName: 'plan.pptx',
    });
    expect(parsed.kind).toBe('pptx');
    expect(parsed.units.map((unit) => unit.text)).toEqual([
      '第一页\n目标',
      '第二页\n结论',
    ]);
  });

  it('delegates selected PDF pages to the shared reader without reading adjacent pages', async () => {
    const parsed = await parseDocument({
      bytes: readPdfFixture('01-chinese-multipage-digital.pdf'),
      mediaType: 'application/pdf',
      fileName: '中文 摘录.pdf',
      pages: [2],
      includeStructure: true,
    });
    expect(parsed).toMatchObject({
      kind: 'pdf',
      totalPages: 3,
      requestedPages: [2],
      nextPages: [3],
      quality: 'digital_text',
      parser: { name: 'pdf-parse', version: '2.4.5' },
    });
    expect(parsed.units).toEqual([
      expect.objectContaining({ pageNumber: 2, label: '第 2 页' }),
    ]);
    expect(parsed.text).toContain('星河实验室');
    expect(parsed.text).toContain('00456');
    expect(parsed.text).toContain('-200.00');
    expect(JSON.stringify(parsed)).not.toContain('青松办公室');
    expect(JSON.stringify(parsed)).not.toContain('远山资料室');
  });

  it('preserves the independently authored PDF table matrix through the Worker adapter', async () => {
    const expected = JSON.parse(
      readFileSync(new URL('expected-source.json', pdfFixtures), 'utf8'),
    ) as {
      fixtures: {
        fixtureId: string;
        tables?: { matrix: string[][] }[];
      }[];
    };
    const source = expected.fixtures.find(
      (source) => source.fixtureId === '02-ruled-invoice-table',
    )!;
    const parsed = await parseDocument({
      bytes: readPdfFixture('02-ruled-invoice-table.pdf'),
      mediaType: 'application/pdf',
      fileName: 'invoice.pdf',
      includeStructure: true,
    });
    expect(parsed).toMatchObject({
      tables: [
        {
          pageNumber: 1,
          tableNumber: 1,
          rows: source.tables![0]!.matrix.map((cells, index) => ({
            rowNumber: index + 1,
            cells,
          })),
        },
      ],
      warningCodes: expect.arrayContaining(['PDF_TABLE_HEURISTIC']),
    });
  });

  it('retains the scan quality warning instead of reporting blank extraction as success', async () => {
    const parsed = await parseDocument({
      bytes: readPdfFixture('04-scanned-image-only.pdf'),
      mediaType: 'application/pdf',
      fileName: 'scan.pdf',
      includeStructure: true,
    });
    expect(parsed).toMatchObject({
      totalPages: 2,
      quality: 'no_extractable_text',
      tables: [],
      warningCodes: expect.arrayContaining(['PDF_NO_EXTRACTABLE_TEXT']),
    });
    expect(parsed.units.every((unit) => unit.text.trim() === '')).toBe(true);
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it('preserves actionable shared PDF errors at the Worker boundary', async () => {
    await expect(
      parseDocument({
        bytes: readPdfFixture('05-password-protected.pdf'),
        mediaType: 'application/pdf',
        fileName: 'protected.pdf',
      }),
    ).rejects.toMatchObject({
      code: 'PDF_PASSWORD_REQUIRED',
      retryable: false,
    });
    await expect(
      parseDocument({
        bytes: readPdfFixture('01-chinese-multipage-digital.pdf'),
        mediaType: 'application/pdf',
        fileName: 'pages.pdf',
        pages: [4],
      }),
    ).rejects.toMatchObject({
      code: 'PDF_PAGE_OUT_OF_RANGE',
      retryable: false,
    });
    await expect(
      parseDocument({
        bytes: Buffer.from('%PDF-1.4\ninvalid'),
        mediaType: 'application/pdf',
        fileName: 'broken.pdf',
      }),
    ).rejects.toMatchObject({
      code: 'PDF_PARSE_FAILED',
      retryable: false,
    });
  });

  it('keeps DOCX reading on the existing text adapter', async () => {
    const parsed = await parseDocument({
      bytes: await Packer.toBuffer(
        new Document({
          sections: [
            { children: [new Paragraph('原生正文：00123，缺失不是零。')] },
          ],
        }),
      ),
      mediaType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName: 'report.docx',
    });
    expect(parsed.kind).toBe('docx');
    expect(parsed.text).toContain('原生正文：00123，缺失不是零。');
    expect(parsed.units).toEqual([expect.objectContaining({ label: '正文' })]);
    expect(parsed).not.toHaveProperty('parser');
  });

  it('retains CSV strings and the existing non-PDF character limit', async () => {
    const csv = '编号,金额\n00123,-200.00\n00789,—\n';
    const parsed = await parseDocument({
      bytes: Buffer.from(csv),
      mediaType: 'text/csv',
      fileName: 'ledger.csv',
    });
    expect(parsed.kind).toBe('text');
    expect(parsed.text).toContain(csv.trim());
    const bounded = await parseDocument({
      bytes: Buffer.from(csv.repeat(100)),
      mediaType: 'text/csv',
      fileName: 'long-ledger.csv',
      maximumCharacters: 1_000,
    });
    expect(bounded.truncated).toBe(true);
    expect(bounded.text).toHaveLength(1_000);
    expect(bounded.warnings.length).toBeGreaterThan(0);
  });
});
