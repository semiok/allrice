import { afterEach, expect, it, vi } from 'vitest';
import {
  CloudCommandInputSchema,
  CloudCommandRequestSchema,
  normalizeCloudCommandArguments,
} from './cloud-command.ts';
import {
  configuredCloudCommandRuntimeLimits,
  cloudCommandRuntimeDefaults,
} from './cloud-command-limits.ts';
import { PythonExecuteArgsSchema } from '../python-execution.ts';

afterEach(() => vi.unstubAllEnvs());

it('keeps durable/local defaults static while new cloud requests retain omissions', () => {
  vi.stubEnv('ALLRICE_CLOUD_COMMAND_TIMEOUT_MS', '1500');
  vi.stubEnv('ALLRICE_CLOUD_COMMAND_OUTPUT_BYTES', '2048');
  const original = { script: 'print("中文")', limits: { timeoutMs: 500 } };
  expect(configuredCloudCommandRuntimeLimits({})).toEqual({
    timeoutMs: 30000,
    outputBytes: 32768,
  });
  expect(CloudCommandRequestSchema.parse(original).limits).not.toHaveProperty(
    'outputBytes',
  );
  expect(
    normalizeCloudCommandArguments(
      original,
      configuredCloudCommandRuntimeLimits(),
    ).limits,
  ).toMatchObject({ timeoutMs: 500, outputBytes: 2048 });
  expect(CloudCommandInputSchema.parse({ script: '0' }).limits).toMatchObject(
    cloudCommandRuntimeDefaults,
  );
  expect(PythonExecuteArgsSchema.parse({ script: '0' }).limits).toMatchObject(
    cloudCommandRuntimeDefaults,
  );
  expect(original).toEqual({
    script: 'print("中文")',
    limits: { timeoutMs: 500 },
  });
});

it.each([
  ['ALLRICE_CLOUD_COMMAND_TIMEOUT_MS', ['499', '60001', '500.5', '', 'NaN']],
  [
    'ALLRICE_CLOUD_COMMAND_OUTPUT_BYTES',
    ['1023', '65537', '1024.5', ' ', 'bad'],
  ],
] as const)(
  'rejects invalid deployment values with %s in the error',
  (name, values) => {
    for (const value of values)
      expect(() =>
        configuredCloudCommandRuntimeLimits({ [name]: value }),
      ).toThrow(name);
  },
);

it('native and Broker enforce identical endpoints without injecting server defaults', async () => {
  const native = await import(
    new URL(
      '../../../../apps/worker/dsh/allrice-cloud-native-tools.mjs',
      import.meta.url,
    ).href
  );
  for (const schema of [
    native.CloudNativeArgumentsSchema,
    CloudCommandRequestSchema,
  ]) {
    for (const limits of [
      { timeoutMs: 500, outputBytes: 1024 },
      { timeoutMs: 60000, outputBytes: 65536 },
    ])
      expect(schema.parse({ script: '0', limits }).limits).toMatchObject(
        limits,
      );
    for (const limits of [
      { timeoutMs: 499 },
      { timeoutMs: 60001 },
      { outputBytes: 1023 },
      { outputBytes: 65537 },
    ])
      expect(() => schema.parse({ script: '0', limits })).toThrow();
    expect(schema.parse({ script: '0' }).limits?.timeoutMs).toBeUndefined();
    expect(schema.parse({ script: '0' }).limits?.outputBytes).toBeUndefined();
  }
});
