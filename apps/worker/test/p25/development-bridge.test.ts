import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { runtimePolicyDigest, type AssistantRuntime } from '@allrice/database';
import { createAssistantWorkerBridge } from '../../src/harness/dsh/assistant-bridge.js';

type Options = Parameters<typeof createAssistantWorkerBridge>[0];
describe('development control call identity', () => {
  it('persists approval request guidance in the tester message, including recovery dispatch', async () => {
    const runId = randomUUID(),
      childRunId = randomUUID();
    const parent = {
      runId,
      nativeSessionId: 'root',
      allowedTools: ['assistant.delegate', 'assistant.development'],
    };
    const child = {
      runId: childRunId,
      parentRunId: runId,
      nativeSessionId: 'tester',
      allowedTools: [
        'assistant.development',
        'assistant.report',
        'local.process.execute',
      ],
    };
    let persistedText = '';
    const provision = vi.fn(async (input: { text: string }) => {
      persistedText = input.text;
      return { instance: child };
    });
    const onProposal = vi.fn();
    const bridge = createAssistantWorkerBridge({
      runtime: {
        getTree: async () => ({
          instances: [parent, child],
          configuration: { maxDepth: 1 },
        }),
        reserveUsage: async () => ({ reserved: true }),
        settleUsage: async () => {},
        provision,
        claimMessage: async () => ({
          dispatch: true,
          instance: child,
          message: { text: persistedText },
        }),
      } as unknown as AssistantRuntime,
      task: { rootRunId: runId, scope: {} } as Options['task'],
      context: {} as Options['context'],
      worker: {} as Options['worker'],
      wireNames: {},
      readOnlyTools: new Set(),
      onProposal,
      onDevelopment: vi.fn(),
    });
    const callId = randomUUID();
    const first = await bridge.handle('delegate', {
      nativeSessionId: 'root',
      callId,
      arguments: {
        label: 'tester',
        text: 'Wait for exact web approval.',
        tools: child.allowedTools,
        development: JSON.stringify({
          role: 'test',
          expectedHead: {
            artifactId: randomUUID(),
            digest: `sha256:${'a'.repeat(64)}`,
          },
        }),
      },
    });
    expect(first.text).toContain('to REQUEST approval');
    expect(first.text).toContain('only dispatches after approval');
    expect(first.text).toContain('Do not pass assignmentId');
    expect(first.text).not.toContain('"assignmentId":');
    const recovered = await bridge.messageDispatch(callId);
    expect(recovered.text).toBe(first.text);
    expect(onProposal).not.toHaveBeenCalled();
  });
  it('rejects malformed verifier assignments with usable guidance before creating a child', async () => {
    const runId = randomUUID();
    const provision = vi.fn();
    const onDevelopment = vi.fn();
    const settleUsage = vi.fn();
    const bridge = createAssistantWorkerBridge({
      runtime: {
        getTree: async () => ({
          instances: [
            {
              runId,
              nativeSessionId: 'root',
              allowedTools: ['assistant.delegate', 'assistant.development'],
            },
          ],
        }),
        reserveUsage: async () => ({ reserved: true }),
        settleUsage,
        provision,
      } as unknown as AssistantRuntime,
      task: { rootRunId: runId, scope: {} } as Options['task'],
      context: {} as Options['context'],
      worker: {} as Options['worker'],
      wireNames: {},
      readOnlyTools: new Set(),
      onDevelopment,
    });
    const expectedHead = {
      artifactId: randomUUID(),
      digest: `sha256:${'a'.repeat(64)}`,
    };
    const invalid = [
      'private-malformed{',
      ...['test', 'review'].map((role) =>
        JSON.stringify({ expectedHead, role, paths: ['test.mjs'] }),
      ),
      JSON.stringify({ expectedHead, role: 'edit' }),
    ];
    for (const development of invalid) {
      const result = await bridge.handle('delegate', {
        nativeSessionId: 'root',
        callId: randomUUID(),
        arguments: {
          label: 'test',
          text: 'test',
          tools: [
            'assistant.development',
            'assistant.report',
            'local.process.execute',
          ],
          development,
        },
      });
      expect(result).toMatchObject({
        error: 'assistant_development_assignment_invalid',
        message: expect.stringContaining('omit paths'),
      });
      expect(JSON.stringify(result)).not.toContain('private-malformed');
    }
    expect(provision).not.toHaveBeenCalled();
    expect(onDevelopment).not.toHaveBeenCalled();
    expect(settleUsage).toHaveBeenCalledTimes(invalid.length);
  });
  it('returns actionable bounded validation errors and never invokes invalid commands', async () => {
    const runId = randomUUID();
    const onDevelopment = vi.fn(async () => ({ initialized: true }));
    const settleUsage = vi.fn(async () => {});
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
        reserveUsage: async () => ({ reserved: true }),
        settleUsage,
      } as unknown as AssistantRuntime,
      task: { rootRunId: runId, scope: {} } as Options['task'],
      context: {} as Options['context'],
      worker: {} as Options['worker'],
      wireNames: {},
      readOnlyTools: new Set(),
      onDevelopment,
    });
    const ref = {
      artifactId: randomUUID(),
      digest: `sha256:${'a'.repeat(64)}`,
    };
    for (const command of [
      JSON.stringify({
        action: 'inspect',
        assignmentId: ref.artifactId,
        candidate: ref,
      }),
      'secret-parser-input{',
      JSON.stringify({ action: 'initialize', seed: ref.artifactId }),
      JSON.stringify({
        action: 'initialize',
        seed: { artifactId: ref.artifactId },
      }),
      JSON.stringify({ action: 'initialize', seed: ref, approved: true }),
    ]) {
      const result = await bridge.handle('development', {
        nativeSessionId: 'root',
        callId: randomUUID(),
        arguments: { command },
      });
      expect(result).toMatchObject({
        error: 'assistant_development_invalid',
        message: expect.stringContaining('workspace.export.create'),
      });
      expect(JSON.stringify(result)).not.toContain('secret-parser-input');
    }
    expect(onDevelopment).not.toHaveBeenCalled();
    expect(settleUsage).toHaveBeenCalledTimes(5);
    await bridge.handle('development', {
      nativeSessionId: 'root',
      callId: randomUUID(),
      arguments: {
        command: JSON.stringify({ action: 'initialize', seed: ref }),
      },
    });
    expect(onDevelopment).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: { action: 'initialize', seed: ref },
      }),
    );
  });
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
