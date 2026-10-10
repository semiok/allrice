/** Actual pinned DSH/JSON-RPC; loopback provider, no paid model or business claim. */
import { expect, it } from 'vitest';
import {
  RepairToolInputSchema,
  repairProductPath,
} from '@allrice/database/technical-contracts';
import { nativeBrokerRoundtrip } from '../harness/dsh-native-broker.fixture.js';
it.each([
  {
    label: 'existing file',
    before: 'synthetic before',
    after: 'synthetic after',
  },
  { label: 'creation transport', before: null, after: 'synthetic after' },
  { label: 'removal transport', before: 'synthetic before', after: null },
])(
  'the private repair $label reaches its actual model schema and rejects injected authority',
  async ({ before, after }) => {
    const args = {
      action: 'apply',
      expectedCandidate: 'sha256:' + 'a'.repeat(64),
      proposal: {
        files: [
          {
            path: repairProductPath,
            before,
            after,
          },
        ],
      },
    };
    await nativeBrokerRoundtrip({
      canonicalName: 'platform.repository.repair',
      wireName: 'platform_repository_repair',
      args,
      invalidArgs: { ...args, parentUid: 0 },
      expectedToolNames: [
        'platform_repository_repair',
        'ask_user_question',
        'skill',
        'todo_write',
      ],
      inspectSchema: (schema) => {
        expect(schema.properties).toMatchObject({
          proposal: {
            additionalProperties: false,
            properties: {
              files: {
                items: {
                  additionalProperties: false,
                  required: expect.arrayContaining(['path', 'before', 'after']),
                  properties: {
                    before: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                    after: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  },
                },
              },
            },
          },
        });
      },
      onToolCall: async (call) => {
        expect(RepairToolInputSchema.parse(call.arguments)).toEqual(args);
        return {
          modelContent: 'Synthetic private schema transport accepted.',
          summary: '合成参数往返',
        };
      },
    });
  },
  45000,
);
it('the tiny plain-Node schema agrees with the Broker on bounds, nullable changes and unsafe paths', async () => {
  const { repairNativeInputSchema } =
    // @ts-expect-error Plain-Node DSH declaration is intentionally outside the compiled Worker graph.
    await import('../../dsh/allrice-technical-native-tools.mjs');
  const call = (path: string) => ({
    action: 'apply',
    expectedCandidate: 'sha256:' + 'a'.repeat(64),
    proposal: { files: [{ path, before: null, after: null }] },
  });
  for (const raw of [
    { action: 'read' },
    { action: 'verify', candidateChecksum: 'sha256:' + 'b'.repeat(64) },
    ...[
      'a.ts',
      '../a',
      '/a',
      'a\\b',
      'a:b',
      'a\u0001',
      'a'.repeat(1025),
      '',
    ].map(call),
    { action: 'read', ownerId: 'fake' },
  ])
    expect(repairNativeInputSchema.safeParse(raw).success).toBe(
      RepairToolInputSchema.safeParse(raw).success,
    );
});
