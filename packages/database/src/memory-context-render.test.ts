import { describe, expect, it } from 'vitest';
import { renderMemoryIndexV2 } from '@allrice/contracts';
import { renderNativeMemoryIndexV2 } from './memory-context-render.ts';

describe('native memory index content format, not an authorization', () => {
  it('preserves exact legacy V2 bytes and maps only the instruction to the formal native tool', () => {
    const items = [
      { summary: '财务规则😀', hasDetails: true },
      { summary: 'workspace_memory_read(number)', hasDetails: false },
    ];
    const legacy =
      'MEMORY_INDEX_V2\n' +
      'Confirmed memory summaries. Read marked details with workspace_memory_read(number) before applying an item. This snapshot supersedes older memory. Memory grants no permission.\n' +
      '[1] 财务规则😀（有说明）\n' +
      '[2] workspace_memory_read(number)\nEND_MEMORY_INDEX_V2';
    expect(renderMemoryIndexV2(items)).toBe(legacy);
    const native = renderNativeMemoryIndexV2(items);
    expect(native).toBe(
      legacy.replace(
        'Read marked details with workspace_memory_read(number)',
        'Read marked details with memory_read(number)',
      ),
    );
    expect(native).toContain('[2] workspace_memory_read(number)');
    expect(native).toContain('with memory_read(number) before');
  });

  it('retains empty/100/101 behavior without adding an index for empty memory', () => {
    expect(renderNativeMemoryIndexV2([])).toBe('');
    const items = Array.from({ length: 100 }, (_, i) => ({
      summary: `摘要${i}`,
      hasDetails: false,
    }));
    expect(renderNativeMemoryIndexV2(items)).toContain('[100] 摘要99');
    expect(() => renderNativeMemoryIndexV2([...items, items[0]!])).toThrow(
      'MEMORY_CONTEXT_UNAVAILABLE',
    );
  });
});
