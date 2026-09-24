import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { apply } from '@deepseek-ai/dsh-mcp-client';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  McpDiscoveredToolSchema,
  McpError,
  type FrozenMcpTool,
} from '@allrice/contracts';
import { connectorInputDigest } from '@allrice/database';
import { createPinnedMcpFetch } from './egress.js';
import { redactMcpValue, type McpConnectionInput } from './transport.js';
import { managedMcpOAuthProvider } from './oauth.js';

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
    const boundedFetch: typeof fetch = async (url, init) => {
      input.signal.throwIfAborted();
      await input.assertAuthorized();
      const response = await request(url, {
        ...init,
        signal: AbortSignal.any([
          input.signal,
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
      if (response.status === 401) {
        networkError = new McpError('MCP_CREDENTIAL_UNAVAILABLE');
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
      void ctx.fiber.dispose();
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
      await apply(ctx, {
        transport: 'streamable-http',
        serverName: 'app',
        url: input.endpoint,
        headers: input.bearerToken
          ? { authorization: `Bearer ${input.bearerToken}` }
          : {},
        fetch: boundedFetch,
        ...(provider ? { authProvider: provider } : {}),
        toolCallTimeoutMs: 30_000,
        failOnStartupError: true,
        reconnect: { enabled: false },
      });
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
      throw networkError ?? error;
    } finally {
      input.signal.removeEventListener('abort', stop);
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
        return await withClient(input, async (_ctx, tools) => tools);
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
      // Native MCP passes the advertised input schema through unchanged and
      // the server validates its arguments. The DSH output-schema subset is
      // not an MCP input validator (e.g. it intentionally rejects maxLength).
      if (Buffer.byteLength(JSON.stringify(input.arguments)) > 131_072)
        throw new McpError('MCP_LIMIT');
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
            modelContent: raw.slice(0, 20_000),
            summary: result.isError ? '应用返回错误' : '应用执行完成',
            rawOutput: safe,
          };
        });
      } catch (error) {
        if (dispatched) throw new McpError('MCP_UNKNOWN');
        if (error instanceof McpError) throw error;
        throw new McpError(
          input.signal.aborted ? 'MCP_CANCELED' : 'MCP_UNAVAILABLE',
        );
      }
    },
  };
}
