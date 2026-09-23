import { runtimeFeatureEnabled } from '@allrice/contracts';
import { createMcpStore, type McpStore } from '@allrice/database';
import {
  McpError,
  type FrozenMcpTool,
  type McpScope,
} from '@allrice/contracts';

import { createMcpTransport } from './transport.js';

export async function executeNextMcpDiscovery(input: {
  workerId: string;
  signal: AbortSignal;
  store?: McpStore;
  transport?: ReturnType<typeof createMcpTransport>;
}) {
  if (!runtimeFeatureEnabled('ALLRICE_CLOUD_MCP_ENABLED')) return false;
  const store = input.store ?? createMcpStore();
  const lease = await store.claimDiscovery(input.workerId);
  if (!lease) return false;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(45_000)]);
  try {
    const bearerToken = await store.discoveryCredential(lease);
    const tools = await (input.transport ?? createMcpTransport()).discover({
      endpoint: lease.endpoint,
      bearerToken,
      signal,
      assertAuthorized: async () => {
        await store.discoveryCredential(lease);
      },
    });
    await store.completeDiscovery(lease, { tools });
  } catch {
    await store
      .completeDiscovery(lease, { errorCode: 'MCP_DISCOVERY_FAILED' })
      .catch(() => undefined);
  }
  return true;
}

/** The caller MUST first obtain a runtime operation lease using the dedicated
 * MCP admission adapter and exact input digest. No public HTTP call route uses
 * this function directly; it is an execution adapter, not an approval bypass. */
export async function invokeFrozenMcpTool(input: {
  scope: McpScope;
  tool: FrozenMcpTool;
  arguments: Record<string, unknown>;
  signal: AbortSignal;
  assertOperationLease: () => Promise<void>;
  store?: McpStore;
  transport?: ReturnType<typeof createMcpTransport>;
}) {
  if (!runtimeFeatureEnabled('ALLRICE_CLOUD_MCP_ENABLED'))
    throw new McpError('MCP_UNAVAILABLE');
  const store = input.store ?? createMcpStore();
  const assertAuthorized = async () => {
    await input.assertOperationLease();
    await store.assertAuthorized(input.scope, input.tool);
  };
  await assertAuthorized();
  const { endpoint } = await store.assertAuthorized(input.scope, input.tool);
  const bearerToken = await store.executionCredential(input.scope, input.tool);
  return (input.transport ?? createMcpTransport()).invoke({
    endpoint,
    bearerToken,
    tool: input.tool,
    arguments: input.arguments,
    signal: input.signal,
    assertAuthorized,
  });
}
