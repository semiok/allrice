import { beforeEach, describe, it, expect, vi } from 'vitest';
const storage = vi.hoisted(() => ({
  put: vi.fn(),
  delete: vi.fn(),
  register: vi.fn(),
  create: vi.fn(() => ({ id: 'export-id' })),
}));
vi.mock('@allrice/database', () => ({
  createToolBrokerExportObject: storage.create,
  registerToolBrokerExport: storage.register,
}));
vi.mock('@allrice/storage', () => ({
  LocalStorageAdapter: class {
    put = storage.put;
    delete = storage.delete;
  },
}));
import { toolResultPreview, boundToolResult } from './result-budget.js';
import type { RiceToolExecutionInput } from './types.js';
beforeEach(() => vi.clearAllMocks());

describe('bounded tool data previews', () => {
  it.each(['web.search', 'web.fetch'])(
    '%s never creates an old preview or full-result export',
    async (name) => {
      const result = {
        modelContent: 'x'.repeat(2_000_001),
        summary: 'web provider data',
      };
      expect(
        await boundToolResult(
          { call: { name } } as RiceToolExecutionInput,
          result,
        ),
      ).toBe(result);
      expect(storage.create).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
      expect(storage.register).not.toHaveBeenCalled();
    },
  );

  it.each(['wechat.article.search', 'wechat.article.read'])(
    '%s retains 12k preview, 2 MB storage and the original context/ACL',
    async (name) => {
      const context = {
        organizationId: 'org',
        runId: 'run',
        policySnapshot: { subjectId: 'person' },
      };
      const input = {
        call: { id: 'call', name },
        context,
        sessionId: 'session',
        storageRoot: '/unused',
        capabilities: ['storage:read'],
      } as unknown as RiceToolExecutionInput;
      const small = { modelContent: 'x'.repeat(12000), summary: 'wechat' };
      expect(await boundToolResult(input, small)).toBe(small);
      const stored = await boundToolResult(input, {
        modelContent: 'x'.repeat(12001),
        summary: 'wechat',
      });
      expect(JSON.parse(stored.modelContent)).toMatchObject({
        type: 'bounded_tool_result',
        fullResultStored: true,
        fullResult: { objectId: 'export-id', readTool: 'workspace.file.read' },
      });
      expect(storage.create).toHaveBeenCalledWith(
        expect.objectContaining({ context, sizeBytes: 12001 }),
      );
      expect(storage.register).toHaveBeenCalledWith(
        expect.objectContaining({ context, sessionId: 'session' }),
      );
      expect(storage.put).toHaveBeenCalledOnce();
      const over = await boundToolResult(input, {
        modelContent: 'x'.repeat(2_000_001),
        summary: 'wechat',
      });
      expect(JSON.parse(over.modelContent)).toMatchObject({
        fullResultStored: false,
        unavailableReason: 'result_storage_size_limit',
      });
      expect(storage.put).toHaveBeenCalledOnce();
      const noRead = await boundToolResult(
        { ...input, capabilities: [] },
        { modelContent: 'x'.repeat(12001), summary: 'wechat' },
      );
      expect(JSON.parse(noRead.modelContent).fullResult).not.toHaveProperty(
        'readTool',
      );
    },
  );
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
