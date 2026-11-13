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

  it('preserves the default normalized coordinate contract for existing callers', () => {
    expect(chunkKnowledgeText(' \r\n甲\r\n乙 ')).toEqual([
      { content: '甲\n乙', start: 0, end: 3 },
    ]);
  });

  it('uses original BOM, whitespace and CRLF coordinates across new reference chunks', () => {
    const prefix = '\ufeff \r\n\t';
    const text = prefix + '编号与收入\r\n'.repeat(700) + '最后中文结论\r\n ';
    const chunks = chunkKnowledgeText(text, { preserveOffsets: true });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.start).toBe(prefix.length);
    expect(chunks.some((chunk) => chunk.content.includes('\r\n'))).toBe(true);
    expect(chunks.at(-1)!.content).toContain('最后中文结论');
    for (const [index, chunk] of chunks.entries()) {
      expect(text.slice(chunk.start, chunk.end)).toBe(chunk.content);
      expect(chunk.content.length).toBeLessThanOrEqual(2400);
      if (index) expect(chunk.start).toBeLessThan(chunks[index - 1]!.end);
    }
  });

  it('keeps original chunk boundaries valid when a Unicode character spans the cut', () => {
    const text = 'a'.repeat(2399) + '😀' + 'b'.repeat(3000);
    const chunks = chunkKnowledgeText(text, { preserveOffsets: true });
    expect(chunks[0]!.end).toBe(2399);
    for (const chunk of chunks) {
      expect(text.slice(chunk.start, chunk.end)).toBe(chunk.content);
      expect(Buffer.from(chunk.content).toString('utf8')).toBe(chunk.content);
    }
    expect(chunks.some((chunk) => chunk.content.includes('😀'))).toBe(true);
  });
});
