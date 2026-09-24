import type * as OfficeRuntime from '@allrice/office-runtime';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import { applyFormulaResults, checkOfficeExport } from './quality.js';

vi.mock('@allrice/office-runtime', async (original) => ({
  ...(await original<typeof OfficeRuntime>()),
  renderOffice: vi.fn().mockRejectedValue(Error('unavailable')),
}));
async function workbook() {
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet('明细');
  sheet.getCell('A1').value = '00123';
  sheet.getCell('B1').value = 30;
  sheet.getCell('C1').value = { formula: 'B1*2', result: 0 };
  sheet.getCell('C1').font = { bold: true, color: { argb: 'FF2266FF' } };
  return Buffer.from(await book.xlsx.writeBuffer());
}
describe('Office quality and template preservation', () => {
  it('updates only verified formula caches and keeps other template members', async () => {
    const source = await workbook();
    const patched = await applyFormulaResults(source, [
      { sheet: '明细', cell: 'C1', formula: 'B1*2', type: 'n', value: 60 },
    ]);
    const original = await JSZip.loadAsync(source),
      edited = await JSZip.loadAsync(patched);
    for (const file of Object.keys(original.files).filter(
      (n) => n !== 'xl/worksheets/sheet1.xml' && !original.files[n]!.dir,
    ))
      expect(await edited.file(file)!.async('nodebuffer')).toEqual(
        await original.file(file)!.async('nodebuffer'),
      );
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(
      patched as unknown as Parameters<typeof book.xlsx.load>[0],
    );
    expect(book.worksheets[0]!.getCell('C1').value).toEqual({
      formula: 'B1*2',
      result: 60,
    });
    expect(book.worksheets[0]!.getCell('C1').font.bold).toBe(true);
    expect(book.worksheets[0]!.getCell('A1').value).toBe('00123');
    for (const results of [
      [],
      [
        {
          sheet: '明细',
          cell: 'C1',
          formula: 'B1*3',
          type: 'n' as const,
          value: 90,
        },
      ],
    ])
      await expect(applyFormulaResults(source, results)).rejects.toThrow(
        '源文件不一致',
      );
  });
  it('preserves the downloadable file and reports unavailable checks honestly', async () => {
    const bytes = await workbook();
    const checked = await checkOfficeExport(bytes, 'xlsx');
    expect(checked.bytes).toEqual(bytes);
    expect(checked.quality.status).toBe('unavailable');
    expect(checked.warnings.join('')).toContain('不能据此认定');
  });
});
