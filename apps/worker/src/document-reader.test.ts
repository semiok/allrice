import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { parseDocument } from './document-reader.js';

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
});
