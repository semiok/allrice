import { readFileSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import process from 'node:process';

// Apache-2.0. Inert reviewed Skill resource; only the approved Cloud Runner
// executes a copied script. No network, eval, package install or host paths.
function csv(source, columns) {
  if (Buffer.byteLength(source) > 1_000_000) throw Error('input_too_large');
  source = source.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [],
    field = '',
    quoted = false,
    closed = false;
  const cell = () => {
    row.push(field);
    field = '';
    closed = false;
  };
  const line = () => {
    cell();
    if (row.some((value) => value !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else field += char;
    } else if (char === '"') {
      if (field || closed) throw Error('invalid_csv_quote');
      quoted = true;
    } else if (char === ',') cell();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      line();
    } else {
      if (closed) throw Error('invalid_csv_quote');
      field += char;
    }
  }
  if (quoted) throw Error('unclosed_csv_quote');
  if (field || row.length || closed) line();
  if (JSON.stringify(rows.shift()) !== JSON.stringify(columns))
    throw Error('columns_require_confirmation');
  if (rows.length > 20_000) throw Error('too_many_rows');
  return rows.map((values, index) => {
    if (values.length !== columns.length) throw Error('invalid_column_count');
    return {
      ...Object.fromEntries(columns.map((name, i) => [name, values[i].trim()])),
      row: index + 2,
    };
  });
}
function cents(value) {
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(value))
    throw Error('amount_requires_confirmation');
  const [major, minor = ''] = value.split('.');
  const result = Number(major) * 100 + Number(minor.padEnd(2, '0'));
  if (!Number.isSafeInteger(result)) throw Error('amount_out_of_range');
  return result;
}
function add(left, right) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw Error('total_out_of_range');
  return sum;
}
function groups(rows, key) {
  const result = new Map();
  for (const row of rows) {
    if (!row[key] || !row.invoice_id || row.currency !== 'CNY')
      throw Error('identity_or_currency_requires_confirmation');
    row.cents = cents(row.amount);
    const list = result.get(row[key]) ?? [];
    list.push(row);
    result.set(row[key], list);
  }
  return result;
}
const invoices = csv(readFileSync('input/invoices.csv', 'utf8'), [
  'invoice_id',
  'amount',
  'currency',
]);
const payments = csv(readFileSync('input/payments.csv', 'utf8'), [
  'payment_id',
  'invoice_id',
  'amount',
  'currency',
]);
const invoiceGroups = groups(invoices, 'invoice_id'),
  paymentGroups = groups(payments, 'payment_id');
const issues = [],
  rows = [],
  paid = new Map(),
  ambiguous = new Set();
const totals = {
  invoice_rows: invoices.length,
  payment_rows: payments.length,
  invoice_cents: 0,
  valid_payment_cents: 0,
  allocated_payment_cents: 0,
  unallocated_payment_cents: 0,
  difference_cents: 0,
};
for (const [id, records] of invoiceGroups)
  if (records.length > 1) {
    ambiguous.add(id);
    issues.push({
      code: 'duplicate_invoice_id',
      id,
      rows: records.map((r) => r.row),
    });
  }
for (const [id, records] of paymentGroups) {
  if (records.length > 1) {
    for (const r of records) ambiguous.add(r.invoice_id);
    issues.push({
      code: 'duplicate_payment_id',
      id,
      rows: records.map((r) => r.row),
    });
    continue;
  }
  const record = records[0];
  totals.valid_payment_cents = add(totals.valid_payment_cents, record.cents);
  if (
    !invoiceGroups.has(record.invoice_id) ||
    invoiceGroups.get(record.invoice_id).length > 1
  ) {
    totals.unallocated_payment_cents = add(
      totals.unallocated_payment_cents,
      record.cents,
    );
    issues.push({
      code: 'unallocated_payment',
      id,
      invoice_id: record.invoice_id,
      row: record.row,
      amount_cents: record.cents,
    });
  } else {
    paid.set(
      record.invoice_id,
      add(paid.get(record.invoice_id) ?? 0, record.cents),
    );
    totals.allocated_payment_cents = add(
      totals.allocated_payment_cents,
      record.cents,
    );
  }
}
for (const [id, records] of invoiceGroups) {
  const invoice = records.length === 1 ? records[0].cents : null;
  if (invoice !== null)
    totals.invoice_cents = add(totals.invoice_cents, invoice);
  const received = paid.get(id) ?? 0,
    difference = invoice === null ? null : invoice - received;
  rows.push({
    invoice_id: id,
    invoice_cents: invoice,
    paid_cents: received,
    difference_cents: difference,
    status: ambiguous.has(id)
      ? 'ambiguous'
      : difference === 0
        ? 'matched'
        : difference > 0
          ? 'underpaid'
          : 'overpaid',
  });
}
totals.difference_cents = totals.invoice_cents - totals.allocated_payment_cents;
const result = { schemaVersion: 1, currency: 'CNY', rows, issues, totals };
writeFileSync('output/reconciliation.json', JSON.stringify(result, null, 2));
const headers = [
  'invoice_id',
  'invoice_cents',
  'paid_cents',
  'difference_cents',
  'status',
];
const quote = (value) => {
  let text = value === null ? '' : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
writeFileSync(
  'output/reconciliation.csv',
  [
    headers.join(','),
    ...rows.map((row) => headers.map((key) => quote(row[key])).join(',')),
  ].join('\r\n') + '\r\n',
);
process.stdout.write(
  JSON.stringify({ outcome: 'completed', totals, issue_count: issues.length }),
);
