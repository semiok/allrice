import { withEmployeeMemorySourceTool } from './tool-manifest.ts';
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  initialMemoryContextBytes,
  memoryContextBytes,
  renderMemoryContext,
  selectWholeMemories,
  RunMemoryContextStateSchema,
  memoryContextPolicy,
} from './memory-context.ts';

describe('whole memory transport budgets', () => {
  it('counts UTF-8 bytes including the actual locator and kernel wrapper', () => {
    const item = {
      id: randomUUID(),
      revision: 1,
      content: '已确认记录才纳入；不得包含退款。',
      sourceHandle: `experience:sha256:${'a'.repeat(64)}`,
    };
    expect(memoryContextBytes(item)).toBe(
      Buffer.byteLength(JSON.stringify(item)),
    );
    expect(memoryContextBytes(item)).toBeGreaterThan(
      JSON.stringify(item).length,
    );
    expect(initialMemoryContextBytes([item])).toBeGreaterThanOrEqual(
      Buffer.byteLength(renderMemoryContext([item])),
    );
    expect(initialMemoryContextBytes([item])).toBeGreaterThan(
      initialMemoryContextBytes([{ ...item, sourceHandle: undefined }]),
    );
  });
  it('skips whole overlarge entries and preserves numbers, exceptions and negation', () => {
    const oversized = {
      id: randomUUID(),
      content: '原文'.repeat(2000) + '不得计入退款。',
    };
    const rule = {
      id: randomUUID(),
      content: '本周核对12笔；仅已确认记录纳入，退款必须单列，不能合并。',
    };
    const selected = selectWholeMemories([oversized, rule, rule], 600);
    expect(selected).toEqual([rule]);
    expect(renderMemoryContext(selected)).toContain(rule.content);
    expect(
      selectWholeMemories([rule], initialMemoryContextBytes([rule]) - 1),
    ).toEqual([]);
  });
  it('rejects corrupted or reset accounting instead of inventing a new allowance', () => {
    const id = randomUUID();
    const state = {
      schemaVersion: 1,
      meter: 'utf8_bytes',
      limits: memoryContextPolicy,
      initial: { ids: [id], digest: `sha256:${'b'.repeat(64)}`, bytes: 100 },
      spentBytes: 100,
      toolReads: 0,
    };
    expect(RunMemoryContextStateSchema.safeParse(state).success).toBe(true);
    for (const invalid of [
      null,
      { schemaVersion: 1, pending: true },
      { ...state, spentBytes: 99 },
      { ...state, toolReads: 13 },
      { ...state, initial: { ...state.initial, ids: [id, id] } },
      { ...state, limits: { ...memoryContextPolicy, maximumRunBytes: 999999 } },
    ])
      expect(RunMemoryContextStateSchema.safeParse(invalid).success).toBe(
        false,
      );
  });
  it('adds source expansion only to a new Run with an existing memory read grant', () => {
    const frozen = ['workspace.memory.search'];
    expect(withEmployeeMemorySourceTool(frozen, ['storage:read'])).toContain(
      'workspace.experience.read',
    );
    expect(frozen).toEqual(['workspace.memory.search']);
    expect(withEmployeeMemorySourceTool(frozen, [])).not.toContain(
      'workspace.experience.read',
    );
    expect(
      withEmployeeMemorySourceTool(['workspace.file.read'], ['storage:read']),
    ).not.toContain('workspace.experience.read');
  });
});
