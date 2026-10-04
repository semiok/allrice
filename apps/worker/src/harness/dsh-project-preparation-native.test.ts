import { expect, it } from 'vitest';
import { RuntimeLocalCommandToolInputSchema } from '@allrice/contracts';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

it.each(['pnpm', 'uv'] as const)(
  'exposes %s project preparation to the real DSH provider and forwards every field',
  async (manager) => {
    // Synthetic transport values only. Native installation/cache evidence is
    // separate; this test must not import the Bridge app into Worker builds.
    const checksum = `sha256:${'a'.repeat(64)}`;
    const args = RuntimeLocalCommandToolInputSchema.parse({
      executable:
        manager === 'pnpm'
          ? '/usr/local/bin/node'
          : '/workspace/.venv/bin/python',
      args: [manager === 'pnpm' ? 'verify.cjs' : 'verify.py'],
      path: '.',
      files: [
        {
          path: manager === 'pnpm' ? 'pnpm-lock.yaml' : 'requirements.lock',
          sha256: checksum,
        },
      ],
      limits: {
        timeoutMs: 60000,
        outputBytes: 16384,
        memoryMiB: 512,
        cpuMillis: 1000,
        pids: 64,
      },
      projectPreparation: {
        version: 1,
        projectId: '713d721f-f0bf-40dd-aa0b-65f6aa79e49a',
        sourceDigest: checksum,
        lockChecksum: checksum,
        offline: false,
        manager,
        managerVersion: manager === 'pnpm' ? '10.33.3' : '0.8.22',
        lockPath: manager === 'pnpm' ? 'pnpm-lock.yaml' : 'requirements.lock',
        scripts: 'disabled',
        packages:
          manager === 'pnpm'
            ? [
                {
                  name: 'allrice-native-schema',
                  version: '1.0.0',
                  integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
                  archivePath: 'package.tgz',
                },
              ]
            : [
                {
                  name: 'allrice_native_schema',
                  version: '1.0.0',
                  fileName: 'allrice_native_schema-1.0.0-py3-none-any.whl',
                  url: 'https://files.pythonhosted.org/packages/schema/allrice_native_schema-1.0.0-py3-none-any.whl',
                  sha256: checksum,
                },
              ],
      },
    });
    await nativeBrokerRoundtrip({
      canonicalName: 'local.process.execute',
      wireName: 'local_process_execute',
      args,
      invalidArgs: {
        ...args,
        projectPreparation: { ...args.projectPreparation, sourceDigest: false },
      },
      inspectSchema(schema) {
        const properties = schema.properties as Record<
          string,
          Record<string, unknown>
        >;
        const preparation = properties.projectPreparation!;
        expect(preparation.required).toEqual(
          expect.arrayContaining([
            'version',
            'projectId',
            'sourceDigest',
            'lockChecksum',
            'offline',
            'manager',
            'managerVersion',
            'lockPath',
            'scripts',
            'packages',
          ]),
        );
        const fields = preparation.properties as Record<string, unknown>;
        expect(fields).not.toHaveProperty('ownerId');
        expect(fields).not.toHaveProperty('organizationId');
        expect(fields).not.toHaveProperty('runtimeImage');
        const packages = fields.packages as {
          items: { properties: Record<string, unknown> };
        };
        expect(packages.items.properties).toHaveProperty(
          manager === 'pnpm' ? 'integrity' : 'sha256',
        );
      },
      onToolCall: async (call) => {
        expect(
          RuntimeLocalCommandToolInputSchema.parse(call.arguments),
        ).toEqual(args);
        return {
          modelContent: 'Synthetic preparation transport accepted.',
          summary: '合成原生接线验证',
        };
      },
    });
  },
  45_000,
);

it('forwards an exact saved project to the real DSH provider without requiring a host manifest or exposing internal inputs', async () => {
  const checksum = `sha256:${'a'.repeat(64)}`,
    projectId = '713d721f-f0bf-40dd-aa0b-65f6aa79e49a';
  const args = RuntimeLocalCommandToolInputSchema.parse({
    executable: '/usr/local/bin/node',
    args: ['main.cjs'],
    path: '.',
    project: {
      projectId,
      snapshot: {
        kind: 'deliverable_version',
        id: '713d721f-f0bf-40dd-aa0b-65f6aa79e49b',
        checksum,
        objectId: '713d721f-f0bf-40dd-aa0b-65f6aa79e49c',
        seriesId: '713d721f-f0bf-40dd-aa0b-65f6aa79e49d',
        version: 2,
      },
    },
    limits: {
      timeoutMs: 10000,
      outputBytes: 16384,
      memoryMiB: 256,
      cpuMillis: 1000,
      pids: 64,
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
  });
  await nativeBrokerRoundtrip({
    canonicalName: 'local.process.execute',
    wireName: 'local_process_execute',
    args,
    invalidArgs: { ...args, files: [] },
    inspectSchema(schema) {
      expect(schema.required).not.toContain('files');
      expect(schema.properties).toHaveProperty('project');
      expect(schema.properties).not.toHaveProperty('projectSource');
      expect(schema.properties).not.toHaveProperty('outputs');
      expect(schema.properties).not.toHaveProperty('architecture');
    },
    onToolCall: async (call) => {
      expect(RuntimeLocalCommandToolInputSchema.parse(call.arguments)).toEqual(
        args,
      );
      return {
        modelContent: 'Synthetic exact source transport only.',
        summary: '合成原生接线验证',
      };
    },
  });
}, 45000);
