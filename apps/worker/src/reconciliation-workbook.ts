import ExcelJS from 'exceljs';
import { z } from 'zod';

const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const signed = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const rowSchema = z
  .object({
    invoice_id: z.string().min(1).max(240),
    invoice_cents: cents.nullable(),
    paid_cents: cents,
    difference_cents: signed.nullable(),
    status: z.enum(['matched', 'underpaid', 'overpaid', 'ambiguous']),
  })
  .strict();
const issueSchema = z.discriminatedUnion('code', [
  z
    .object({
      code: z.literal('duplicate_invoice_id'),
      id: z.string().min(1).max(240),
      rows: z.array(z.number().int().min(2)).min(2).max(20000),
    })
    .strict(),
  z
    .object({
      code: z.literal('duplicate_payment_id'),
      id: z.string().min(1).max(240),
      rows: z.array(z.number().int().min(2)).min(2).max(20000),
    })
    .strict(),
  z
    .object({
      code: z.literal('unallocated_payment'),
      id: z.string().min(1).max(240),
      invoice_id: z.string().min(1).max(240),
      row: z.number().int().min(2),
      amount_cents: cents,
    })
    .strict(),
]);
export const ReconciliationReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    currency: z.literal('CNY'),
    rows: z.array(rowSchema).max(20000),
    issues: z.array(issueSchema).max(40000),
    totals: z
      .object({
        invoice_rows: z.number().int().min(0).max(20000),
        payment_rows: z.number().int().min(0).max(20000),
        invoice_cents: cents,
        valid_payment_cents: cents,
        allocated_payment_cents: cents,
        unallocated_payment_cents: cents,
        difference_cents: signed,
      })
      .strict(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const sum = (v: number[]) => v.reduce((a, b) => a + BigInt(b), 0n);
    const invalid =
      new Set(r.rows.map((row) => row.invoice_id)).size !== r.rows.length ||
      r.rows.length > r.totals.invoice_rows ||
      sum(r.rows.map((row) => row.invoice_cents ?? 0)) !==
        BigInt(r.totals.invoice_cents) ||
      sum(r.rows.map((row) => row.paid_cents)) !==
        BigInt(r.totals.allocated_payment_cents) ||
      BigInt(r.totals.allocated_payment_cents) +
        BigInt(r.totals.unallocated_payment_cents) !==
        BigInt(r.totals.valid_payment_cents) ||
      BigInt(r.totals.invoice_cents) -
        BigInt(r.totals.allocated_payment_cents) !==
        BigInt(r.totals.difference_cents) ||
      r.rows.some(
        (row) =>
          row.difference_cents !==
            (row.invoice_cents === null
              ? null
              : row.invoice_cents - row.paid_cents) ||
          (row.status !== 'ambiguous' &&
            (row.difference_cents === null ||
              row.status !==
                (row.difference_cents === 0
                  ? 'matched'
                  : row.difference_cents > 0
                    ? 'underpaid'
                    : 'overpaid'))),
      );
    if (invalid)
      ctx.addIssue({
        code: 'custom',
        message: 'reconciliation_reference_mismatch',
      });
  });

/** Writes primitive values only: JSON cannot introduce ExcelJS formula,
 * hyperlink, rich-text or external-workbook objects. No model recomputation. */
export async function reconciliationWorkbook(
  reportInput: unknown,
  source: { objectId: string; checksum: string },
) {
  const report = ReconciliationReportSchema.parse(reportInput);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AllRice deterministic reconciliation';
  workbook.created = new Date('2026-09-08T00:00:00.000Z');
  workbook.modified = workbook.created;
  const summary = workbook.addWorksheet('核对摘要');
  summary.addRows([
    ['口径', 'CNY · 整数分 · 重复ID不自动去重'],
    ['source_object_id', source.objectId],
    ['source_checksum', source.checksum],
    ...Object.entries(report.totals),
  ]);
  const detail = workbook.addWorksheet('发票明细');
  const columns = [
    'invoice_id',
    'invoice_cents',
    'paid_cents',
    'difference_cents',
    'status',
  ] as const;
  detail.addRow([...columns]);
  for (const row of report.rows) detail.addRow(columns.map((key) => row[key]));
  const issues = workbook.addWorksheet('待人工核查');
  issues.addRow(['code', 'id', 'invoice_id', 'source_rows', 'amount_cents']);
  for (const issue of report.issues)
    issues.addRow([
      issue.code,
      issue.id,
      issue.code === 'unallocated_payment' ? issue.invoice_id : '',
      issue.code === 'unallocated_payment' ? issue.row : issue.rows.join(','),
      issue.code === 'unallocated_payment' ? issue.amount_cents : null,
    ]);
  for (const sheet of workbook.worksheets) {
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.columns.forEach((column) => {
      column.width = 24;
    });
  }
  return { report, bytes: Buffer.from(await workbook.xlsx.writeBuffer()) };
}
