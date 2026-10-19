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

it('exposes optional revision UUIDs and roundtrips exact PNG/CSV parents through native DSH', async () => {
  const outputs = [
    {
      path: '图表/本期.png',
      fileName: '本期.png',
      format: 'png',
      parentObjectId: '11111111-1111-4111-8111-111111111111',
    },
    {
      path: '数据/本期.csv',
      fileName: '本期.csv',
      format: 'csv',
      parentObjectId: '22222222-2222-4222-8222-222222222222',
    },
  ];
  await nativeBrokerRoundtrip({
    canonicalName: 'python.execute',
    wireName: 'python_execute',
    args: { script: 'print("原始续版调用")', outputs },
    invalidArgs: {
      script: 'not executed',
      outputs: [{ ...outputs[0], parentObjectId: 'not-a-uuid' }],
    },
    inspectSchema(schema) {
      const properties = schema.properties as Record<string, unknown>;
      const outputSchema = properties.outputs as {
        items: {
          properties: Record<string, unknown>;
          required: string[];
          additionalProperties: boolean;
        };
      };
      expect(outputSchema.items.properties.parentObjectId).toMatchObject({
        type: 'string',
        // The DSH DSL exposes shape/annotations; its Zod validator below
        // rejects invalid UUIDs before the Broker without adding defaults.
        description: expect.stringContaining('UUID'),
      });
      expect(outputSchema.items.required).not.toContain('parentObjectId');
      expect(outputSchema.items.required).toEqual(
        expect.arrayContaining(['path', 'fileName', 'format']),
      );
      expect(outputSchema.items.additionalProperties).toBe(false);
      for (const field of ['seriesId', 'version', 'parentVersionId'])
        expect(outputSchema.items.properties).not.toHaveProperty(field);
    },
  });
}, 45_000);
