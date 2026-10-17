import { expect, it } from 'vitest';
import { memorySearchPatterns } from './search-patterns.ts';

it('finds a watchlist through Chinese keywords and whole ticker tokens', () => {
  const query = memorySearchPatterns(
    '美股监控助手 8个标的 NVDA COIN 000660.KS',
  );
  expect(query.patterns).toContain('%标的%');
  expect(query.patterns).toContain('%nvda%');
  expect(query.patterns).toContain('%coin%');
  expect(query.patterns).toContain('%000660.ks%');
  expect(query.exact).toBe('%美股监控助手 8个标的 NVDA COIN 000660.KS%');
});
it('treats LIKE metacharacters as data and bounds expansion', () => {
  const query = memorySearchPatterns('归档 A_B 100% \\ 根目录');
  expect(query.exact).toBe('%归档 A\\_B 100\\% \\\\ 根目录%');
  expect(query.patterns).toContain('%a\\_b%');
  expect(
    memorySearchPatterns('研发'.repeat(500)).patterns.length,
  ).toBeLessThanOrEqual(25);
  expect(memorySearchPatterns('   ').patterns).toEqual([]);
});
