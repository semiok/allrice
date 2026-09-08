import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const skill = resolve(
  import.meta.dirname,
  '../../../skills/business-reconciliation',
);
const temporary: string[] = [];
async function run(invoices?: string, payments?: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'allrice-p19-unit-'));
  temporary.push(cwd);
  await mkdir(join(cwd, 'input'));
  await mkdir(join(cwd, 'output'));
  await writeFile(
    join(cwd, 'input/invoices.csv'),
    invoices ?? (await readFile(join(skill, 'assets/invoices.csv'))),
  );
  await writeFile(
    join(cwd, 'input/payments.csv'),
    payments ?? (await readFile(join(skill, 'assets/payments.csv'))),
  );
  await execute(process.execPath, [join(skill, 'scripts/reconcile.mjs')], {
    cwd,
    timeout: 5000,
    maxBuffer: 65536,
  });
  return {
    result: JSON.parse(
      await readFile(join(cwd, 'output/reconciliation.json'), 'utf8'),
    ),
    csv: await readFile(join(cwd, 'output/reconciliation.csv'), 'utf8'),
  };
}
afterEach(async () => {
  for (const path of temporary.splice(0)) {
    if (!path.startsWith(join(tmpdir(), 'allrice-p19-unit-')))
      throw Error('unsafe test cleanup');
    await rm(path, { recursive: true, force: true });
  }
});

describe('P19 deterministic business resource — subprocess tests, not sandbox evidence', () => {
  it('matches an independent cents reference including duplicate, missing and unallocated records', async () => {
    const { result } = await run();
    expect(result.totals).toEqual({
      invoice_rows: 6,
      payment_rows: 6,
      invoice_cents: 36049,
      valid_payment_cents: 34550,
      allocated_payment_cents: 34050,
      unallocated_payment_cents: 500,
      difference_cents: 1999,
    });
    expect(result.rows).toEqual([
      {
        invoice_id: 'A',
        invoice_cents: 10050,
        paid_cents: 10050,
        difference_cents: 0,
        status: 'matched',
      },
      {
        invoice_id: 'B',
        invoice_cents: 20000,
        paid_cents: 18000,
        difference_cents: 2000,
        status: 'ambiguous',
      },
      {
        invoice_id: 'C',
        invoice_cents: 5000,
        paid_cents: 6000,
        difference_cents: -1000,
        status: 'overpaid',
      },
      {
        invoice_id: 'DUP',
        invoice_cents: null,
        paid_cents: 0,
        difference_cents: null,
        status: 'ambiguous',
      },
      {
        invoice_id: 'MISS',
        invoice_cents: 999,
        paid_cents: 0,
        difference_cents: 999,
        status: 'underpaid',
      },
    ]);
    expect(result.issues.map((issue: { code: string }) => issue.code)).toEqual([
      'duplicate_invoice_id',
      'unallocated_payment',
      'duplicate_payment_id',
    ]);
  });
  it('uses integer cents rather than floating decimal totals', async () => {
    const { result } = await run(
      'invoice_id,amount,currency\nA,0.3,CNY\n',
      'payment_id,invoice_id,amount,currency\nP1,A,0.10,CNY\nP2,A,0.20,CNY\n',
    );
    expect(result.totals.difference_cents).toBe(0);
    expect(result.rows[0].status).toBe('matched');
  });
  it('accepts BOM/CRLF/quoted comma IDs and protects spreadsheet formula text', async () => {
    const { result, csv } = await run(
      '\uFEFFinvoice_id,amount,currency\r\n"=A,B",1.00,CNY\r\n',
      'payment_id,invoice_id,amount,currency\nP1,"=A,B",1,CNY\n',
    );
    expect(result.rows[0].invoice_id).toBe('=A,B');
    expect(csv).toContain('"\'=A,B"');
  });
  it.each(['-1.00', '1e3', 'NaN', '1.001', '1000000000000'])(
    'rejects ambiguous amount %s without coercion',
    async (amount) => {
      await expect(
        run(
          `invoice_id,amount,currency\nA,${amount},CNY\n`,
          'payment_id,invoice_id,amount,currency\n',
        ),
      ).rejects.toThrow();
    },
  );
  it('fails closed on mixed currencies, extra columns and malformed quotes', async () => {
    await expect(
      run('invoice_id,amount,currency\nA,1,USD\n'),
    ).rejects.toThrow();
    await expect(
      run('invoice_id,amount,currency\nA,1,CNY,extra\n'),
    ).rejects.toThrow();
    await expect(
      run('invoice_id,amount,currency\n"A,1,CNY\n'),
    ).rejects.toThrow();
  });
  it('does not match IDs by case folding or invent missing invoice payments', async () => {
    const { result } = await run(
      'invoice_id,amount,currency\nA,1.00,CNY\n',
      'payment_id,invoice_id,amount,currency\nP1,a,1,CNY\n',
    );
    expect(result.rows[0].status).toBe('underpaid');
    expect(result.totals.unallocated_payment_cents).toBe(100);
  });
});
