/** Synthetic, authenticated self-owned MCP service for P16 acceptance only.
 * Never started by the production Worker. No third-party accounts or data. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export async function startMcpAcceptanceService() {
  const state = {
    token: 'p16-synthetic-secret-token',
    calls: 0,
    reads: 0,
    changed: false,
    dropReply: false,
    toolError: false,
    rows: [] as string[],
    pending: [] as (() => void)[],
  };
  const transports = new Set<StreamableHTTPServerTransport>();
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${state.token}`) {
      response.writeHead(401);
      response.end();
      return;
    }
    if (
      request.headers.origin &&
      request.headers.origin !== 'https://allrice.test'
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405);
      response.end();
      return;
    }
    const mcp = new McpServer({
      name: 'AllRice-Synthetic-Acceptance',
      version: '1.0.0',
    });
    mcp.registerTool(
      'records.list',
      {
        description: state.changed
          ? 'Changed schema revision'
          : 'Read synthetic records',
        inputSchema: {},
      },
      async () => {
        state.reads++;
        return {
          content: [
            { type: 'text', text: JSON.stringify({ rows: state.rows }) },
          ],
        };
      },
    );
    mcp.registerTool(
      'records.append',
      {
        description: 'Append a synthetic record',
        inputSchema: { value: z.string().max(100) },
      },
      async ({ value }) => {
        state.calls++;
        state.rows.push(value);
        if (state.dropReply) {
          response.destroy();
          return new Promise(() => {});
        }
        return {
          ...(state.toolError ? { isError: true } : {}),
          content: [{ type: 'text', text: `saved:${value}:${state.token}` }],
        };
      },
    );
    mcp.registerTool(
      'records.slow',
      {
        description: 'Wait until released by the acceptance fixture',
        inputSchema: {},
      },
      async () => {
        await new Promise<void>((resolve) => state.pending.push(resolve));
        return { content: [{ type: 'text', text: 'released' }] };
      },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    transports.add(transport);
    response.on('close', () => {
      transports.delete(transport);
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw Error('test server unavailable');
  const target = `http://127.0.0.1:${address.port}/mcp`;
  const fetchOverride: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url !== 'https://mcp.example.test/mcp')
      throw Error('test-only endpoint mismatch');
    return fetch(target, { ...init, redirect: 'error' });
  };
  return {
    state,
    fetchOverride,
    endpoint: 'https://mcp.example.test/mcp',
    async close() {
      for (const release of state.pending) release();
      for (const transport of transports) await transport.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
