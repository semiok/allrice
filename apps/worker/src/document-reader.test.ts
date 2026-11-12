import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Document, Packer, Paragraph } from 'docx';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import type * as PptxGenJSModule from 'pptxgenjs';
import { describe, expect, it } from 'vitest';

import { parseDocument } from './document-reader.js';
import { OfficePackage } from './office/package.js';

const PptxGenJS: typeof PptxGenJSModule.default = createRequire(
  import.meta.url,
)('pptxgenjs');
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
    const presentation = new PptxGenJS();
    presentation.addSlide().addText('第一页\n目标');
    presentation.addSlide().addText('第二页\n结论');
    const parsed = await parseDocument({
      bytes: Buffer.from(
        (await presentation.write({ outputType: 'nodebuffer' })) as Buffer,
      ),
      mediaType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      fileName: 'plan.pptx',
    });
    expect(parsed.kind).toBe('pptx');
    expect(parsed.units.map((unit) => unit.text)).toEqual([
      '第一页\n目标',
      '第二页\n结论',
    ]);
    expect(parsed.units.map((unit) => unit.pageNumber)).toEqual([1, 2]);
  });

  it('uses presentation relationship order and namespace-aware XML text', async () => {
    const presentation = new PptxGenJS();
    presentation.addSlide().addText('文件一');
    presentation.addSlide().addText('文件二');
    const archive = await JSZip.loadAsync(
      (await presentation.write({ outputType: 'nodebuffer' })) as Buffer,
    );
    const path = 'ppt/presentation.xml';
    const xml = await archive.file(path)!.async('string');
    const slides = [...xml.matchAll(/<p:sldId\b[^>]*\/>/g)].map(
      (match) => match[0],
    );
    expect(slides).toHaveLength(2);
    archive.file(
      path,
      xml
        .replace(slides[0]!, '__SECOND__')
        .replace(slides[1]!, slides[0]!)
        .replace('__SECOND__', slides[1]!),
    );
    const slide = 'ppt/slides/slide2.xml';
    archive.file(
      slide,
      (await archive.file(slide)!.async('string'))
        .replaceAll('xmlns:a=', 'xmlns:equivalent=')
        .replaceAll('<a:', '<equivalent:')
        .replaceAll('</a:', '</equivalent:')
        .replaceAll('<equivalent:t>', '<equivalent:t xml:space="preserve">'),
    );
    const parsed = await parseDocument({
      bytes: await archive.generateAsync({ type: 'nodebuffer' }),
      mediaType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      fileName: 'reordered.pptx',
    });
    expect(parsed.units.map((unit) => unit.text)).toEqual(['文件二', '文件一']);
    expect(parsed.units.map((unit) => unit.pageNumber)).toEqual([1, 2]);
  });

  it('rejects a malformed PPTX instead of extracting one surviving slide as the whole presentation', async () => {
    const archive = new JSZip();
    archive.file('ppt/slides/slide1.xml', '<p:sld><a:t>局部正文</a:t></p:sld>');
    await expect(
      parseDocument({
        bytes: await archive.generateAsync({ type: 'nodebuffer' }),
        mediaType:
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        fileName: 'broken.pptx',
      }),
    ).rejects.toMatchObject({ code: 'OFFICE_DOCUMENT_INVALID' });
  });

  it('reads a signed-package PPTX without weakening the default edit guard', async () => {
    const presentation = new PptxGenJS();
    presentation.addSlide().addText('签名包仍可读取');
    const archive = await JSZip.loadAsync(
      (await presentation.write({ outputType: 'nodebuffer' })) as Buffer,
    );
    // Parsing never verifies or edits a digital signature. This fixture marks
    // the signed-package shape recognized by the existing edit guard.
    archive.file(
      '_xmlsignatures/sig1.xml',
      '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/>',
    );
    const bytes = await archive.generateAsync({ type: 'nodebuffer' });
    const parsed = await parseDocument({
      bytes,
      mediaType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      fileName: 'signed.pptx',
    });
    expect(parsed.text).toContain('签名包仍可读取');
    const readOnly = await OfficePackage.open(bytes, 'pptx', {
      readOnly: true,
    });
    await expect(readOnly.finish()).rejects.toMatchObject({
      code: 'OFFICE_DOCUMENT_INVALID',
    });
    await expect(OfficePackage.open(bytes, 'pptx')).rejects.toMatchObject({
      code: 'OFFICE_DOCUMENT_INVALID',
    });
    archive.file('ppt/vbaProject.bin', 'macro');
    await expect(
      OfficePackage.open(
        await archive.generateAsync({ type: 'nodebuffer' }),
        'pptx',
        { readOnly: true },
      ),
    ).rejects.toMatchObject({ code: 'OFFICE_DOCUMENT_INVALID' });
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
