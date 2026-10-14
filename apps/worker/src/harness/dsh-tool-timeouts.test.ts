import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, {
  defineTool,
  type ToolExecutionInput,
} from '@deepseek-ai/dsh-tools';
import * as timeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy';

const native = await import(
  new URL('../../dsh/allrice-cloud-native-tools.mjs', import.meta.url).href
);
const python = native.cloudNativeTools.find(
  (tool: { canonicalName: string }) => tool.canonicalName === 'python.execute',
) as { wireName: string; timeoutMs: number };

async function registeredTool(timeoutMs = python.timeoutMs) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(timeoutPolicy);
  let signal: AbortSignal | undefined;
  let finish!: (value: string) => void;
  ctx.tools.register(
    defineTool({
      name: python.wireName,
      description: 'Synthetic admission wait; no Python or model execution.',
      parameters: {},
      timeoutMs,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (_args, exec) => {
        signal = exec.signal;
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
    }),
  );
  const caller = new AbortController();
  const result = ctx.tools.execute({
    name: python.wireName,
    callId: 'synthetic-timeout-call' as ToolExecutionInput['callId'],
    arguments: {},
    signal: caller.signal,
  });
  return {
    ctx,
    caller,
    result,
    signal: () => signal!,
    finish: () => finish('confirmed result after cleanup'),
  };
}

afterEach(() => vi.useRealTimers());
describe('managed tools use the pinned DSH timeout policy', () => {
  it('keeps Python admission waiting past the former three-minute cutoff', async () => {
    vi.useFakeTimers();
    const tool = await registeredTool();
    try {
      await vi.advanceTimersByTimeAsync(180_001);
      expect(tool.signal().aborted).toBe(false);
      tool.finish();
      expect((await tool.result).isError).not.toBe(true);
    } finally {
      await tool.ctx.fiber.dispose();
    }
  });

  it('retains a finite outer deadline and waits for the producer before native TOOL_TIMEOUT', async () => {
    vi.useFakeTimers();
    const tool = await registeredTool();
    let settled = false;
    void tool.result.then(() => (settled = true));
    try {
      await vi.advanceTimersByTimeAsync(python.timeoutMs + 1);
      expect(tool.signal().aborted).toBe(true);
      expect(settled).toBe(false);
      tool.finish();
      expect(await tool.result).toMatchObject({
        isError: true,
        error: { info: { code: 'TOOL_TIMEOUT' } },
      });
    } finally {
      await tool.ctx.fiber.dispose();
    }
  });

  it('preserves parent cancellation rather than classifying it as a tool deadline', async () => {
    vi.useFakeTimers();
    const tool = await registeredTool();
    try {
      await vi.advanceTimersByTimeAsync(1);
      tool.caller.abort();
      expect(tool.signal().aborted).toBe(true);
      tool.finish();
      const result = await tool.result;
      expect(result.isError).toBe(true);
      if (result.isError)
        expect(result.error.info?.code).not.toBe('TOOL_TIMEOUT');
    } finally {
      await tool.ctx.fiber.dispose();
    }
  });
});
