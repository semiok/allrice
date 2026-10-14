import { describe, it, expect } from 'vitest';
import {
  employeeMethodFileCase,
  evaluateEmployeeMethodFileOutput,
  EmployeeMethodFileStepSchema,
} from './employee-method-file-case.ts';

const json = (a = 10000, b = 20000) =>
  JSON.stringify({
    currency: 'CNY',
    amountUnit: 'cent',
    rows: [
      { entryId: 'one', amountCents: a },
      { entryId: 'two', amountCents: b },
    ],
  });
describe('fixed file evidence', () => {
  it('requires both exact source rows, not merely the same grand total', () => {
    expect(evaluateEmployeeMethodFileOutput('normalize', json())).toMatchObject(
      { passed: true, actual: 30000 },
    );
    expect(
      evaluateEmployeeMethodFileOutput('normalize', json(15000, 15000)),
    ).toMatchObject({ passed: false, actual: 30000 });
    expect(
      evaluateEmployeeMethodFileOutput('normalize', json(10000, 22000)),
    ).toMatchObject({
      passed: false,
      actual: 32000,
      reason: 'amount_mismatch',
    });
  });
  it.each([
    'done; total=30000',
    '{"totalCents":30000}',
    json().replace('cent', 'yuan'),
    json().replace('one', 'other'),
    ' '.repeat(32769),
  ])('rejects nonconforming JSON bytes', (body) => {
    expect(evaluateEmployeeMethodFileOutput('normalize', body).passed).toBe(
      false,
    );
  });
  it('reads an actual two-line CSV including CRLF and rejects inflated totals', () => {
    expect(
      evaluateEmployeeMethodFileOutput(
        'summarize',
        'currency,amountUnit,totalCents\r\nCNY,cent,30000\r\n',
      ),
    ).toMatchObject({ passed: true, actual: 30000 });
    expect(
      evaluateEmployeeMethodFileOutput(
        'summarize',
        'currency,amountUnit,totalCents\nCNY,cent,32000\n',
      ),
    ).toMatchObject({ passed: false, actual: 32000 });
  });
  it.each([
    'currency,amountUnit,totalCents\nCNY,yuan,30000',
    'currency,amountUnit,totalCents\nCNY,cent,30000\nCNY,cent,1',
    'currency,amountUnit,totalCents\nCNY,cent,3e4',
    'currency,amountUnit,totalCents\nCNY,cent,9007199254740993',
    '```csv\ncurrency,amountUnit,totalCents\nCNY,cent,30000\n```',
  ])('rejects wrong units/extra rows/non-integer bytes', (body) => {
    expect(evaluateEmployeeMethodFileOutput('summarize', body).passed).toBe(
      false,
    );
  });
  it('has no model-controlled files, expected values, runtime or limits', () => {
    const args = { stage: 'normalize', script: 'console.log(1)' };
    for (const field of [
      'testId',
      'inputs',
      'outputs',
      'expected',
      'limits',
      'network',
      'imageDigest',
      'grantId',
    ])
      expect(
        EmployeeMethodFileStepSchema.safeParse({
          ...args,
          [field]: 'untrusted',
        }).success,
      ).toBe(false);
    expect(employeeMethodFileCase.runtime.network).toBe('none');
    expect(employeeMethodFileCase.input.text).toBe(
      'entryId,amountCents\none,10000\ntwo,20000\n',
    );
  });
});
