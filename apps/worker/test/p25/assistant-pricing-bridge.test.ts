import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantRuntime } from '@allrice/database';
import { createAssistantWorkerBridge } from '../../src/harness/dsh/assistant-bridge.js';

type Options = Parameters<typeof createAssistantWorkerBridge>[0];
/** Protocol-order unit seam; authoritative receipt validation is covered by
 * real PG + native Gemini synthetic-HTTP integration, not these mock objects. */
function fixture(onModelUsage?: Options['onModelUsage']) {
  const runId = randomUUID(),
    callId = randomUUID();
  const settleUsage = vi.fn(async () => {});
  const runtime = {
    getTree: vi.fn(async () => ({
      instances: [{ nativeSessionId: 'synthetic-root', runId }],
    })),
    settleUsage,
  } as unknown as AssistantRuntime;
  const bridge = createAssistantWorkerBridge({
    runtime,
    task: { rootRunId: runId, scope: {} } as Options['task'],
    context: {} as Options['context'],
    worker: {} as Options['worker'],
    wireNames: {},
    readOnlyTools: new Set(),
    onModelUsage,
  });
  const params = {
    nativeSessionId: 'synthetic-root',
    callId,
    requestDigest: `sha256:${'b'.repeat(64)}`,
    inputTokens: 20,
    outputTokens: 7,
  };
  return { bridge, settleUsage, runId, params };
}

describe('assistant pricing settlement acknowledgement', () => {
  it('persists token settlement before pricing and never invents known cache zeros', async () => {
    const price = vi.fn(async () => {
      expect(f.settleUsage).toHaveBeenCalledOnce();
    });
    const f = fixture(price);
    await expect(f.bridge.handle('model-settle', f.params)).resolves.toEqual({
      settled: true,
    });
    expect(price).toHaveBeenCalledWith({
      runId: f.runId,
      callId: f.params.callId,
      requestDigest: f.params.requestDigest,
      usage: {
        inputTokens: 20,
        outputTokens: 7,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        usageComplete: true,
      },
    });
  });
  it('passes missing token totals as unknown, never zero', async () => {
    const price = vi.fn(async () => {}),
      f = fixture(price);
    await f.bridge.handle('model-settle', {
      ...f.params,
      outputTokens: undefined,
    });
    expect(price).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: {
          inputTokens: 20,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          usageComplete: false,
        },
      }),
    );
  });
  it('cannot acknowledge a model call when its pricing receipt is rejected', async () => {
    const f = fixture(async () => {
      throw Error('synthetic_receipt_conflict');
    });
    await expect(f.bridge.handle('model-settle', f.params)).rejects.toThrow(
      'synthetic_receipt_conflict',
    );
    expect(f.settleUsage).toHaveBeenCalledOnce();
  });
  it.each([undefined, 'wrong', `sha256:${'z'.repeat(64)}`])(
    'rejects invalid request digest before modifying settlement (%s)',
    async (requestDigest) => {
      const f = fixture(async () => {});
      await expect(
        f.bridge.handle('model-settle', { ...f.params, requestDigest }),
      ).rejects.toThrow();
      expect(f.settleUsage).not.toHaveBeenCalled();
    },
  );
  it('keeps the legacy unpriced protocol compatible without a pricing digest', async () => {
    const f = fixture();
    await expect(
      f.bridge.handle('model-settle', {
        ...f.params,
        requestDigest: undefined,
      }),
    ).resolves.toEqual({ settled: true });
  });
});
