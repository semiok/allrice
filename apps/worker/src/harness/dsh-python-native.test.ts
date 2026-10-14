import { expect, it } from 'vitest';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';
import { requireSuccessfulCloudCommand } from '../cloud-runner/tool-result.js';
import type { RiceToolExecutionInput } from '../tool-broker/types.js';

it('delivers output-limit failures as native isError results instead of successful JSON', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'python.execute',
    wireName: 'python_execute',
    args: { script: 'print("synthetic")' },
    invalidArgs: { script: 'not executed', location: 'host' },
    expectedToolError: '标准输出超出本次 outputBytes 上限',
    onToolCall: async (call) => {
      requireSuccessfulCloudCommand(
        { context: { runId: 'synthetic' }, call } as RiceToolExecutionInput,
        {
          status: 'failed',
          reason: 'output_limit',
          exitCode: 122,
          stopped: true,
          cleanupConfirmed: true,
        },
      );
      throw Error('failed command unexpectedly returned');
    },
  });
}, 45_000);

it('exposes canonical Python location to the actual DSH model and preserves omitted runtime fields', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'python.execute',
    wireName: 'python_execute',
    args: {
      script: 'print("中文原始调用")',
      outputs: [{ path: '图表.png', fileName: '图表.png', format: 'png' }],
    },
    invalidArgs: { script: 'not executed', location: 'host' },
    inspectSchema(schema) {
      expect(schema.properties).toMatchObject({
        location: { enum: ['auto', 'local', 'cloud'] },
        language: { enum: ['python'] },
        script: { type: 'string' },
      });
      expect(schema.required).toContain('script');
      expect(schema.properties).not.toHaveProperty('frozenScript');
    },
  });
}, 45_000);

it('preserves an explicit local stdout-only call and rejects JavaScript before Broker', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'python.execute',
    wireName: 'python_execute',
    args: { script: 'print(35)', location: 'local', outputs: [] },
    invalidArgs: { script: 'not executed', language: 'javascript' },
  });
}, 45_000);
