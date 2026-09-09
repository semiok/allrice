import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import {
  McpDiscoveredToolSchema,
  McpError,
  assertMcpSchemaSubset,
  type McpDiscoveredTool,
  type FrozenMcpTool,
} from '@allrice/contracts';
import { connectorInputDigest } from '@allrice/database';

import { createPinnedMcpFetch } from './egress.js';

export function validateMcpSchema<T = unknown>(
  schema: Record<string, unknown>,
) {
  assertMcpSchemaSubset(schema);
  try {
    return new AjvJsonSchemaValidator().getValidator<T>(schema);
  } catch {
    throw new McpError('MCP_INVALID_SCHEMA');
  }
}

type ConnectionInput = {
  endpoint: string;
  bearerToken: string;
  signal: AbortSignal;
  assertAuthorized: () => Promise<void>;
};
function redact(value: unknown, secret: string, depth = 0): unknown {
  if (depth > 24) return '[TRUNCATED]';
  if (typeof value === 'string') return value.split(secret).join('[REDACTED]');
  if (Array.isArray(value))
    return value.map((entry) => redact(entry, secret, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.split(secret).join('[REDACTED]'),
        redact(item, secret, depth + 1),
      ]),
    );
  return value;
}
/** fetchOverride is dependency injection for isolated transport tests only.
 * Production composition never accepts it from configuration/API/environment. */
export function createMcpTransport(
  dependencies: { fetchOverride?: typeof fetch } = {},
) {
  async function withClient<T>(
    input: ConnectionInput,
    action: (client: Client) => Promise<T>,
  ) {
    const transport = new StreamableHTTPClientTransport(
      new URL(input.endpoint),
      {
        fetch: dependencies.fetchOverride ?? createPinnedMcpFetch(input),
        requestInit: {
          headers: { authorization: `Bearer ${input.bearerToken}` },
        },
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 1000,
          reconnectionDelayGrowFactor: 1,
        },
      },
    );
    const client = new Client(
      { name: 'AllRice-Cloud-MCP', version: '0.1.0' },
      {
        capabilities: {},
        // SDK listTools precompiles output schemas before returning results.
        // Its default validator must not bypass our reviewed schema subset.
        jsonSchemaValidator: {
          getValidator<T>(schema: Record<string, unknown>) {
            return validateMcpSchema<T>(schema as Record<string, unknown>);
          },
        },
      },
    );
    const stop = () => {
      void client.close().catch(() => undefined);
    };
    input.signal.addEventListener('abort', stop, { once: true });
    try {
      input.signal.throwIfAborted();
      await input.assertAuthorized();
      await client.connect(transport, {
        timeout: 10_000,
        signal: input.signal,
      });
      if (transport.protocolVersion !== '2025-11-25')
        throw new McpError('MCP_UNAVAILABLE');
      return await action(client);
    } finally {
      input.signal.removeEventListener('abort', stop);
      await client.close().catch(() => undefined);
    }
  }
  async function list(client: Client, signal: AbortSignal, secret: string) {
    const tools: McpDiscoveredTool[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 8; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, {
        timeout: 10_000,
        signal,
      });
      for (const tool of result.tools) {
        const parsed = McpDiscoveredToolSchema.parse(
          redact(
            {
              name: tool.name,
              description: tool.description ?? '',
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema ?? null,
            },
            secret,
          ),
        );
        validateMcpSchema(parsed.inputSchema);
        if (parsed.outputSchema) validateMcpSchema(parsed.outputSchema);
        if (seen.has(parsed.name) || tools.length >= 128)
          throw new McpError('MCP_LIMIT');
        seen.add(parsed.name);
        tools.push(parsed);
      }
      if (!result.nextCursor) return tools;
      if (result.nextCursor === cursor) throw new McpError('MCP_LIMIT');
      cursor = result.nextCursor;
    }
    throw new McpError('MCP_LIMIT');
  }
  return {
    async discover(input: ConnectionInput) {
      try {
        return await withClient(input, (client) =>
          list(client, input.signal, input.bearerToken),
        );
      } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(
          input.signal.aborted ? 'MCP_CANCELED' : 'MCP_UNAVAILABLE',
        );
      }
    },
    async invoke(
      input: ConnectionInput & {
        tool: FrozenMcpTool;
        arguments: Record<string, unknown>;
      },
    ) {
      if (!validateMcpSchema(input.tool.inputSchema)(input.arguments).valid)
        throw new McpError('MCP_INVALID_SCHEMA');
      if (Buffer.byteLength(JSON.stringify(input.arguments)) > 131_072)
        throw new McpError('MCP_LIMIT');
      let dispatched = false;
      try {
        return await withClient(input, async (client) => {
          const live = (
            await list(client, input.signal, input.bearerToken)
          ).find((tool) => tool.name === input.tool.name);
          if (!live || connectorInputDigest(live) !== input.tool.digest)
            throw new McpError('MCP_DENIED');
          await input.assertAuthorized();
          input.signal.throwIfAborted();
          // Once sent, loss of reply is not evidence that the remote tool did
          // nothing. Never retry here; the operation ledger must record unknown.
          dispatched = true;
          const result = await client.callTool(
            { name: input.tool.name, arguments: input.arguments },
            undefined,
            { timeout: 30_000, signal: input.signal },
          );
          const raw = JSON.stringify(result);
          if (Buffer.byteLength(raw) > 1_048_576)
            throw new McpError('MCP_LIMIT');
          const safe = redact(result, input.bearerToken) as Record<
            string,
            unknown
          >;
          const redacted = JSON.stringify(safe);
          return {
            isError: result.isError === true,
            modelContent: redacted.slice(0, 20_000),
            summary: result.isError ? 'MCP 工具返回错误' : 'MCP 工具执行完成',
            rawOutput: safe,
          };
        });
      } catch (error) {
        if (dispatched) throw new McpError('MCP_UNKNOWN');
        if (input.signal.aborted) throw new McpError('MCP_CANCELED');
        if (error instanceof McpError) throw error;
        // SDK errors can contain URLs, headers and server-controlled messages.
        throw new McpError('MCP_UNAVAILABLE');
      }
    },
  };
}
