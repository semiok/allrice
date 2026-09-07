import { describe, expect, it } from 'vitest';
import { migrationsMatch } from './migration-compatibility.ts';

describe('exact retired Gemini migration compatibility', () => {
  const expected = [
    '0001_baseline.sql',
    '0073_runtime_operation_ledger.sql',
    '0075_gemini_provider_compat.sql',
  ];
  it('accepts a fresh exact schema', () =>
    expect(migrationsMatch(expected, expected)).toBe(true));
  it('accepts only the exact archived draft in addition to every active migration', () => {
    expect(
      migrationsMatch(expected, [
        ...expected,
        '0073_gemini_model_provider.sql',
      ]),
    ).toBe(true);
  });
  it('rejects unknown, renamed and duplicate extra migrations', () => {
    for (const extra of [
      '0073_other.sql',
      '0073_gemini_model_provider.sql.bak',
      '0075_gemini_provider_compat.sql',
    ])
      expect(migrationsMatch(expected, [...expected, extra])).toBe(false);
  });
  it('does not let the archive replace a missing active migration', () => {
    expect(
      migrationsMatch(expected, [
        ...expected.slice(0, -1),
        '0073_gemini_model_provider.sql',
      ]),
    ).toBe(false);
    expect(migrationsMatch(expected, [])).toBe(false);
  });
});
