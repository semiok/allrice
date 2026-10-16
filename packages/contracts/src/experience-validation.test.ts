import { it, expect } from 'vitest';
import { evaluateExperienceRoster } from './experience-validation.ts';
import { attendanceAnswer } from '../../database/src/experience-validation.fixture.ts';
it('checks members as well as independent counts and does not infer missing source information', () => {
  expect(
    evaluateExperienceRoster(JSON.stringify(attendanceAnswer)),
  ).toMatchObject({ passed: true, reason: 'matched' });
  const swapped = structuredClone(attendanceAnswer);
  swapped.results[0]!.present!.ids[0] = 'A02';
  expect(evaluateExperienceRoster(JSON.stringify(swapped))).toMatchObject({
    passed: false,
    reason: 'count_or_membership_mismatch',
  });
  const incomplete = structuredClone(attendanceAnswer);
  incomplete.results[2] = { ...incomplete.results[0]!, id: 'unknown-status' };
  expect(evaluateExperienceRoster(JSON.stringify(incomplete))).toMatchObject({
    passed: false,
    reason: 'missing_information_inferred',
  });
});
it('rejects self-evaluation, reused totals, duplicates, invalid JSON and failed execution', () => {
  expect(evaluateExperienceRoster('{"passed":true}').passed).toBe(false);
  const oldTotals = structuredClone(attendanceAnswer);
  oldTotals.results[0]!.present!.count = 9;
  expect(evaluateExperienceRoster(JSON.stringify(oldTotals)).passed).toBe(
    false,
  );
  const duplicate = structuredClone(attendanceAnswer);
  duplicate.results[1] = duplicate.results[0]!;
  expect(evaluateExperienceRoster(JSON.stringify(duplicate)).reason).toBe(
    'invalid_output',
  );
  expect(evaluateExperienceRoster('bad').reason).toBe('invalid_output');
  expect(
    evaluateExperienceRoster(JSON.stringify(attendanceAnswer), true).reason,
  ).toBe('execution_failed');
});
