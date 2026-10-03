import { expect, it } from 'vitest';
import { RuntimeLocalCommandToolInputSchema } from '@allrice/contracts';
import { projectFixture } from '../../../rice-bridge/test/project-fixture.js';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

it.each(['pnpm', 'uv'] as const)(
  'exposes %s project preparation to the real DSH provider and forwards every field',
  async (manager) => {
    const args = RuntimeLocalCommandToolInputSchema.parse(
      Object.fromEntries(
        Object.entries(projectFixture(manager).command.arguments).filter(
          ([name]) => !['imageDigest', 'isolation', 'network'].includes(name),
        ),
      ),
    );
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
