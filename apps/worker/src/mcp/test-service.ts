/** Synthetic, authenticated self-owned MCP service for P16 acceptance only.
 * Never started by the production Worker. No third-party accounts or data. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export async function startMcpAcceptanceService(
  options: { anonymous?: boolean; oauth?: boolean } = {},
) {
  const state = {
    token: 'p16-synthetic-secret-token',
    calls: 0,
    reads: 0,
    changed: false,
    dropReply: false,
    toolError: false,
    rows: [] as string[],
    pending: [] as (() => void)[],
    oauthEnabled: options.oauth ?? false,
    registrations: 0,
    exchanges: 0,
    refreshes: 0,
    challenge: '',
    redirectUri: '',
  };
  const transports = new Set<StreamableHTTPServerTransport>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'https://mcp.example.test');
    const json = (value: unknown) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(value));
    };
    if (
      state.oauthEnabled &&
      url.pathname.startsWith('/.well-known/oauth-protected-resource')
    ) {
      json({
        resource: 'https://mcp.example.test/mcp',
        authorization_servers: ['https://mcp.example.test'],
        scopes_supported: ['records'],
      });
      return;
    }
    if (
      state.oauthEnabled &&
      url.pathname === '/.well-known/oauth-authorization-server'
    ) {
      json({
        issuer: 'https://mcp.example.test',
        authorization_endpoint: 'https://mcp.example.test/authorize',
        token_endpoint: 'https://mcp.example.test/token',
        registration_endpoint: 'https://mcp.example.test/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
      return;
    }
    if (state.oauthEnabled && url.pathname === '/register') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const metadata = JSON.parse(Buffer.concat(chunks).toString());
      state.registrations++;
      state.redirectUri = metadata.redirect_uris[0];
      response.statusCode = 201;
      json({ ...metadata, client_id: 'allrice-fixture' });
      return;
    }
    if (state.oauthEnabled && url.pathname === '/authorize') {
      state.challenge = url.searchParams.get('code_challenge') ?? '';
      const callback = new URL(state.redirectUri);
      callback.searchParams.set('code', 'synthetic-authorization-code');
      callback.searchParams.set('state', url.searchParams.get('state') ?? '');
      response.writeHead(302, { location: callback.href });
      response.end();
      return;
    }
    if (state.oauthEnabled && url.pathname === '/token') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      if (body.get('grant_type') === 'authorization_code') {
        if (
          body.get('code') !== 'synthetic-authorization-code' ||
          createHash('sha256')
            .update(body.get('code_verifier') ?? '')
            .digest('base64url') !== state.challenge
        ) {
          response.statusCode = 400;
          json({ error: 'invalid_grant' });
          return;
        }
        state.exchanges++;
      } else if (
        body.get('grant_type') === 'refresh_token' &&
        body.get('refresh_token') === 'synthetic-refresh-token'
      )
        state.refreshes++;
      else {
        response.statusCode = 400;
        json({ error: 'invalid_grant' });
        return;
      }
      state.token = `synthetic-oauth-access-${state.exchanges}-${state.refreshes}`;
      json({
        access_token: state.token,
        token_type: 'Bearer',
        refresh_token: 'synthetic-refresh-token',
        expires_in: 3600,
      });
      return;
    }
    if (
      !options.anonymous &&
      request.headers.authorization !== `Bearer ${state.token}`
    ) {
      if (state.oauthEnabled)
        response.setHeader(
          'www-authenticate',
          'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
        );
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
    if (
      url !== 'https://mcp.example.test/mcp' &&
      !(
        state.oauthEnabled && new URL(url).origin === 'https://mcp.example.test'
      )
    )
      throw Error('test-only endpoint mismatch');
    const mapped = new URL(url);
    const local = new URL(target);
    mapped.protocol = local.protocol;
    mapped.host = local.host;
    return fetch(mapped, { ...init, redirect: init?.redirect ?? 'error' });
  };
  return {
    state,
    target,
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
