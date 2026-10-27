import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import {
  archivedMigrationNames,
  migrationsMatch,
} from './migration-compatibility.ts';

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
  it('never reuses an archived migration number ', () => {
    const retired = archivedMigrationNames.map((name) => name.slice(0, 4));
    expect(active.filter((name) => retired.includes(name.slice(0, 4)))).toEqual(
      [],
    );
  });
});
