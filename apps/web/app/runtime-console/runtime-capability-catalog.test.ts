import { describe, expect, it } from 'vitest';

import { runtimeCapabilityCatalog } from './runtime-capability-catalog';

describe('runtime capability source catalog', () => {
  it('keeps runtime plugins, AllRice capabilities and blocked items disjoint', () => {
    expect(runtimeCapabilityCatalog.map((group) => group.source)).toEqual([
      'allrice',
      'blocked',
    ]);

    const ids = [
      ...runtimeCapabilityCatalog.flatMap((group) =>
        group.items.map((item) => item.id),
      ),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps execution descriptions separate from live installation and activation facts', () => {
    const allrice = runtimeCapabilityCatalog.find(
      (group) => group.source === 'allrice',
    );
    expect(allrice?.description).toContain('实时数据');
    expect(allrice?.items.some((item) => item.id === 'subagent')).toBe(true);
    const differences = runtimeCapabilityCatalog.find(
      (group) => group.source === 'blocked',
    );
    expect(differences?.items.some((item) => item.id === 'bash')).toBe(true);
  });

  it('names the Mac app AllRice 助手 while keeping its internal id (MET-214)', () => {
    const items = runtimeCapabilityCatalog.flatMap((group) => group.items);
    expect(items.find((item) => item.id === 'rice-bridge')?.name).toBe(
      'AllRice 助手',
    );
    expect(JSON.stringify(runtimeCapabilityCatalog)).not.toMatch(/Bridge/);
  });
});
