import { cloudPlatform } from './cloud-platform.ts';
import { describe, expect, it } from 'vitest';
import { PythonExecuteArgsSchema } from '../python-execution.ts';
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
  it('rejects sibling revisions of one parent before local or cloud Python executes', () => {
    const parent = '706bf4d8-785f-41dc-829e-b38197b61642';
    for (const schema of [CloudCommandInputSchema, PythonExecuteArgsSchema]) {
      for (const repeated of [parent, parent.toUpperCase()]) {
        const result = schema.safeParse({
          language: 'python',
          script: 'print(1)',
          outputs: [
            {
              path: 'a.csv',
              fileName: 'a.csv',
              format: 'csv',
              parentObjectId: parent,
            },
            {
              path: 'b.csv',
              fileName: 'b.csv',
              format: 'csv',
              parentObjectId: repeated,
            },
          ],
        });
        expect(result.success).toBe(false);
        if (!result.success)
          expect(result.error.issues).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                message: 'duplicate cloud output parent',
              }),
            ]),
          );
      }
    }
  });
  it('accepts optional parent identity without changing historical output bytes or accepting caller-chosen versions', () => {
    const parentObjectId = '706bf4d8-785f-41dc-829e-b38197b61642';
    for (const output of [
      { path: 'result.csv', fileName: 'result.csv', format: 'csv' },
      { path: 'result.json', fileName: 'result.json', format: 'json' },
      { path: 'result.txt', fileName: 'result.txt', format: 'txt' },
    ]) {
      const raw = {
        ...node,
        arguments: { ...node.arguments, outputs: [output] },
      };
      expect(JSON.stringify(CloudCommandSchema.parse(raw))).toBe(
        JSON.stringify(raw),
      );
      expect(
        CloudCommandInputSchema.parse({
          script: '0',
          outputs: [{ ...output, parentObjectId }],
        }).outputs[0],
      ).toEqual({ ...output, parentObjectId });
      for (const extra of [
        { parentObjectId: 'latest' },
        { seriesId: parentObjectId },
        { parentVersionId: parentObjectId },
        { version: 2 },
      ]) {
        expect(
          CloudCommandInputSchema.safeParse({
            script: '0',
            outputs: [{ ...output, ...extra }],
          }).success,
        ).toBe(false);
      }
    }
  });

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
        architecture: cloudPlatform.architecture,
        runtime: 'runsc',
        runtimeVersion: 'release-20260831.0',
        runtimeChecksum: cloudPlatform.runtimeChecksum,
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
