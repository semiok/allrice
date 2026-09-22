import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { runtimePolicyDigest, type AssistantRuntime } from '@allrice/database';
import { createAssistantWorkerBridge } from '../../src/harness/dsh/assistant-bridge.js';

type Options = Parameters<typeof createAssistantWorkerBridge>[0];
describe('development control call identity', () => {
  it('binds the complete command to the durable meter before an idempotent workflow retry', async () => {
    const runId = randomUUID();
    const calls = new Map<string, string>();
    const reserveUsage = vi.fn(
      async (input: Parameters<AssistantRuntime['reserveUsage']>[0]) => {
        const digest = input.nativeCall!.argumentsDigest;
        const old = calls.get(input.callId);
        if (old && old !== digest) throw Error('conflict');
        calls.set(input.callId, digest);
        return { reserved: !old };
      },
    );
    const onDevelopment = vi.fn(async () => ({ inspected: true }));
    const bridge = createAssistantWorkerBridge({
      runtime: {
        getTree: async () => ({
          instances: [
            {
              runId,
              nativeSessionId: 'root',
              allowedTools: ['assistant.development'],
            },
          ],
        }),
        reserveUsage,
        settleUsage: async () => {},
      } as unknown as AssistantRuntime,
      task: { rootRunId: runId, scope: {} } as Options['task'],
      context: {} as Options['context'],
      worker: {} as Options['worker'],
      wireNames: {},
      readOnlyTools: new Set(),
      onDevelopment,
    });
    const args = { command: JSON.stringify({ action: 'inspect' }) };
    const request = {
      nativeSessionId: 'root',
      callId: 'call-1',
      arguments: args,
    };
    await bridge.handle('development', request);
    await bridge.handle('development', request);
    expect(reserveUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nativeCall: {
          id: 'call-1',
          argumentsDigest: runtimePolicyDigest(args),
        },
      }),
    );
    expect(calls.size).toBe(1);
    await expect(
      bridge.handle('development', {
        ...request,
        arguments: { command: JSON.stringify({ action: 'deliver' }) },
      }),
    ).rejects.toThrow('conflict');
    expect(onDevelopment).toHaveBeenCalledTimes(2);
  });
});
