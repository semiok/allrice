import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  employeeMethodAmountCase,
  EmployeeMethodTestStartSchema,
} from './employee-method-tests.ts';

describe('fixed candidate method validation', () => {
  it('compares actual integer cents with the server answer independently of execution success', () => {
    expect(
      employeeMethodAmountCase.evaluate('{"totalCents":30000}'),
    ).toMatchObject({ passed: true, expected: 30000, actual: 30000 });
    expect(
      employeeMethodAmountCase.evaluate('{"totalCents":30100}'),
    ).toMatchObject({
      passed: false,
      reason: 'amount_mismatch',
      actual: 30100,
    });
    expect(
      employeeMethodAmountCase.evaluate('{"totalCents":30000}', true),
    ).toMatchObject({ passed: false, reason: 'execution_failed' });
    for (const output of [
      'passed',
      '{"totalCents":"30000"}',
      '{"totalCents":30000,"passed":true}',
      '```json\n{"totalCents":30000}\n```',
      '{"totalCents":30000.01}',
    ])
      expect(employeeMethodAmountCase.evaluate(output)).toMatchObject({
        passed: false,
        reason: 'invalid_output',
      });
  });
  it('rejects caller answers, model selection, ownership and unavailable cases', () => {
    const args = {
      expectedRevision: 1,
      candidateRevisionId: randomUUID(),
      candidateDigest: `sha256:${'a'.repeat(64)}`,
      sceneId: randomUUID(),
      caseId: 'cny-total-v1',
    };
    expect(EmployeeMethodTestStartSchema.parse(args)).toEqual(args);
    const retry = { ...args, retryOfTestId: randomUUID() };
    expect(EmployeeMethodTestStartSchema.parse(retry)).toEqual(retry);
    for (const executionView of [
      { scope: 'company' },
      { scope: 'department', departmentId: randomUUID() },
    ])
      expect(
        EmployeeMethodTestStartSchema.parse({ ...args, executionView }),
      ).toEqual({ ...args, executionView });
    for (const extra of [
      { executionView: { scope: 'personal', ownerId: randomUUID() } },
      { executionView: { scope: 'department' } },
      { executionView: { scope: 'company', departmentId: randomUUID() } },
      { expected: 30100 },
      { model: 'arbitrary' },
      { ownerId: randomUUID() },
      { caseId: 'custom' },
      { retryOfTestId: 'latest' },
      { currency: 'USD' },
      { amountUnit: 'yuan' },
    ])
      expect(
        EmployeeMethodTestStartSchema.safeParse({ ...args, ...extra }).success,
      ).toBe(false);
  });
});
