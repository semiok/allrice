import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import {
  archivedMigrationNames,
  migrationsMatch,
} from './migration-compatibility.ts';

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

describe('native generation migration archive', () => {
  const active = readdirSync(new URL('../migrations/', import.meta.url)).filter(
    (name) => name.endsWith('.sql'),
  );
  it('accepts every deployed subset of the exact archived names', () => {
    const drafts = archivedMigrationNames.filter((name) =>
      name.startsWith('021'),
    );
    expect(drafts).toHaveLength(4);
    for (let mask = 0; mask < 16; mask++) {
      expect(
        migrationsMatch(active, [
          ...active,
          ...drafts.filter((_, i) => mask & (1 << i)),
        ]),
      ).toBe(true);
    }
    for (const name of drafts) {
      expect(
        migrationsMatch(active, [
          ...active,
          name.replace('.sql', '_renamed.sql'),
        ]),
      ).toBe(false);
      expect(migrationsMatch(active, [...active, name, name])).toBe(false);
    }
  });
  it('never reuses an archived migration number except the historical 0073', () => {
    const retired = archivedMigrationNames
      .filter((name) => !name.startsWith('0073_'))
      .map((name) => name.slice(0, 4));
    expect(active.filter((name) => retired.includes(name.slice(0, 4)))).toEqual(
      [],
    );
  });
});
