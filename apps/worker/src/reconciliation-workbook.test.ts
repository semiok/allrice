import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  reconciliationWorkbook,
  ReconciliationReportSchema,
} from './reconciliation-workbook.js';

const source = {
  objectId: '10000000-0000-4000-8000-000000000001',
  checksum: `sha256:${'a'.repeat(64)}`,
};
const report = {
  schemaVersion: 1,
  currency: 'CNY',
  rows: [
    {
      invoice_id: '=HYPERLINK("https://evil.test")',
      invoice_cents: 30,
      paid_cents: 30,
      difference_cents: 0,
      status: 'matched',
    },
  ],
  issues: [],
  totals: {
    invoice_rows: 1,
    payment_rows: 2,
    invoice_cents: 30,
    valid_payment_cents: 30,
    allocated_payment_cents: 30,
    unallocated_payment_cents: 0,
    difference_cents: 0,
  },
};
describe('P19 source-faithful spreadsheet rendering', () => {
  it('reopens three actual XLSX sheets with exact integer cells and provenance', async () => {
    const { bytes } = await reconciliationWorkbook(report, source);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
    expect(workbook.worksheets.map((s) => s.name)).toEqual([
      '核对摘要',
      '发票明细',
      '待人工核查',
    ]);
    const detail = workbook.getWorksheet('发票明细')!;
    expect(detail.getCell('A2').value).toBe(report.rows[0]!.invoice_id);
    expect(detail.getCell('A2').type).toBe(ExcelJS.ValueType.String);
    expect(detail.getCell('B2').value).toBe(30);
    expect(detail.getCell('D2').value).toBe(0);
    expect(workbook.getWorksheet('核对摘要')!.getCell('B3').value).toBe(
      source.checksum,
    );
  });
  it('rejects changed totals, invalid numeric types, extra formula objects and false statuses', () => {
    expect(() =>
      ReconciliationReportSchema.parse({
        ...report,
        totals: { ...report.totals, invoice_cents: 31 },
      }),
    ).toThrow();
    expect(() =>
      ReconciliationReportSchema.parse({
        ...report,
        rows: [{ ...report.rows[0], paid_cents: '30' }],
      }),
    ).toThrow();
    expect(() =>
      ReconciliationReportSchema.parse({
        ...report,
        rows: [{ ...report.rows[0], invoice_id: { formula: 'WEBSERVICE()' } }],
      }),
    ).toThrow();
    expect(() =>
      ReconciliationReportSchema.parse({
        ...report,
        rows: [{ ...report.rows[0], status: 'underpaid' }],
      }),
    ).toThrow();
  });
  it('rejects duplicated invoice summary rows and unsupported issue payloads', () => {
    expect(() =>
      ReconciliationReportSchema.parse({
        ...report,
        rows: [report.rows[0], report.rows[0]],
      }),
    ).toThrow();
    expect(() =>
      ReconciliationReportSchema.parse({
        ...report,
        issues: [{ code: 'execute', command: 'shell' }],
      }),
    ).toThrow();
  });
});
