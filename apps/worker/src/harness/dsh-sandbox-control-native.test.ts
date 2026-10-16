import { expect, it } from 'vitest';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

const checksum = 'sha256:' + 'a'.repeat(64);
const execution = { version: 1, kind: 'compute' };
const network = {
  mode: 'controlled_https',
  origins: ['https://pypi.org'],
};
const limits = {
  timeoutMs: 60000,
  outputBytes: 16384,
  memoryMiB: 256,
  cpuMillis: 1000,
  pids: 64,
};
const command = {
  executable: '/usr/local/bin/node',
  args: ['verify.cjs'],
  path: '.',
  limits,
  execution,
  network,
};
const projectId = 'db0bbe7d-1e71-4d27-89e2-fb09559d4b3f';

it.each([
  {
    canonicalName: 'local.process.execute',
    wireName: 'local_process_execute',
    args: { ...command, files: [{ path: 'verify.cjs', sha256: checksum }] },
    invalid: {
      network: { mode: 'controlled_https', origins: ['http://127.0.0.1'] },
    },
  },
  {
    canonicalName: 'python.execute',
    wireName: 'python_execute',
    args: {
      script: 'print("synthetic")',
      location: 'local',
      execution,
      network,
    },
    invalid: { execution: { ...execution, maxExecutionMs: 3600000 } },
  },
  {
    canonicalName: 'workspace.project',
    wireName: 'workspace_project',
    args: {
      ...command,
      action: 'execute',
      project: {
        projectId,
        snapshot: {
          kind: 'artifact',
          id: '6b829c99-d472-4cf2-8f46-12447361735d',
          checksum,
        },
      },
      projectPreparation: {
        version: 1,
        projectId,
        sourceDigest: checksum,
        lockChecksum: checksum,
        offline: true,
        manager: 'pnpm',
        managerVersion: '10.33.3',
        lockPath: 'pnpm-lock.yaml',
        scripts: 'disabled',
        packages: [],
      },
    },
    invalid: { execution: { version: 1, kind: 'unlimited' } },
  },
])(
  '$canonicalName exposes optional sandbox controls to the actual provider and preserves their exact values',
  async ({ canonicalName, wireName, args, invalid }) => {
    await nativeBrokerRoundtrip({
      canonicalName,
      wireName,
      args,
      invalidArgs: { ...args, ...invalid },
      inspectSchema(schema) {
        const properties = schema.properties as Record<string, unknown>;
        expect(properties.execution).toMatchObject({
          type: 'object',
          additionalProperties: false,
          properties: {
            version: { enum: [1] },
            kind: { enum: ['compute', 'install', 'build'] },
          },
        });
        expect(properties.network).toMatchObject({
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { enum: ['controlled_https'] },
            origins: { type: 'array', items: { type: 'string' } },
          },
        });
        expect(schema.required ?? []).not.toContain('execution');
        expect(schema.required ?? []).not.toContain('network');
        expect(properties).not.toHaveProperty('executionBudget');
        expect(properties).not.toHaveProperty('networkGrant');
      },
      onToolCall: async (call) => {
        expect(call.arguments).toEqual(args);
        return {
          modelContent: 'Synthetic transport only.',
          summary: '原生参数接线',
        };
      },
    });
  },
  45000,
);
