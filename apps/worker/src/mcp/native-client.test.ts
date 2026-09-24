import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { apply } from '@deepseek-ai/dsh-mcp-client';
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { connectorInputDigest } from '@allrice/database';
import type { McpDiscoveredTool, FrozenMcpTool } from '@allrice/contracts';
import { createNativeMcpTransport } from './native-transport.js';
import { startMcpAcceptanceService } from './test-service.js';

it('reuses the published DSH client for anonymous discovery and real HTTP execution', async () => {
  const server = await startMcpAcceptanceService({ anonymous: true });
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await apply(ctx, {
      transport: 'streamable-http',
      serverName: 'app',
      url: server.target,
      headers: {},
      toolCallTimeoutMs: 10_000,
      failOnStartupError: true,
      reconnect: { enabled: false },
    });
    const tool = ctx.tools
      .schemas()
      .find((t) => t.description === 'Read synthetic records');
    expect(tool?.name).toMatch(/^mcp__app__records_list_/);
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('native-baseline'),
      name: tool!.name,
      arguments: {},
    });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: 'text', text: '{"rows":[]}' }]);
    expect(server.state.reads).toBe(1);
  } finally {
    await ctx.fiber.dispose();
    await server.close();
  }
});

const frozen = (tool: McpDiscoveredTool): FrozenMcpTool => ({
  ...tool,
  connectionId: randomUUID(),
  connectionRevision: 1,
  toolRevisionId: randomUUID(),
  digest: connectorInputDigest(tool),
  grantRevision: 1,
  risk: 'write',
  credentialReference: 'synthetic',
});
it.each([false, true])(
  'native adapter discovers and calls with anonymous=%s and rechecks authority',
  async (anonymous) => {
    const server = await startMcpAcceptanceService({ anonymous });
    try {
      const transport = createNativeMcpTransport({
        fetchOverride: server.fetchOverride,
      });
      let allowed = true;
      const input = {
        endpoint: server.endpoint,
        bearerToken: anonymous ? null : server.state.token,
        signal: AbortSignal.timeout(10_000),
        assertAuthorized: async () => {
          if (!allowed) throw Error('revoked');
        },
      };
      const tools = await transport.discover(input);
      const tool = frozen(
        tools.find((t) => t.description === 'Append a synthetic record')!,
      );
      const result = await transport.invoke({
        ...input,
        tool,
        arguments: { value: 'native' },
      });
      expect(result.isError).toBe(false);
      expect(result.modelContent).toContain('saved:native');
      if (!anonymous)
        expect(result.modelContent).not.toContain(server.state.token);
      expect(server.state.calls).toBe(1);
      allowed = false;
      await expect(
        transport.invoke({ ...input, tool, arguments: { value: 'revoked' } }),
      ).rejects.toBeDefined();
      expect(server.state.calls).toBe(1);
    } finally {
      await server.close();
    }
  },
);
it('does not retry lost native write replies and preserves authentication-required state', async () => {
  const server = await startMcpAcceptanceService();
  try {
    const transport = createNativeMcpTransport({
      fetchOverride: server.fetchOverride,
    });
    const input = {
      endpoint: server.endpoint,
      bearerToken: server.state.token,
      signal: AbortSignal.timeout(10_000),
      assertAuthorized: async () => {},
    };
    await expect(
      transport.discover({ ...input, bearerToken: null }),
    ).rejects.toMatchObject({ code: 'MCP_CREDENTIAL_UNAVAILABLE' });
    const tools = await transport.discover(input);
    server.state.dropReply = true;
    await expect(
      transport.invoke({
        ...input,
        tool: frozen(
          tools.find((t) => t.description === 'Append a synthetic record')!,
        ),
        arguments: { value: 'once' },
      }),
    ).rejects.toMatchObject({ code: 'MCP_UNKNOWN' });
    expect(server.state.calls).toBe(1);
  } finally {
    await server.close();
  }
});
