import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { connectorInputDigest } from '@allrice/database';
import type { FrozenMcpTool } from '@allrice/contracts';
import { createMcpTransport } from './transport.js';
import { createNativeMcpTransport } from './native-transport.js';
import { startMcpAcceptanceService } from './test-service.js';

for (const [label, create] of [
  ['sdk', createMcpTransport],
  ['dsh', createNativeMcpTransport],
] as const) {
  async function fixture() {
    const service = await startMcpAcceptanceService();
    const input = {
      endpoint: service.endpoint,
      bearerToken: service.state.token,
      signal: AbortSignal.timeout(15000),
      assertAuthorized: async () => {},
    };
    const tools = await create({
      fetchOverride: service.fetchOverride,
    }).discover(input);
    const item = tools.find(
      (t) => t.description === 'Append a synthetic record',
    )!;
    const tool: FrozenMcpTool = {
      ...item,
      connectionId: randomUUID(),
      connectionRevision: 1,
      toolRevisionId: randomUUID(),
      digest: connectorInputDigest(item),
      grantRevision: 1,
      risk: 'write',
      credentialReference: 'synthetic',
    };
    return { service, input, tool };
  }
  it.each(['initialize', 'tools/list'])(
    `${label} reconnects once on transient %s failure and dispatches the write once`,
    async (method) => {
      const f = await fixture();
      let failures = 0;
      try {
        const transport = create({
          fetchOverride: async (url, init) => {
            if (
              typeof init?.body === 'string' &&
              JSON.parse(init.body).method === method &&
              failures++ === 0
            )
              return new Response('server secret must not escape', {
                status: 503,
              });
            return f.service.fetchOverride(url, init);
          },
        });
        expect(
          (
            await transport.invoke({
              ...f.input,
              tool: f.tool,
              arguments: { value: 'once' },
            })
          ).isError,
        ).toBe(false);
        expect(failures).toBe(2);
        expect(f.service.state.calls).toBe(1);
        expect(f.service.state.rows).toEqual(['once']);
      } finally {
        await f.service.close();
      }
    },
  );
  it.each([401, 403, 429, 503])(
    `${label} retains safe HTTP %s diagnostics and limits connection attempts`,
    async (status) => {
      const f = await fixture();
      let attempts = 0;
      try {
        const transport = create({
          fetchOverride: async (url, init) => {
            if (
              typeof init?.body === 'string' &&
              JSON.parse(init.body).method === 'initialize'
            ) {
              attempts++;
              return new Response(f.service.state.token, { status });
            }
            return f.service.fetchOverride(url, init);
          },
        });
        const error = await transport
          .invoke({ ...f.input, tool: f.tool, arguments: { value: 'none' } })
          .catch((e: unknown) => e);
        expect(error).toMatchObject({
          diagnostic: {
            phase: 'initialize',
            reason: 'http_error',
            httpStatus: status,
            requestDispatched: false,
            connectionAttempts: [429, 503].includes(status) ? 2 : 1,
          },
        });
        expect(JSON.stringify(error)).not.toContain(f.service.state.token);
        expect(attempts).toBe([429, 503].includes(status) ? 2 : 1);
        expect(f.service.state.calls).toBe(0);
      } finally {
        await f.service.close();
      }
    },
  );
  it(`${label} does not replay tools/call on HTTP 503`, async () => {
    const f = await fixture();
    let calls = 0;
    try {
      const transport = create({
        fetchOverride: async (url, init) => {
          if (
            typeof init?.body === 'string' &&
            JSON.parse(init.body).method === 'tools/call'
          ) {
            calls++;
            return new Response('upstream failure', { status: 503 });
          }
          return f.service.fetchOverride(url, init);
        },
      });
      await expect(
        transport.invoke({
          ...f.input,
          tool: f.tool,
          arguments: { value: 'unknown' },
        }),
      ).rejects.toMatchObject({
        code: 'MCP_UNKNOWN',
        diagnostic: {
          requestDispatched: true,
          httpStatus: 503,
          connectionAttempts: 1,
        },
      });
      expect(calls).toBe(1);
    } finally {
      await f.service.close();
    }
  });
  it(`${label} honors long Retry-After without a premature reconnect`, async () => {
    const f = await fixture();
    let attempts = 0;
    try {
      const transport = create({
        fetchOverride: async () => {
          attempts++;
          return new Response('', {
            status: 429,
            headers: { 'retry-after': '60' },
          });
        },
      });
      await expect(
        transport.invoke({
          ...f.input,
          tool: f.tool,
          arguments: { value: 'none' },
        }),
      ).rejects.toMatchObject({
        diagnostic: { retryAfterMs: 60000, connectionAttempts: 1 },
      });
      expect(attempts).toBe(1);
    } finally {
      await f.service.close();
    }
  });
}

it('cancellation during reconnect does not become unknown effects or start a second connection', async () => {
  const { withMcpConnectionRetry, mcpNetworkError } =
    await import('./diagnostics.js');
  const controller = new AbortController();
  let attempts = 0;
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    await expect(
      withMcpConnectionRetry(controller.signal, async () => {
        attempts++;
        throw mcpNetworkError({ code: 'ECONNRESET' });
      }),
    ).rejects.toMatchObject({ code: 'MCP_CANCELED' });
    expect(attempts).toBe(1);
  } finally {
    clearTimeout(timer);
  }
});
