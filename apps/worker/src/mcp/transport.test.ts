import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { connectorInputDigest } from '@allrice/database';
import type { McpDiscoveredTool, FrozenMcpTool } from '@allrice/contracts';

import { createMcpTransport, validateMcpSchema } from './transport.js';
import { createPinnedMcpFetch, validateMcpEndpoint } from './egress.js';
import { startMcpAcceptanceService } from './test-service.js';

const active: Awaited<ReturnType<typeof startMcpAcceptanceService>>[] = [];
afterEach(async () => {
  for (const service of active.splice(0)) await service.close();
});
async function fixture() {
  const service = await startMcpAcceptanceService();
  active.push(service);
  const transport = createMcpTransport({
    fetchOverride: service.fetchOverride,
  });
  const signal = AbortSignal.timeout(15_000);
  const input = {
    endpoint: service.endpoint,
    bearerToken: service.state.token,
    signal,
    assertAuthorized: async () => {},
  };
  return { service, transport, input };
}
const frozen = (tool: McpDiscoveredTool): FrozenMcpTool => ({
  ...tool,
  connectionId: randomUUID(),
  connectionRevision: 1,
  toolRevisionId: randomUUID(),
  digest: connectorInputDigest(tool),
  grantRevision: 1,
  risk: 'write',
  credentialReference: 'synthetic-reference',
});
describe('P16 actual self-owned MCP HTTP transport', () => {
  it('discovers authenticated tools then executes exactly once and removes credentials from returned data', async () => {
    const f = await fixture();
    const tools = await f.transport.discover(f.input);
    expect(tools.map((t) => t.name)).toEqual([
      'records.list',
      'records.append',
      'records.slow',
    ]);
    const result = await f.transport.invoke({
      ...f.input,
      tool: frozen(tools[1]!),
      arguments: { value: 'one' },
    });
    expect(f.service.state.calls).toBe(1);
    expect(result.modelContent).toContain('saved:one');
    expect(JSON.stringify(result)).not.toContain(f.service.state.token);
    expect(result.modelContent).toContain('[REDACTED]');
  });
  it('does not invoke a tool with arguments outside the discovered schema', async () => {
    const f = await fixture();
    const tools = await f.transport.discover(f.input);
    await expect(
      f.transport.invoke({
        ...f.input,
        tool: frozen(tools[1]!),
        arguments: {},
      }),
    ).rejects.toMatchObject({ code: 'MCP_INVALID_SCHEMA' });
    expect(f.service.state.calls).toBe(0);
  });
  it('rechecks remote schema and refuses a changed tool revision', async () => {
    const f = await fixture();
    const tools = await f.transport.discover(f.input);
    f.service.state.changed = true;
    await expect(
      f.transport.invoke({
        ...f.input,
        tool: frozen(tools[0]!),
        arguments: {},
      }),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
    expect(f.service.state.reads).toBe(0);
  });
  it('returns a bounded error without server details for invalid credentials', async () => {
    const f = await fixture();
    await expect(
      f.transport.discover({ ...f.input, bearerToken: 'incorrect-token' }),
    ).rejects.toBeDefined();
    expect(f.service.state.calls).toBe(0);
  });
  it('never retries a write whose reply is lost', async () => {
    const f = await fixture();
    const tools = await f.transport.discover(f.input);
    f.service.state.dropReply = true;
    await expect(
      f.transport.invoke({
        ...f.input,
        tool: frozen(tools[1]!),
        arguments: { value: 'only-once' },
      }),
    ).rejects.toMatchObject({ code: 'MCP_UNKNOWN' });
    expect(f.service.state.calls).toBe(1);
    expect(f.service.state.rows).toEqual(['only-once']);
  });
  it('does not claim that canceling an in-flight remote action stopped its effects', async () => {
    const f = await fixture();
    const tools = await f.transport.discover(f.input);
    const controller = new AbortController();
    const pending = f.transport.invoke({
      ...f.input,
      signal: controller.signal,
      tool: frozen(tools[2]!),
      arguments: {},
    });
    await expect.poll(() => f.service.state.pending.length).toBe(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'MCP_UNKNOWN' });
  });
  it.each([
    'https://127.0.0.1/mcp',
    'https://[::1]/mcp',
    'https://169.254.169.254/mcp',
    'https://198.18.0.20/mcp',
    'https://host.local/mcp',
    'http://example.com/mcp',
    'https://user:secret@example.com/mcp',
    'https://example.com:8080/mcp',
    'https://example.com/mcp?token=secret',
  ])('rejects production endpoint %s', (endpoint) => {
    expect(() => validateMcpEndpoint(endpoint)).toThrow();
  });
  it('does not allow redirect/fetch to any other endpoint', async () => {
    const request = createPinnedMcpFetch({
      endpoint: 'https://mcp.example.com/mcp',
      bearerToken: 'test-token',
      signal: new AbortController().signal,
      assertAuthorized: async () => {},
    });
    await expect(
      request('https://other.example.com/mcp'),
    ).rejects.toMatchObject({ code: 'MCP_SOURCE_DENIED' });
  });
  it('refuses remote refs and excessive schema depth before SDK compilation', () => {
    expect(() =>
      validateMcpSchema({
        type: 'object',
        properties: { secret: { $ref: 'https://example.com/schema' } },
      }),
    ).toThrow();
    let deep: Record<string, unknown> = { type: 'object' };
    for (let i = 0; i < 30; i++)
      deep = { type: 'object', properties: { deep } };
    expect(() => validateMcpSchema(deep)).toThrow();
  });
  it.each([
    'pattern',
    'patternProperties',
    'format',
    'dependentRequired',
    'unevaluatedProperties',
  ])(
    'rejects unsupported %s constraints rather than ignoring them',
    (keyword) => {
      expect(() =>
        validateMcpSchema({ type: 'object', [keyword]: { unexpected: true } }),
      ).toThrow();
    },
  );
});
