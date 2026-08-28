import { describe, expect, it } from 'vitest';

import { runtimeCapabilityCatalog } from './runtime-capability-catalog';

describe('runtime capability source catalog', () => {
  it('keeps the three authority groups explicit and disjoint', () => {
    expect(runtimeCapabilityCatalog.map((group) => group.source)).toEqual([
      'migrated',
      'allrice',
      'blocked',
    ]);

    const ids = runtimeCapabilityCatalog.flatMap((group) =>
      group.items.map((item) => item.id),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('records the complete MET-91 first batch', () => {
    const migrated = runtimeCapabilityCatalog.find(
      (group) => group.source === 'migrated',
    );
    expect(migrated?.items.map((item) => item.packageName)).toEqual([
      '@deepseek-ai/dsh-llm-retry',
      '@deepseek-ai/dsh-tool-call-timeout-policy',
      '@deepseek-ai/dsh-compaction-tool-result-pruner',
      '@deepseek-ai/dsh-repeat-tool-reminder',
      '@deepseek-ai/dsh-user-questions',
      '@deepseek-ai/dsh-tool-ask-user',
      '@deepseek-ai/dsh-tool-todo',
    ]);
  });

  it('does not present unrestricted host tools as migrated', () => {
    const migratedPackages = runtimeCapabilityCatalog
      .find((group) => group.source === 'migrated')
      ?.items.flatMap((item) => item.packageName ?? []);
    expect(migratedPackages?.join(' ')).not.toMatch(
      /tool-bash|tool-fs|subagent|dynamic-plugin|mcp/i,
    );
  });
});
