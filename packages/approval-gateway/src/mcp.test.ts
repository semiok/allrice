import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createApprovalMcpServer } from './mcp.js';
import { fixture } from './testing.fixture.js';
import type { ApprovalView } from './contract.js';

describe('native MCP approval tool boundary', () => {
  it('uses an authenticated host call binding and never exports human decision tools', async () => {
    const f = fixture();
    const calls: (string | number)[] = [];
    const { server } = createApprovalMcpServer({
      enabled: true,
      gateway: f.gateway,
      async resolveCall(requestId) {
        calls.push(requestId);
        return f.binding;
      },
    });
    const client = new Client({ name: 'test-native-client', version: '1' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
        'outbound.stage',
        'outbound.execute',
        'outbound.status',
      ]);
      const staged = await client.callTool({
        name: 'outbound.stage',
        arguments: f.input,
      });
      const view = staged.structuredContent as unknown as ApprovalView;
      expect(view.decision).toBe('pending');
      const denied = await client.callTool({
        name: 'outbound.execute',
        arguments: view.ref,
      });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toEqual({ code: 'NOT_CONFIRMED' });
      expect(f.dispatches).toBe(0);
      const forged = await client.callTool({
        name: 'outbound.stage',
        arguments: { ...f.input, approved: true },
      });
      expect(forged.isError).toBe(true);
      const hidden = await client.callTool({
        name: 'outbound.decide',
        arguments: { ...view.ref, decision: 'approved' },
      });
      expect(hidden.isError).toBe(true);
      await f.gateway.decide(
        f.context,
        { ...view.ref, decision: 'approved' },
        new AbortController().signal,
      );
      const executed = await client.callTool({
        name: 'outbound.execute',
        arguments: view.ref,
      });
      expect(
        (executed.structuredContent as unknown as ApprovalView).effect,
      ).toBe('received');
      const status = await client.callTool({
        name: 'outbound.status',
        arguments: view.ref,
      });
      expect(status.structuredContent).toEqual(executed.structuredContent);
      expect(f.dispatches).toBe(1);
      expect(calls).toHaveLength(4);
      expect(new Set(calls).size).toBe(4);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

it('uses native list_changed and disabled handles when the host turns the capability off', async () => {
  const f = fixture();
  const { server, setEnabled } = createApprovalMcpServer({
    enabled: false,
    gateway: f.gateway,
    resolveCall: async () => f.binding,
  });
  const client = new Client({ name: 'catalog-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    expect((await client.listTools()).tools).toHaveLength(0);
    const { ToolListChangedNotificationSchema } =
      await import('@modelcontextprotocol/sdk/types.js');
    let notify!: () => void;
    let changed = new Promise<void>((resolve) => {
      notify = resolve;
    });
    client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        notify();
      },
    );
    setEnabled(true);
    await changed;
    expect((await client.listTools()).tools).toHaveLength(3);
    changed = new Promise<void>((resolve) => {
      notify = resolve;
    });
    f.setPermitted(false);
    setEnabled(false);
    await changed;
    expect((await client.listTools()).tools).toHaveLength(0);
    expect(
      (await client.callTool({ name: 'outbound.stage', arguments: f.input }))
        .isError,
    ).toBe(true);
    expect(f.dispatches).toBe(0);
  } finally {
    await client.close();
    await server.close();
  }
});
