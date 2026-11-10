import { expect, it } from 'vitest';
import { renderMemoryDetailV2, renderMemoryIndexV2 } from '@allrice/contracts';
import { randomUUID } from 'node:crypto';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';
import { boundToolResult } from '../tool-broker/result-budget.js';
import type { RiceToolExecutionInput } from '../tool-broker/types.js';
import {
  riceReadOnlyToolDefinitionsForPreview,
  riceToolDefinitionsForCapabilities,
} from '../tool-broker/definitions.js';

it('keeps a complete escaped memory text through real JSON-RPC, native render and provider decoding', async () => {
  const content = renderMemoryDetailV2(100, {
    summary: '月结报告',
    details: '\u0001'.repeat(1995) + '不得外发。',
  });
  await nativeBrokerRoundtrip({
    run: {
      id: randomUUID(),
      documents: {
        schemaVersion: 2,
        user: '',
        memory: renderMemoryIndexV2([
          { summary: '月结报告', hasDetails: true },
        ]),
      },
    },
    canonicalName: 'workspace.memory.read',
    wireName: 'workspace_memory_read',
    args: { number: 100 },
    invalidArgs: { number: 100, ownerId: 'must-not-be-authority' },
    expectedToolNames: ['workspace_memory_read'],
    forbiddenToolNames: [
      'workspace_memory_search',
      'workspace_experience_read',
      'workspace_memory_remember',
    ],
    inspectSchema(schema) {
      expect(Object.keys(schema.properties as object)).toEqual(['number']);
      expect(schema.required).toEqual(['number']);
      expect(schema.additionalProperties).toBe(false);
    },
    onToolCall: async () =>
      boundToolResult(
        { call: { name: 'workspace.memory.read' } } as RiceToolExecutionInput,
        { modelContent: content, summary: 'one complete entry', itemCount: 1 },
      ),
    inspectRequests(requests) {
      expect(JSON.stringify(requests[0]!.messages)).toContain(
        'MEMORY_INDEX_V2',
      );
      expect(JSON.stringify(requests[0]!.messages)).not.toContain(
        JSON.stringify('\u0001'.repeat(1995)).slice(1, -1),
      );
      const messages = requests[1]!.messages as {
        role: string;
        content: unknown;
      }[];
      const message = messages.find((entry) => entry.role === 'tool')!;
      const actual =
        typeof message.content === 'string'
          ? message.content
          : (message.content as { type: string; text?: string }[])
              .map((part) => part.text ?? '')
              .join('');
      expect(actual).toBe(content);
      expect(Buffer.byteLength(actual)).toBe(Buffer.byteLength(content));
      expect(actual).not.toContain('fullResult');
      expect(actual).not.toContain('"details":');
    },
  });
}, 45000);

it('does not expose ordinal reads through broad capabilities, undefined old allowlists or preview', () => {
  expect(
    riceToolDefinitionsForCapabilities(['storage:read']).some(
      (tool) => tool.name === 'workspace.memory.read',
    ),
  ).toBe(false);
  expect(
    riceToolDefinitionsForCapabilities(
      ['storage:read'],
      ['workspace.file.read'],
    ).some((tool) => tool.name === 'workspace.memory.read'),
  ).toBe(false);
  expect(
    riceToolDefinitionsForCapabilities(
      ['storage:read'],
      ['workspace.memory.read'],
    ).map((tool) => tool.name),
  ).toEqual(['workspace.memory.read']);
  expect(
    riceReadOnlyToolDefinitionsForPreview(
      ['storage:read'],
      ['workspace.memory.read'],
    ),
  ).toEqual([]);
});
