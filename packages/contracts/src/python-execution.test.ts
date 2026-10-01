import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PythonExecuteArgsSchema } from './python-execution.ts';
import {
  CloudCommandInputSchema,
  CloudCommandSchema,
  cloudPythonImageV1,
  cloudToolchainImageV1,
} from './runtime-v2/cloud-command.ts';
import {
  RuntimeLocalPythonPayloadSchema,
  RuntimeLocalPythonPngValidationSchema,
} from './runtime-v2/local-python.ts';

const png = { path: '图表.png', fileName: '中文图表.png', format: 'png' };
describe('canonical Python and frozen command compatibility', () => {
  it('accepts a PNG without injecting language/location into the original call', () => {
    const raw = { script: 'print("原始调用")', outputs: [png] };
    const before = JSON.stringify(raw);
    const result = PythonExecuteArgsSchema.parse(raw);
    expect(result).not.toHaveProperty('language');
    expect(result).not.toHaveProperty('location');
    expect(result.outputs).toEqual([png]);
    expect(JSON.stringify(raw)).toBe(before);
    expect(CloudCommandInputSchema.safeParse(raw).success).toBe(false);
    expect(
      CloudCommandInputSchema.parse({ script: 'console.log(1)' }),
    ).not.toHaveProperty('language');
  });
  it('allows stdout-only computation and rejects unauthorized runtimes, paths and resource expansion', () => {
    expect(
      PythonExecuteArgsSchema.parse({ script: 'print(35)' }).outputs,
    ).toEqual([]);
    for (const extra of [
      { language: 'javascript' },
      { location: 'host' },
      { imageId: cloudPythonImageV1 },
      { frozenScript: { skill: 'office', path: 'scripts/run.mjs' } },
      { outputs: [{ ...png, path: '../图表.png' }] },
      { outputs: [{ ...png, fileName: '图表.txt' }] },
      { limits: { artifactBytes: 4_000_001 } },
      {
        inputs: Array.from({ length: 2 }, () => ({
          path: 'same.csv',
          objectId: randomUUID(),
          checksum: `sha256:${'a'.repeat(64)}`,
        })),
      },
    ])
      expect(
        PythonExecuteArgsSchema.safeParse({ script: 'print(35)', ...extra })
          .success,
      ).toBe(false);
  });
  it('binds canonical cloud origin to Python while preserving legacy command bytes', () => {
    const args = CloudCommandInputSchema.parse({
      script: 'print(35)',
      language: 'python',
    });
    const python = {
      capability: 'cloud.process.execute',
      arguments: args,
      backend: 'cloud-gvisor-v1',
      imageDigest: cloudPythonImageV1,
      runtime: 'runsc',
      network: 'none',
      origin: {
        toolName: 'python.execute',
        callId: 'original',
        purpose: 'python_charts',
        argumentsDigest: `sha256:${'a'.repeat(64)}`,
      },
    };
    expect(CloudCommandSchema.parse(python)).toEqual(python);
    const legacy = {
      ...python,
      arguments: CloudCommandInputSchema.parse({ script: 'console.log(35)' }),
      imageDigest: cloudToolchainImageV1,
    };
    expect(CloudCommandSchema.safeParse(legacy).success).toBe(false);
    const { origin: _origin, ...old } = legacy;
    void _origin;
    expect(JSON.stringify(CloudCommandSchema.parse(old))).toBe(
      JSON.stringify(old),
    );
    expect(CloudCommandSchema.parse(old)).not.toHaveProperty('origin');
  });
  it('allows zero files only for the chart purpose and bounds the original checker report', () => {
    const payload = {
      capability: 'local.python.execute',
      arguments: {
        path: '.',
        purpose: 'python_charts',
        origin: {
          toolName: 'python.execute',
          callId: 'stdout',
          argumentsDigest: `sha256:${'a'.repeat(64)}`,
        },
        script: 'print(35)',
        inputs: [],
        outputs: [],
        profileVersion: 1,
        imageId: `sha256:${'b'.repeat(64)}`,
        architecture: 'amd64',
        isolation: 'local-vm-container-v1',
        network: 'none',
        limits: {
          timeoutMs: 30_000,
          inputBytes: 2_000_000,
          artifactBytes: 1_000_000,
          outputBytes: 32_768,
          memoryMiB: 256,
          cpuMillis: 500,
          pids: 64,
        },
      },
    };
    expect(RuntimeLocalPythonPayloadSchema.safeParse(payload).success).toBe(
      true,
    );
    expect(
      RuntimeLocalPythonPayloadSchema.safeParse({
        ...payload,
        arguments: {
          ...payload.arguments,
          purpose: 'office',
          origin: {
            ...payload.arguments.origin,
            toolName: 'workspace.export.create',
          },
        },
      }).success,
    ).toBe(false);
    const report = {
      checker: 'pillow-11.3.0',
      checksum: `sha256:${'c'.repeat(64)}`,
      width: 2160,
      height: 1404,
    };
    expect(RuntimeLocalPythonPngValidationSchema.parse(report)).toEqual(report);
    for (const extra of [
      { checker: 'guessed' },
      { width: 8193 },
      { width: 4096, height: 4096 },
    ])
      expect(
        RuntimeLocalPythonPngValidationSchema.safeParse({ ...report, ...extra })
          .success,
      ).toBe(false);
  });
});
