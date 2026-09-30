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
import { connectorInputDigest, type McpStore } from '@allrice/database';

import { createPinnedMcpFetch } from './egress.js';
import { serializeMcpModelResult } from './result.js';
import {
  mcpRequestDiagnostics,
  mcpUnknownError,
  withMcpConnectionRetry,
} from './diagnostics.js';

/** A local schema rejection proves no tools/call was sent. */
export class McpInputValidationError extends McpError {
  constructor(detail: string) {
    super('MCP_INVALID_SCHEMA');
    this.message = `工具参数校验失败：${detail.slice(0, 2000)}。请按工具参数定义修正后重试。`;
  }
}

export function assertMcpInput(
  schema: Record<string, unknown>,
  argumentsInput: Record<string, unknown>,
) {
  // Reuse the MCP SDK's input validator. DSH's output-schema subset is not
  // suitable here: advertised MCP inputs also use maxLength, enum, etc.
  let validate;
  try {
    validate = new AjvJsonSchemaValidator().getValidator(schema);
  } catch {
    throw new McpError('MCP_INVALID_SCHEMA');
  }
  const result = validate(argumentsInput);
  if (!result.valid)
    throw new McpInputValidationError(result.errorMessage ?? '参数不符合定义');
}

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

export type McpConnectionInput = {
  endpoint: string;
  bearerToken: string | null;
  signal: AbortSignal;
  assertAuthorized: () => Promise<void>;
  oauth?: NonNullable<Awaited<ReturnType<McpStore['oauthSession']>>>;
};
export function redactMcpValue(
  value: unknown,
  secret: string | null,
  depth = 0,
): unknown {
  if (depth > 24) return '[TRUNCATED]';
  if (typeof value === 'string')
    return secret ? value.split(secret).join('[REDACTED]') : value;
  if (Array.isArray(value))
    return value.map((entry) => redactMcpValue(entry, secret, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        secret ? key.split(secret).join('[REDACTED]') : key,
        redactMcpValue(item, secret, depth + 1),
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
    input: McpConnectionInput,
    action: (client: Client) => Promise<T>,
  ) {
    const diagnostics = mcpRequestDiagnostics(
      dependencies.fetchOverride ?? createPinnedMcpFetch(input),
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(input.endpoint),
      {
        fetch: diagnostics.fetch,
        requestInit: {
          headers: input.bearerToken
            ? { authorization: `Bearer ${input.bearerToken}` }
            : {},
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
    } catch (error) {
      throw diagnostics.error(error);
    } finally {
      input.signal.removeEventListener('abort', stop);
      await client.close().catch(() => undefined);
    }
  }
  async function list(
    client: Client,
    signal: AbortSignal,
    secret: string | null,
  ) {
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
          redactMcpValue(
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
    async discover(input: McpConnectionInput) {
      try {
        return await withMcpConnectionRetry(input.signal, () =>
          withClient(input, (client) =>
            list(client, input.signal, input.bearerToken),
          ),
        );
      } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(
          input.signal.aborted ? 'MCP_CANCELED' : 'MCP_UNAVAILABLE',
        );
      }
    },
    async invoke(
      input: McpConnectionInput & {
        tool: FrozenMcpTool;
        arguments: Record<string, unknown>;
      },
    ) {
      if (Buffer.byteLength(JSON.stringify(input.arguments)) > 131_072)
        throw new McpError('MCP_LIMIT');
      assertMcpInput(input.tool.inputSchema, input.arguments);
      return withMcpConnectionRetry(input.signal, async () => {
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
            const safe = redactMcpValue(result, input.bearerToken) as Record<
              string,
              unknown
            >;
            return {
              isError: result.isError === true,
              modelContent: serializeMcpModelResult(safe),
              summary: result.isError ? 'MCP 工具返回错误' : 'MCP 工具执行完成',
              rawOutput: safe,
            };
          });
        } catch (error) {
          if (dispatched) throw mcpUnknownError(error);
          if (input.signal.aborted) throw new McpError('MCP_CANCELED');
          if (error instanceof McpError) throw error;
          // SDK errors can contain URLs, headers and server-controlled messages.
          throw new McpError('MCP_UNAVAILABLE');
        }
      });
    },
  };
}
