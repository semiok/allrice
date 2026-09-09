import { randomUUID } from 'node:crypto';
import { it } from 'vitest';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

it('P17 discovery uses native DSH with no caller-supplied command or tools catalog', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'local.mcp.discover',
    wireName: 'local_mcp_discover',
    args: { connectionId: randomUUID() },
    invalidArgs: { connectionId: randomUUID(), command: 'not-authorized' },
  });
}, 45000);

it('P17 calls preserve structured arguments and reject oversized input before Broker', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'local.mcp.call',
    wireName: 'local_mcp_call',
    args: {
      connectionId: randomUUID(),
      tool: 'records.list',
      arguments: { nested: { query: 'synthetic' } },
    },
    invalidArgs: {
      connectionId: randomUUID(),
      tool: 'records.list',
      arguments: { oversized: 'x'.repeat(8193) },
    },
  });
}, 45000);
