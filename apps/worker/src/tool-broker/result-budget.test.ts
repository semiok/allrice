import { describe, it, expect } from 'vitest';
import { toolResultPreview, boundToolResult } from './result-budget.js';
import type { RiceToolExecutionInput } from './types.js';

describe('bounded tool data previews', () => {
  it('samples array ends, labels omissions and keeps serialized JSON valid', () => {
    const preview = toolResultPreview(
      JSON.stringify({
        rows: Array.from({ length: 1000 }, (_, index) => ({ index })),
      }),
    );
    expect(preview).toMatchObject({
      rows: { totalItems: 1000, omittedMiddleItems: 992 },
    });
    expect(JSON.stringify(preview)).toContain('999');
    expect(JSON.stringify(preview)).not.toContain('500');
  });
  it('bounds nested or non-JSON text without representing it as a complete result', () => {
    for (const text of [
      'x'.repeat(50000),
      JSON.stringify(Array.from({ length: 10 }, () => '中文'.repeat(10000))),
    ])
      expect(JSON.stringify(toolResultPreview(text)).length).toBeLessThan(8000);
  });
  it('never truncates approval/execution contracts and leaves small results unchanged', async () => {
    const result = { modelContent: 'x'.repeat(30000), summary: 'approval' };
    expect(
      await boundToolResult(
        { call: { name: 'local.process.execute' } } as RiceToolExecutionInput,
        result,
      ),
    ).toBe(result);
    const small = { modelContent: '{}', summary: 'small' };
    expect(
      await boundToolResult(
        { call: { name: 'web.search' } } as RiceToolExecutionInput,
        small,
      ),
    ).toBe(small);
  });
  it.each(['workspace.memory.search', 'workspace.experience.read'])(
    'never exports private %s results into an unguarded file',
    async (name) => {
      // No storage/context exists: any attempt to export would throw differently.
      const input = { call: { name } } as RiceToolExecutionInput;
      const small = {
        modelContent: JSON.stringify({ items: [{ content: '禁止省略条件' }] }),
        summary: 'complete',
      };
      expect(await boundToolResult(input, small)).toBe(small);
      await expect(
        boundToolResult(input, {
          modelContent: '中'.repeat(3000),
          summary: 'overflow',
        }),
      ).rejects.toMatchObject({
        code: 'MEMORY_CONTEXT_BUDGET_EXHAUSTED',
        retryable: false,
      });
    },
  );
});
