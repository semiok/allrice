import type { EmployeeMemoryPort } from '@allrice/database';
import {
  createAllriceMcpServer,
  type AllriceMcpScope,
  type AllriceMcpServices,
} from './allrice-server.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  identity: vi.fn(),
  read: vi.fn(),
  remember: vi.fn(),
}));
// Explicit identity/business contract fakes. The production adapter still
// imports the actual 271 reader and the public memory port, never these fakes.
vi.mock('../business-runtime/d-entry-current.ts', () => ({
  readDEntryBusinessIdentity: fixtures.identity,
}));
import { bindEmployeeMemoryMcpServices } from './employee-memory-services.ts';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const memoryModule = {
  kind: 'builtin' as const,
  moduleId: 'employee-memory' as const,
};
const scope: AllriceMcpScope = {
  personId: id(1),
  organizationId: id(2),
  workspaceId: id(3),
  employeeInstanceId: id(4),
  allriceThreadRef: id(5),
  nativeSessionRef: {
    instanceId: 'transport-instance',
    profileId: 'transport-profile',
    sessionId: 'transport-child',
  },
  executionGeneration: '4.0',
  enabledModules: ['employee-memory'],
  moduleConfigRevisionRef: 'current-transport-config',
  nativeCallRef: 'opaque-observed-request',
  requestContext: {
    actor: { type: 'user', id: id(1) },
    organizationId: id(2),
    workspaceId: id(3),
    requestId: id(6),
    sessionId: id(7),
    memberships: [],
    authenticatedAt: '2026-11-22T00:00:00Z',
  },
};
const target = {
  workspaceId: id(3),
  employeeInstanceId: id(4),
  threadId: id(5),
  nativeRequestRef: 'actual-host-request',
  module: memoryModule,
};
const port: Pick<EmployeeMemoryPort, 'readOrdinal' | 'remember'> = {
  readOrdinal: fixtures.read,
  remember: fixtures.remember,
};
const live = () => new AbortController().signal;
const sdkConnections: (() => Promise<void>)[] = [];
async function connectMemoryServices(services: AllriceMcpServices) {
  const controller = createAllriceMcpServer({
    host: {
      binding: {
        personId: scope.personId,
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        employeeInstanceId: scope.employeeInstanceId,
        allriceThreadRef: scope.allriceThreadRef,
        nativeSessionRef: scope.nativeSessionRef,
        executionGeneration: scope.executionGeneration,
      },
      current: async () => scope,
    },
    services,
  });
  const client = new Client({
    name: 'memory-adapter-contract-fixture',
    version: '1',
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  sdkConnections.push(async () => {
    await controller.close();
    await client.close();
  });
  await controller.server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
afterEach(async () => {
  for (const close of sdkConnections.splice(0).reverse()) await close();
});
beforeEach(() => {
  vi.resetAllMocks();
  fixtures.identity.mockResolvedValue({});
  fixtures.read.mockResolvedValue('complete already-metered detail');
  fixtures.remember.mockResolvedValue({
    id: id(8),
    revision: 1,
    pairDigest: 'sha256:internal',
    summary: '待确认候选',
    memoryClass: 'work_note',
    state: 'pending',
    requiresConfirmation: true,
    details: 'not disclosed',
  });
});
describe('formal MCP memory callbacks with explicit contracts', () => {
  it('composes the real SDK server and memory adapter before explicit identity/business contract fixtures', async () => {
    const actual = vi.fn().mockResolvedValue(target);
    const services = bindEmployeeMemoryMcpServices({
      port,
      targets: { actual },
    });
    const client = await connectMemoryServices(services);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'identity_read',
      'memory_read',
      'memory_remember',
    ]);
    expect(
      await client.callTool({ name: 'memory_read', arguments: { number: 1 } }),
    ).toMatchObject({
      content: [{ text: 'complete already-metered detail' }],
    });
    const result = await client.callTool({
      name: 'memory_remember',
      arguments: {
        summary: '  stable\npreference  ',
        details: 'complete condition',
      },
    });
    expect(result.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({
          id: id(8),
          summary: '待确认候选',
          memoryClass: 'work_note',
          state: 'pending',
          requiresConfirmation: true,
        }),
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('not disclosed');
    expect(JSON.stringify(result)).not.toContain('pairDigest');
    expect(actual).toHaveBeenCalledTimes(2);
    expect(fixtures.identity).toHaveBeenCalledTimes(2);
    expect(fixtures.identity).toHaveBeenLastCalledWith(
      scope.requestContext,
      { workspaceId: id(3), employeeInstanceId: id(4), threadId: id(5) },
      'execute',
      expect.any(AbortSignal),
    );
    expect(fixtures.read).toHaveBeenCalledExactlyOnceWith(
      scope.requestContext,
      target,
      { number: 1 },
      expect.any(AbortSignal),
    );
    expect(fixtures.remember).toHaveBeenCalledExactlyOnceWith(
      scope.requestContext,
      target,
      {
        summary: 'stable preference',
        details: 'complete condition',
        memoryClass: 'work_note',
      },
      expect.any(AbortSignal),
    );
  });
  it('keeps a missing real target producer closed over the actual SDK-to-adapter path', async () => {
    const client = await connectMemoryServices(
      bindEmployeeMemoryMcpServices({ port }),
    );
    await expect(
      client.callTool({
        name: 'memory_remember',
        arguments: { summary: 'fact' },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InternalError });
    expect(fixtures.identity).not.toHaveBeenCalled();
    expect(fixtures.remember).not.toHaveBeenCalled();
    expect(fixtures.read).not.toHaveBeenCalled();
  });
  it('keeps production target/B/call producer missing and refuses without invoking business or identity reads', async () => {
    const services = bindEmployeeMemoryMcpServices({ port });
    for (const operation of [
      () => services.memoryRead!(scope, { number: 1 }, live()),
      () => services.memoryRemember!(scope, { summary: '候选' }, live()),
    ])
      await expect(operation()).rejects.toMatchObject({
        code: 'business_runtime_dependency_unavailable',
        dependency: 'memory.native-target',
      });
    expect(fixtures.identity).not.toHaveBeenCalled();
    expect(fixtures.read).not.toHaveBeenCalled();
    expect(fixtures.remember).not.toHaveBeenCalled();
  });
  it('uses original authenticated scope and the actual execute identity reader before the business port', async () => {
    const actual = vi.fn().mockResolvedValue(target),
      services = bindEmployeeMemoryMcpServices({ port, targets: { actual } });
    const signal = live();
    expect(await services.memoryRead!(scope, { number: 1 }, signal)).toEqual({
      content: [{ type: 'text', text: 'complete already-metered detail' }],
    });
    expect(actual).toHaveBeenCalledWith(scope, signal);
    expect(fixtures.identity).toHaveBeenCalledWith(
      scope.requestContext,
      { workspaceId: id(3), employeeInstanceId: id(4), threadId: id(5) },
      'execute',
      signal,
    );
    expect(fixtures.read).toHaveBeenCalledWith(
      scope.requestContext,
      target,
      { number: 1 },
      signal,
    );
    const result = await services.memoryRemember!(
      scope,
      { summary: '候选' },
      signal,
    );
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            id: id(8),
            summary: '待确认候选',
            memoryClass: 'work_note',
            state: 'pending',
            requiresConfirmation: true,
          }),
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('details');
    expect(JSON.stringify(result)).not.toContain('pairDigest');
  });
  it.each([
    { workspaceId: id(9) },
    { employeeInstanceId: id(9) },
    { threadId: id(9) },
    { module: { ...memoryModule, moduleId: 'deliverables' } },
  ])(
    'rejects a host projection for a different memory target %j',
    async (changed) => {
      const services = bindEmployeeMemoryMcpServices({
        port,
        targets: {
          actual: vi.fn().mockResolvedValue({ ...target, ...changed }),
        },
      });
      await expect(
        services.memoryRead!(scope, { number: 1 }, live()),
      ).rejects.toMatchObject({
        code: 'business_runtime_authorization_denied',
      });
      expect(fixtures.identity).not.toHaveBeenCalled();
      expect(fixtures.read).not.toHaveBeenCalled();
    },
  );
  it('joins a signal-less identity promise before suppressing the late result', async () => {
    let done!: () => void;
    fixtures.identity.mockReturnValue(
      new Promise<void>((resolve) => {
        done = resolve;
      }),
    );
    const controller = new AbortController(),
      reason = Error('original native abort');
    const services = bindEmployeeMemoryMcpServices({
      port,
      targets: { actual: async () => target },
    });
    const operation = services.memoryRead!(
      scope,
      { number: 1 },
      controller.signal,
    );
    await vi.waitFor(() => expect(fixtures.identity).toHaveBeenCalledOnce());
    let settled = false;
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    controller.abort(reason);
    await Promise.resolve();
    expect(settled).toBe(false);
    done();
    await expect(operation).rejects.toBe(reason);
    expect(fixtures.read).not.toHaveBeenCalled();
  });
});
