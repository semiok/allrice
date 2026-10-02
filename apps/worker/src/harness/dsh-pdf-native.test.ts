import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

it('exposes PDF page selection through native DSH without changing the original arguments', async () => {
  const args = { objectId: randomUUID(), pages: [2], includeStructure: true };
  await nativeBrokerRoundtrip({
    canonicalName: 'workspace.document.read',
    wireName: 'workspace_document_read',
    args,
    invalidArgs: { ...args, pages: '2' },
    inspectSchema: (schema) => {
      expect(schema.properties).toMatchObject({
        pages: { type: 'array', items: { type: 'integer' } },
        includeStructure: { type: 'boolean' },
      });
      expect(schema.required).not.toContain('pages');
    },
    onToolCall: async (call) => {
      expect(call.arguments).toEqual(args);
      return {
        modelContent: JSON.stringify({
          kind: 'pdf',
          requestedPages: [2],
          source: { objectId: args.objectId },
        }),
        summary: '已读取指定 PDF 页',
      };
    },
  });
}, 45_000);
