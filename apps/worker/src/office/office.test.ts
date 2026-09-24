import { createHash, randomUUID } from 'node:crypto';
import { Document, ImageRun, Packer, Paragraph, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  OfficeCreateSchema,
  OfficeEditSchema,
  type OfficeEdit,
} from '@allrice/contracts';
import { createOffice } from './create.js';
import { editOffice } from './edit.js';
import { inspectOffice } from './inspect.js';
import { OfficePackage, children, elements, mainParts, ns } from './package.js';

const hash = (bytes: Buffer) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const edit = (bytes: Buffer, changes: OfficeEdit['changes']): OfficeEdit => ({
  kind: 'edit',
  sourceObjectId: randomUUID(),
  sourceChecksum: hash(bytes),
  changes,
});
async function unchangedMembers(
  before: Buffer,
  after: Buffer,
  changed: string[],
) {
  const a = await JSZip.loadAsync(before),
    b = await JSZip.loadAsync(after);
  for (const [path, entry] of Object.entries(a.files)) {
    if (entry.dir || changed.includes(path)) continue;
    expect(b.file(path), path).not.toBeNull();
    expect(await b.file(path)!.async('nodebuffer'), path).toEqual(
      await entry.async('nodebuffer'),
    );
  }
}

describe('native Office creation and original-package editing', () => {
  it('creates native Word tables, headers and a page-number footer', async () => {
    const out = await createOffice(
      OfficeCreateSchema.parse({
        kind: 'docx',
        title: '财务说明',
        header: '内部文档',
        footer: '复核版',
        blocks: [
          { type: 'heading', text: '数据' },
          { type: 'table', headers: ['月份', '金额'], rows: [['九月', 1200]] },
          { type: 'page-break' },
          { type: 'bullets', items: ['需人工复核'] },
        ],
      }),
    );
    const pkg = await OfficePackage.open(out.bytes, 'docx'),
      doc = await pkg.xml(mainParts.docx);
    expect(elements(doc, ns.w, 'tbl')).toHaveLength(1);
    expect(elements(doc, ns.w, 'tr')).toHaveLength(2);
    expect((await inspectOffice(out.bytes, 'docx', 5000)).text).toContain(
      '九月',
    );
    expect(
      Object.keys(pkg.zip.files).some((p) => /word\/header\d+.xml/.test(p)),
    ).toBe(true);
    const footer = await pkg.zip
      .file(/word\/footer\d+.xml/)[0]!
      .async('string');
    expect(footer).toContain('PAGE');
  });

  it('edits a split Word run without rebuilding images, styles or unaffected text', async () => {
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB8kAAAAASUVORK5CYII=',
      'base64',
    );
    const bytes = await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: '前缀 {{客', bold: true }),
                  new TextRun({ text: '户}} 后缀', italics: true }),
                  new ImageRun({
                    type: 'png',
                    data: image,
                    transformation: { width: 20, height: 20 },
                  }),
                ],
              }),
            ],
          },
        ],
      }),
    );
    const original = hash(bytes);
    const result = await editOffice(
      bytes,
      'docx',
      edit(bytes, [
        {
          type: 'replace-text',
          find: '{{客户}}',
          replace: '稻米公司',
          expectedOccurrences: 1,
        },
      ]),
    );
    expect(hash(bytes)).toBe(original);
    await unchangedMembers(bytes, result.bytes, result.changedParts);
    const pkg = await OfficePackage.open(result.bytes, 'docx'),
      doc = await pkg.xml(mainParts.docx);
    expect(elements(doc, ns.w, 't').map((t) => t.textContent)).toEqual([
      '前缀 稻米公司',
      ' 后缀',
    ]);
    expect(elements(doc, ns.w, 'b')).toHaveLength(1);
    expect(elements(doc, ns.w, 'i')).toHaveLength(1);
    expect(elements(doc, ns.w, 'drawing')).toHaveLength(1);
    await expect(
      editOffice(
        bytes,
        'docx',
        edit(bytes, [
          {
            type: 'replace-text',
            find: '{{客户}}',
            replace: 'A',
            expectedOccurrences: 2,
          },
        ]),
      ),
    ).rejects.toThrow('匹配 1 处');
  });

  it('creates typed worksheets and preserves formulas instead of inventing results', async () => {
    const out = await createOffice(
      OfficeCreateSchema.parse({
        kind: 'xlsx',
        sheets: [
          {
            name: '明细',
            columns: [
              { header: '编码' },
              { header: '金额', numberFormat: '#,##0.00' },
              { header: '合计' },
            ],
            rows: [['00123', 12.5, { formula: '=B2*2' }]],
          },
          { name: '说明', columns: [{ header: '已复核' }], rows: [[false]] },
        ],
      }),
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(out.bytes).buffer);
    expect(workbook.worksheets).toHaveLength(2);
    expect(workbook.getWorksheet('明细')!.getCell('A2').value).toBe('00123');
    expect(workbook.getWorksheet('明细')!.getCell('B2').value).toBe(12.5);
    expect(workbook.getWorksheet('明细')!.getCell('B2').numFmt).toBe(
      '#,##0.00',
    );
    expect(workbook.getWorksheet('明细')!.getCell('C2').value).toEqual({
      formula: 'B2*2',
    });
    expect((await inspectOffice(out.bytes, 'xlsx', 5000)).text).toContain(
      '公式：=B2*2；未计算',
    );
  });

  it('edits workbook cells while keeping template styles and formulas and invalidating stale caches', async () => {
    const book = new ExcelJS.Workbook(),
      sheet = book.addWorksheet('报价');
    sheet.getCell('A1').value = '模板';
    sheet.getCell('B2').value = 12;
    sheet.getCell('B2').numFmt = '#,##0.00';
    sheet.getCell('B2').font = { bold: true };
    sheet.getCell('C2').value = { formula: 'B2*2', result: 24 };
    book.addWorksheet('汇总').getCell('A1').value = {
      formula: '报价!C2',
      result: 24,
    };
    const bytes = Buffer.from(await book.xlsx.writeBuffer());
    const result = await editOffice(
      bytes,
      'xlsx',
      edit(bytes, [
        { type: 'set-cell', sheet: '报价', cell: 'B2', value: 20 },
        { type: 'set-cell', sheet: '报价', cell: 'D4', value: '00012' },
      ]),
    );
    await unchangedMembers(bytes, result.bytes, result.changedParts);
    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.load(Uint8Array.from(result.bytes).buffer);
    const revised = reloaded.getWorksheet('报价')!;
    expect(revised.getCell('B2').value).toBe(20);
    expect(revised.getCell('B2').font.bold).toBe(true);
    expect(revised.getCell('B2').numFmt).toBe('#,##0.00');
    expect(revised.getCell('C2').value).toEqual({ formula: 'B2*2' });
    expect(reloaded.getWorksheet('汇总')!.getCell('A1').value).toEqual({
      formula: '报价!C2',
    });
    expect(revised.getCell('D4').value).toBe('00012');
    const pkg = await OfficePackage.open(result.bytes, 'xlsx');
    const calc = elements(await pkg.xml(mainParts.xlsx), ns.s, 'calcPr')[0]!;
    expect(calc.getAttribute('fullCalcOnLoad')).toBe('1');
    expect(calc.getAttribute('calcMode')).toBe('auto');
  });

  it('refuses edits inside array formulas or non-anchor merged cells', async () => {
    const book = new ExcelJS.Workbook(),
      sheet = book.addWorksheet('S');
    sheet.mergeCells('A1:B1');
    const arrayFormula = {
      formula: 'ROW(C1:C2)',
      result: 1,
      shareType: 'array',
      ref: 'C1:C2',
    };
    sheet.getCell('C1').value = arrayFormula;
    sheet.getCell('C2').value = 2;
    const bytes = Buffer.from(await book.xlsx.writeBuffer());
    for (const cell of ['B1', 'C2'])
      await expect(
        editOffice(
          bytes,
          'xlsx',
          edit(bytes, [{ type: 'set-cell', sheet: 'S', cell, value: 4 }]),
        ),
      ).rejects.toThrow(/合并单元格|数组公式/);
  });

  it('invalidates array output caches as well as formula anchors', async () => {
    const book = new ExcelJS.Workbook(),
      sheet = book.addWorksheet('S');
    sheet.getCell('A1').value = 1;
    const arrayFormula = {
      formula: 'A1+ROW(C1:C2)',
      result: 2,
      shareType: 'array',
      ref: 'C1:C2',
    };
    sheet.getCell('C1').value = arrayFormula;
    sheet.getCell('C2').value = 3;
    const bytes = Buffer.from(await book.xlsx.writeBuffer());
    const result = await editOffice(
      bytes,
      'xlsx',
      edit(bytes, [{ type: 'set-cell', sheet: 'S', cell: 'A1', value: 5 }]),
    );
    const pkg = await OfficePackage.open(result.bytes, 'xlsx'),
      doc = await pkg.xml('xl/worksheets/sheet1.xml');
    for (const address of ['C1', 'C2']) {
      const cell = elements(doc, ns.s, 'c').find(
        (c) => c.getAttribute('r') === address,
      )!;
      expect(children(cell, ns.s, 'v')).toHaveLength(0);
    }
    expect(elements(doc, ns.s, 'f')[0]!.textContent).toBe('A1+ROW(C1:C2)');
    expect(result.bytes).toEqual(
      (
        await editOffice(
          bytes,
          'xlsx',
          edit(bytes, [{ type: 'set-cell', sheet: 'S', cell: 'A1', value: 5 }]),
        )
      ).bytes,
    );
  });

  it('creates native editable slides, chart data and notes, then edits in presentation order', async () => {
    const out = await createOffice(
      OfficeCreateSchema.parse({
        kind: 'pptx',
        title: '月报',
        slides: [
          {
            title: '表格页',
            table: { headers: ['区域', '收入'], rows: [['华东', 12]] },
            notes: '数据待复核',
          },
          {
            title: '图表页',
            chart: {
              type: 'bar',
              labels: ['九月', '十月'],
              series: [{ name: '收入', values: [12, 20] }],
            },
            notes: '保留备注',
          },
        ],
      }),
    );
    const pkg = await OfficePackage.open(out.bytes, 'pptx');
    expect(
      elements(await pkg.xml('ppt/slides/slide1.xml'), ns.a, 'tbl'),
    ).toHaveLength(1);
    expect(
      Object.keys(pkg.zip.files).some((p) =>
        /ppt\/charts\/chart\d+.xml/.test(p),
      ),
    ).toBe(true);
    expect(Object.keys(pkg.zip.files).some((p) => p.endsWith('.xlsx'))).toBe(
      true,
    );
    const presentation = await pkg.xml(mainParts.pptx),
      list = elements(presentation, ns.p, 'sldIdLst')[0]!;
    list.insertBefore(list.lastChild!, list.firstChild);
    pkg.changed.add(mainParts.pptx);
    const reordered = await pkg.finish();
    expect(
      (await inspectOffice(reordered, 'pptx', 5000)).units[0]!.text,
    ).toContain('图表页');
    const result = await editOffice(
      reordered,
      'pptx',
      edit(reordered, [
        {
          type: 'replace-text',
          slide: 1,
          find: '图表页',
          replace: '收入趋势',
          expectedOccurrences: 1,
        },
      ]),
    );
    expect(result.changedParts).toEqual(['ppt/slides/slide2.xml']);
    await unchangedMembers(reordered, result.bytes, result.changedParts);
    expect(
      (await inspectOffice(result.bytes, 'pptx', 5000)).units[0]!.text,
    ).toContain('收入趋势');
  });

  it('rejects malformed input before producing a download, and bounds inspection', async () => {
    expect(
      OfficeEditSchema.safeParse({
        ...edit(Buffer.from('x'), []),
        changes: [
          { type: 'set-cell', sheet: 'S', cell: 'A1', value: { formula: '=' } },
        ],
      }).success,
    ).toBe(false);
    const out = await createOffice(
      OfficeCreateSchema.parse({
        kind: 'docx',
        title: 'Title',
        blocks: [{ type: 'paragraph', text: 'x'.repeat(2000) }],
      }),
    );
    const inspected = await inspectOffice(out.bytes, 'docx', 1000);
    expect(inspected.truncated).toBe(true);
    expect(
      inspected.units.reduce((n, u) => n + u.text.length, 0),
    ).toBeLessThanOrEqual(1000);
    await expect(OfficePackage.open(out.bytes, 'xlsx')).rejects.toThrow(
      '格式与包内容不一致',
    );
    const zip = await JSZip.loadAsync(out.bytes);
    zip.file(
      'word/document.xml',
      `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><w:document xmlns:w="${ns.w}"/>`,
    );
    await expect(
      OfficePackage.open(
        await zip.generateAsync({ type: 'nodebuffer' }),
        'docx',
      ),
    ).rejects.toThrow('DTD');
    zip.file('evil/../escaped.xml', '<x/>');
    await expect(
      OfficePackage.open(
        await zip.generateAsync({ type: 'nodebuffer' }),
        'docx',
      ),
    ).rejects.toThrow('路径');
    expect(
      children(
        (await OfficePackage.open(out.bytes, 'docx')).documents.get(
          mainParts.docx,
        )!.documentElement!,
        ns.w,
        'body',
      ),
    ).toHaveLength(1);
  });
});
