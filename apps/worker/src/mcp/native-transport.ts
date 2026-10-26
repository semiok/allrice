import { createHash } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client';
import {
  Client,
  StreamableHTTPClientTransport,
  auth,
} from '@modelcontextprotocol/client';
import {
  McpDiscoveredToolSchema,
  McpError,
  type FrozenMcpTool,
} from '@allrice/contracts';
import { connectorInputDigest } from '@allrice/database';
import { createPinnedMcpFetch } from './egress.js';
import {
  assertMcpInput,
  redactMcpValue,
  type McpConnectionInput,
} from './transport.js';
import { managedMcpOAuthProvider } from './oauth.js';
import { serializeMcpModelResult } from './result.js';
import {
  mcpRequestDiagnostics,
  mcpUnknownError,
  withMcpConnectionRetry,
} from './diagnostics.js';

/** Allrice owns identity, network admission and the operation ledger. DSH owns
 * discovery, names, schemas, tool execution and result materialization. Each
 * lease gets a fresh native registry; no reconnect may replay remote effects. */
export function createNativeMcpTransport(
  dependencies: { fetchOverride?: typeof fetch } = {},
) {
  async function withClient<T>(
    input: McpConnectionInput,
    action: (
      ctx: Context,
      tools: ReturnType<typeof catalog>,
      received: () => boolean,
    ) => Promise<T>,
  ) {
    const ctx = new Context();
    const client = new Client(
      { name: 'allrice-managed-mcp', version: '1' },
      { capabilities: {} },
    );
    let callReplyReceived = false;
    let networkError: unknown;
    const provider = input.oauth
      ? managedMcpOAuthProvider(input.oauth)
      : undefined;
    const request: typeof fetch =
      dependencies.fetchOverride ??
      (async (url, init) => {
        const endpoint =
          typeof url === 'string'
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        return createPinnedMcpFetch({
          ...input,
          endpoint: provider ? endpoint : input.endpoint,
          ...(provider ? { oauthNetwork: true } : {}),
        })(url, init);
      });
    const diagnostics = mcpRequestDiagnostics(request);
    const boundedFetch: typeof fetch = async (url, init) => {
      input.signal.throwIfAborted();
      await input.assertAuthorized();
      if (input.oauth?.data.preset === 'github') {
        const target = new URL(
          typeof url === 'string'
            ? url
            : url instanceof URL
              ? url.href
              : url.url,
        );
        if (
          target.href !== 'https://github.com/login/oauth/access_token' &&
          target.origin !== 'https://api.githubcopilot.com'
        )
          throw new McpError('MCP_DENIED');
      }
      const response = await diagnostics.fetch(url, {
        ...init,
        signal: AbortSignal.any([
          input.signal,
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
      if (response.status === 401) {
        networkError = diagnostics.error(
          new McpError('MCP_CREDENTIAL_UNAVAILABLE'),
        );
        if (!provider) throw networkError;
      }
      // Only a fully received call response can distinguish a reported remote
      // error from an unknown effect. Cloning preserves native SDK parsing.
      if (
        typeof init?.body === 'string' &&
        init.body.startsWith('{') &&
        JSON.parse(init.body).method === 'tools/call'
      ) {
        const body = await response.clone().text();
        if (body.length > 1_048_576) throw new McpError('MCP_LIMIT');
        callReplyReceived =
          response.ok &&
          (body.includes('"result"') || body.includes('"error"'));
      }
      return response;
    };
    const stop = () => {
      void client.close().catch(() => {});
      void ctx.fiber.dispose().catch(() => {});
    };
    input.signal.addEventListener('abort', stop, { once: true });
    try {
      input.signal.throwIfAborted();
      await ctx.plugin(SystemPrompt);
      await ctx.plugin(ToolRuntime);
      if (provider && input.oauth?.data.authorizationCode) {
        await auth(provider, {
          serverUrl: input.endpoint,
          authorizationCode: input.oauth.data.authorizationCode,
          fetchFn: boundedFetch,
        });
      }
      const transport = new StreamableHTTPClientTransport(
        new URL(input.endpoint),
        {
          requestInit: {
            headers: input.bearerToken
              ? { authorization: `Bearer ${input.bearerToken}` }
              : {},
          },
          fetch: boundedFetch,
          ...(provider ? { authProvider: provider } : {}),
          reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 1000,
            maxReconnectionDelay: 1000,
            reconnectionDelayGrowFactor: 1,
          },
        },
      );
      await client.connect(transport, {
        signal: input.signal,
        timeout: 30_000,
      });
      // SDK owns pagination and the advertised schemas. AllRice owns the
      // frozen public identity, admission and transport lifecycle. The DSH
      // exported adapter still owns result validation/materialization.
      const response =
        client.getServerCapabilities()?.tools === undefined
          ? { tools: [] }
          : await client.listTools(undefined, {
              cacheMode: 'refresh',
              signal: input.signal,
              timeout: 30_000,
            });
      if (response.tools.length > 128) throw new McpError('MCP_LIMIT');
      const names = new Set<string>();
      for (const tool of response.tools) {
        const identity = `app\0${tool.name}`;
        const joined = `mcp__app__${tool.name}`;
        const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_');
        const name =
          normalized === joined && joined.length <= 64
            ? joined
            : normalized.slice(0, 51) +
              '_' +
              createHash('sha256').update(identity).digest('hex').slice(0, 12);
        if (names.has(name)) throw new McpError('MCP_DENIED');
        names.add(name);
        ctx.tools.register(
          createMcpToolDefinition(ctx, {
            name,
            rawName: tool.name,
            description: tool.description ?? '',
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            taskRequired: tool.execution?.taskSupport === 'required',
            call: (args, execution) =>
              client.callTool(
                { name: tool.name, arguments: args },
                {
                  signal: execution.signal,
                  timeout: 30_000,
                  toolDefinition: tool,
                },
              ),
          }),
        );
      }
      networkError = undefined;
      return await action(
        ctx,
        catalog(
          ctx,
          (await provider?.tokens())?.access_token ?? input.bearerToken,
        ),
        () => callReplyReceived,
      );
    } catch (error) {
      throw networkError ?? diagnostics.error(error);
    } finally {
      input.signal.removeEventListener('abort', stop);
      await client.close().catch(() => {});
      await ctx.fiber.dispose();
    }
  }
  function catalog(ctx: Context, secret: string | null) {
    return McpDiscoveredToolSchema.array()
      .max(128)
      .parse(
        ctx.tools.schemas().map((tool) =>
          redactMcpValue(
            {
              name: tool.name,
              description: tool.description ?? '',
              inputSchema: tool.parameters,
              outputSchema: ctx.tools.get(tool.name)?.output.schema ?? null,
            },
            secret,
          ),
        ),
      );
  }
  return {
    async discover(input: McpConnectionInput) {
      try {
        return await withMcpConnectionRetry(
          input.signal,
          () => withClient(input, async (_ctx, tools) => tools),
          !input.oauth?.data.authorizationCode,
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
      return withMcpConnectionRetry(
        input.signal,
        async () => {
          let dispatched = false;
          try {
            return await withClient(input, async (ctx, tools, received) => {
              const live = tools.find((t) => t.name === input.tool.name);
              if (!live || connectorInputDigest(live) !== input.tool.digest)
                throw new McpError('MCP_DENIED');
              await input.assertAuthorized();
              input.signal.throwIfAborted();
              dispatched = true;
              const result = await ctx.tools.execute({
                signal: input.signal,
                callId: ToolCallId('managed-mcp'),
                name: live.name,
                arguments: input.arguments,
              });
              if (!received()) throw new McpError('MCP_UNKNOWN');
              const safe = redactMcpValue(
                result,
                typeof input.oauth?.data.tokens?.access_token === 'string'
                  ? input.oauth.data.tokens.access_token
                  : input.bearerToken,
              ) as Record<string, unknown>;
              const raw = JSON.stringify(safe);
              if (Buffer.byteLength(raw) > 1_048_576)
                throw new McpError('MCP_LIMIT');
              return {
                isError: result.isError,
                modelContent: serializeMcpModelResult(safe),
                summary: result.isError ? '应用返回错误' : '应用执行完成',
                rawOutput: safe,
              };
            });
          } catch (error) {
            if (dispatched) throw mcpUnknownError(error);
            if (error instanceof McpError) throw error;
            throw new McpError(
              input.signal.aborted ? 'MCP_CANCELED' : 'MCP_UNAVAILABLE',
            );
          }
        },
        !input.oauth?.data.authorizationCode,
      );
    },
  };
}
