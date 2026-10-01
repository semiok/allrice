import { describe, expect, it } from 'vitest';
import {
  CloudCommandInputSchema,
  CloudCommandSchema,
  CloudExecutionProfileSchema,
  cloudPythonImageV1,
  cloudRuntimeImage,
  cloudToolchainImageV1,
} from './cloud-command.ts';

const node = {
  capability: 'cloud.process.execute',
  arguments: {
    script: 'console.log("frozen Node")',
    inputs: [],
    outputs: [],
    limits: {
      timeoutMs: 30000,
      outputBytes: 32768,
      artifactBytes: 1000000,
      memoryMiB: 256,
      cpuMillis: 500,
      pids: 64,
    },
  },
  backend: 'cloud-gvisor-v1',
  imageDigest: cloudToolchainImageV1,
  runtime: 'runsc',
  network: 'none',
};
const png = { path: 'chart.png', fileName: '中文图表.png', format: 'png' };

describe('approved cloud language and binary declarations', () => {
  it('preserves exact legacy frozen Node payloads without adding a language default', () => {
    expect(JSON.stringify(CloudCommandSchema.parse(node))).toBe(
      JSON.stringify(node),
    );
    expect(CloudCommandInputSchema.parse({ script: '0' })).not.toHaveProperty(
      'language',
    );
    expect(cloudRuntimeImage(cloudToolchainImageV1)).toBe(
      cloudToolchainImageV1,
    );
    expect(cloudRuntimeImage(cloudToolchainImageV1, 'javascript')).toBe(
      cloudToolchainImageV1,
    );
  });

  it('binds Python to its additional literal image while keeping the legacy grant profile', () => {
    const python = {
      ...node,
      imageDigest: cloudPythonImageV1,
      arguments: { ...node.arguments, language: 'python', outputs: [png] },
    };
    expect(CloudCommandSchema.parse(python)).toEqual(python);
    expect(() =>
      CloudCommandSchema.parse({
        ...python,
        imageDigest: cloudToolchainImageV1,
      }),
    ).toThrow();
    expect(() =>
      CloudCommandSchema.parse({ ...node, imageDigest: cloudPythonImageV1 }),
    ).toThrow();
    expect(() =>
      CloudExecutionProfileSchema.parse({
        backend: 'cloud-gvisor-v1',
        imageDigest: cloudPythonImageV1,
        architecture: 'amd64',
        runtime: 'runsc',
        runtimeVersion: 'release-20260831.0',
        runtimeChecksum:
          'sha256:1a4995a70b3c8b7d36f55d7d2dc6d15185ebe420de653b1a330b42d36c0e6b4a',
        network: 'none',
        maximumConcurrency: 2,
      }),
    ).toThrow();
  });

  it('rejects Node PNGs, mismatched extensions, guessed runtimes and excess binary bounds', () => {
    for (const args of [
      { script: '0', outputs: [png] },
      {
        language: 'python',
        script: '0',
        outputs: [{ ...png, path: 'chart.txt' }],
      },
      {
        language: 'python',
        script: '0',
        outputs: [{ ...png, fileName: 'chart.txt' }],
      },
      { language: 'python3', script: '0' },
      { language: 'python', script: '0', imageDigest: cloudPythonImageV1 },
      { language: 'python', script: '0', limits: { artifactBytes: 4000001 } },
    ])
      expect(() => CloudCommandInputSchema.parse(args)).toThrow();
  });
});
