import { describe, expect, it } from 'vitest';

import { chunkKnowledgeText } from './knowledge.js';

describe('Knowledge text chunking', () => {
  it('is deterministic, bounded and overlapping', () => {
    const text = `${'甲'.repeat(1_600)}\n\n${'乙'.repeat(1_600)}`;
    const first = chunkKnowledgeText(text);
    const second = chunkKnowledgeText(text);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(1);
    expect(first.every((chunk) => chunk.content.length <= 2_400)).toBe(true);
    expect(first[1]!.start).toBeLessThan(first[0]!.end);
  });

  it('does not index empty documents', () => {
    expect(chunkKnowledgeText(' \n\n ')).toEqual([]);
  });
});
