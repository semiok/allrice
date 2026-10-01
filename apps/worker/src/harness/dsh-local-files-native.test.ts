import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

const expected = {
  checksum: `sha256:${'a'.repeat(64)}`,
  sizeBytes: 123,
  version: `sha256:${'b'.repeat(64)}`,
  mediaType: 'application/pdf',
};
const path = '中文目录/原始 文件.pdf';
const objectId = randomUUID();

it.each([
  {
    action: 'inspect',
    args: { path },
    invalidArgs: { path: '../private.pdf' },
  },
  {
    action: 'import',
    args: { path, expected },
    invalidArgs: { path, expected, bytes: 'not an input' },
  },
  {
    action: 'save',
    args: { path, objectId, checksum: expected.checksum },
    invalidArgs: {
      path,
      objectId,
      checksum: expected.checksum,
      url: 'https://example.com/arbitrary.pdf',
    },
  },
  {
    action: 'open',
    args: { path, expected },
    invalidArgs: { path, expected: { ...expected, version: 'invented' } },
  },
  {
    action: 'reveal',
    args: { path, expected },
    invalidArgs: { path: '/private.pdf', expected },
  },
])(
  'registers local.file.$action in the real DSH loop and rejects unsafe inputs before the Broker',
  async ({ action, args, invalidArgs }) => {
    await nativeBrokerRoundtrip({
      canonicalName: `local.file.${action}`,
      wireName: `local_file_${action}`,
      args,
      invalidArgs,
      inspectSchema(schema) {
        const properties = schema.properties as Record<string, unknown>;
        expect(schema.required).toContain('path');
        for (const field of ['deviceId', 'grantId', 'bytes', 'url'])
          expect(properties).not.toHaveProperty(field);
        if (action === 'save')
          expect(schema.required).toEqual(
            expect.arrayContaining(['objectId', 'checksum']),
          );
        else if (action !== 'inspect')
          expect(schema.required).toContain('expected');
      },
      onToolCall: async (call) => {
        expect(call.arguments).toEqual(args);
        return {
          modelContent: JSON.stringify({
            status:
              action === 'inspect'
                ? 'inspected'
                : action === 'import'
                  ? 'uploaded'
                  : action === 'save'
                    ? 'saved'
                    : `${action}ed`,
            path,
            version: expected,
          }),
          summary: '合成原生文件回执',
        };
      },
    });
  },
  45_000,
);
