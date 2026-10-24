import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

it('P16 MCP uses the pinned native DSH tool channel and rejects invalid connection arguments before Broker', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'cloud.mcp.call',
    wireName: 'cloud_mcp_call',
    args: {
      connectionId: randomUUID(),
      tool: 'records.list',
      arguments: { nested: { query: 'synthetic' } },
    },
    invalidArgs: {
      connectionId: 'not-a-uuid',
      tool: 'records.list',
      arguments: {},
    },
  });
}, 45000);

it('continues the same native request after provider errors without replaying the completed MCP tool', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'cloud.mcp.call',
    wireName: 'cloud_mcp_call',
    args: { connectionId: randomUUID(), tool: 'records.list', arguments: {} },
    invalidArgs: {
      connectionId: 'invalid',
      tool: 'records.list',
      arguments: {},
    },
    retryAfterTool: 2,
  });
}, 45000);

it('advertises exact schema lookup and transports it through the native broker without accepting call arguments', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'cloud.mcp.call',
    wireName: 'cloud_mcp_call',
    args: {
      action: 'describe',
      connectionId: randomUUID(),
      tool: 'records.list',
    },
    invalidArgs: {
      action: 'describe',
      connectionId: randomUUID(),
      tool: 'records.list',
      arguments: { private: true },
    },
    inspectSchema: (schema) =>
      expect(JSON.stringify(schema)).toContain('describe'),
  });
}, 45000);
