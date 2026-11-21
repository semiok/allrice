import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { ReferenceSelectionErrorSchema } from '@allrice/contracts';
import {
  createAllriceMcpServer,
  type AllriceMcpBinding,
  type AllriceMcpScope,
  type AllriceMcpServices,
} from './allrice-server.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pin = {
  sourceId: id(8),
  revisionId: id(9),
  digest: `sha256:${'a'.repeat(64)}`,
  checksum: `sha256:${'b'.repeat(64)}`,
};
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function fixture() {
  const binding: AllriceMcpBinding = {
    personId: id(1),
    organizationId: id(2),
    workspaceId: id(3),
    employeeInstanceId: id(4),
    allriceThreadRef: id(5),
    executionGeneration: '4.0',
    nativeSessionRef: {
      instanceId: 'dsh-instance',
      profileId: 'employee-profile',
      sessionId: 'native-session',
    },
  };
  const scope: AllriceMcpScope = {
    ...structuredClone(binding),
    requestContext: {
      requestId: id(6),
      sessionId: id(7),
      actor: { type: 'user', id: id(1) },
      organizationId: id(2),
      workspaceId: id(3),
      memberships: [],
      authenticatedAt: new Date().toISOString(),
    },
    enabledModules: ['enterprise-materials', 'employee-memory', 'deliverables'],
    moduleConfigRevisionRef: 'host-config-revision-1',
    nativeCallRef: 'host-native-call',
  };
  const result = () => ({
    content: [{ type: 'text' as const, text: 'actual module result' }],
  });
  const services: AllriceMcpServices = {
    executionGeneration: '4.0',
    referenceRead: vi.fn(async () => result()),
    memoryRead: vi.fn(async () => result()),
    deliverableCreate: vi.fn(async () => result()),
  };
  return {
    binding,
    scope,
    services,
    host: { binding, current: vi.fn(async () => scope) },
  };
}
const opened: (() => Promise<void>)[] = [];
async function connect(options: Parameters<typeof createAllriceMcpServer>[0]) {
  const controller = createAllriceMcpServer(options);
  const client = new Client({ name: 'managed-gateway-fixture', version: '1' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await controller.server.connect(serverTransport);
  await client.connect(clientTransport);
  opened.push(async () => {
    await controller.close();
    await client.close();
  });
  return { client, controller };
}
afterEach(async () => {
  for (const close of opened.splice(0).reverse()) await close();
});

describe('AllRice native SDK MCP managed boundary (contract fixtures, no production gateway)', () => {
  it('discovers raw names and passes only business arguments with host identity and the native signal', async () => {
    const f = fixture();
    const { client } = await connect(f);
    const catalog = await client.listTools();
    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      'identity_read',
      'reference_read',
      'memory_read',
      'deliverable_create',
    ]);
    expect(
      catalog.tools.find((tool) => tool.name === 'reference_read')!.inputSchema
        .required,
    ).toEqual(['sourceId', 'revisionId', 'digest', 'checksum']);
    await expect(
      client.callTool({ name: 'reference_read', arguments: pin }),
    ).resolves.toMatchObject({ content: [{ text: 'actual module result' }] });
    const [scope, args, signal] = vi.mocked(f.services.referenceRead!).mock
      .calls[0]!;
    expect(scope.personId).toBe(f.binding.personId);
    expect(args).toMatchObject({ ...pin, offset: 0 });
    expect(signal).toBeInstanceOf(AbortSignal);
    const identity = await client.callTool({
      name: 'identity_read',
      arguments: {},
    });
    expect(
      JSON.parse((identity.content as { text: string }[])[0]!.text),
    ).toEqual({
      personId: id(1),
      organizationId: id(2),
      workspaceId: id(3),
      employeeInstanceId: id(4),
    });
  });

  it('has no business tools without carriers and rejects a 3.x adapter declaration on a 4.0 binding', async () => {
    const f = fixture();
    const unavailable = await connect({ host: f.host });
    expect(
      (await unavailable.client.listTools()).tools.map((tool) => tool.name),
    ).toEqual(['identity_read']);
    const legacy = { ...f.services, executionGeneration: '3.x' as const };
    const { client } = await connect({ host: f.host, services: legacy });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'identity_read',
    ]);
    expect(
      await client.callTool({ name: 'memory_read', arguments: { number: 1 } }),
    ).toMatchObject({ isError: true });
    expect(legacy.memoryRead).not.toHaveBeenCalled();
    const unbound = await connect({});
    expect((await unbound.client.listTools()).tools).toEqual([]);
    await expect(
      unbound.client.callTool({ name: 'identity_read', arguments: {} }),
    ).rejects.toThrow('Managed binding unavailable');
  });

  it.each([
    'personId',
    'organizationId',
    'workspaceId',
    'employeeInstanceId',
    'allriceThreadRef',
    'executionGeneration',
    'native-instance',
    'native-profile',
    'native-session',
  ])('refuses a host route mismatch: %s', async (field) => {
    const f = fixture();
    const { client } = await connect(f);
    if (field.startsWith('native-')) {
      const key =
        field === 'native-instance'
          ? 'instanceId'
          : field === 'native-profile'
            ? 'profileId'
            : 'sessionId';
      f.scope.nativeSessionRef[key] = 'different';
    } else if (field === 'executionGeneration')
      f.scope.executionGeneration = '3.x';
    else Object.assign(f.scope, { [field]: id(100) });
    await expect(
      client.callTool({ name: 'reference_read', arguments: pin }),
    ).rejects.toThrow('Managed binding unavailable');
    expect(f.services.referenceRead).not.toHaveBeenCalled();
  });

  it.each([
    'tenantId',
    'personId',
    'employeeInstanceId',
    'worker',
    'approved',
    'nativeCallRef',
    'quality',
    'trustedOfficeExport',
  ])(
    'rejects guest authority field %s in every business input',
    async (field) => {
      const f = fixture();
      const { client } = await connect(f);
      for (const [name, input] of [
        ['reference_read', pin],
        ['memory_read', { number: 1 }],
        [
          'deliverable_create',
          { fileName: 'report.txt', format: 'text', content: 'bytes' },
        ],
      ] as const)
        await expect(
          client.callTool({
            name,
            arguments: { ...input, [field]: 'guest value' },
          }),
        ).rejects.toThrow(/Invalid/);
      expect(f.services.referenceRead).not.toHaveBeenCalled();
      expect(f.services.memoryRead).not.toHaveBeenCalled();
      expect(f.services.deliverableCreate).not.toHaveBeenCalled();
    },
  );

  it('publishes native list_changed and rejects a stale catalog after revocation', async () => {
    const f = fixture();
    const { client, controller } = await connect(f);
    await client.listTools();
    const notified = gate();
    client.setNotificationHandler(ToolListChangedNotificationSchema, () =>
      notified.resolve(),
    );
    f.scope.enabledModules = [];
    await controller.notifyCatalogChanged();
    await notified.promise;
    expect(
      await client.callTool({ name: 'reference_read', arguments: pin }),
    ).toMatchObject({ isError: true });
    expect(f.services.referenceRead).not.toHaveBeenCalled();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'identity_read',
    ]);
  });

  it.each(['revocation', 'call reassociation', 'config revision'])(
    'withholds completed data after %s',
    async (change) => {
      const f = fixture();
      const started = gate(),
        finish = gate();
      f.services.referenceRead = vi.fn(async () => {
        started.resolve();
        await finish.promise;
        return { content: [{ type: 'text', text: 'sensitive result' }] };
      });
      const { client } = await connect(f);
      const pending = client.callTool({
        name: 'reference_read',
        arguments: pin,
      });
      await started.promise;
      if (change === 'revocation') f.scope.enabledModules = [];
      else if (change === 'call reassociation')
        f.scope.nativeCallRef = 'different-native-call';
      else f.scope.moduleConfigRevisionRef = 'revision-2';
      finish.resolve();
      const result = await pending;
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).not.toContain('sensitive result');
    },
  );

  it('propagates native cancellation and waits for actual uninterruptible work to converge', async () => {
    const f = fixture();
    const started = gate(),
      cancelled = gate(),
      finish = gate();
    let converged = false;
    f.services.memoryRead = vi.fn(async (_scope, _input, signal) => {
      signal.addEventListener('abort', () => cancelled.resolve(), {
        once: true,
      });
      started.resolve();
      try {
        await finish.promise;
        return { content: [{ type: 'text', text: 'withheld detail' }] };
      } finally {
        converged = true;
      }
    });
    const { client, controller } = await connect(f);
    const abort = new AbortController();
    const pending = client.callTool(
      { name: 'memory_read', arguments: { number: 1 } },
      undefined,
      { signal: abort.signal },
    );
    const rejection = expect(pending).rejects.toThrow();
    await started.promise;
    abort.abort();
    await rejection;
    await cancelled.promise;
    let idle = false;
    const waiting = controller.whenIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    expect(converged).toBe(false);
    finish.resolve();
    await waiting;
    expect(converged).toBe(true);
    expect(f.services.memoryRead).toHaveBeenCalledTimes(1);
  });

  it('close aborts and drains a committed write without retrying or reporting a rollback', async () => {
    const f = fixture();
    const started = gate(),
      aborted = gate(),
      finish = gate();
    let committed = 0;
    f.services.deliverableCreate = vi.fn(async (_scope, _input, signal) => {
      committed++;
      signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      started.resolve();
      await finish.promise;
      return { content: [{ type: 'text', text: 'committed version' }] };
    });
    const { client, controller } = await connect(f);
    const pending = client
      .callTool({
        name: 'deliverable_create',
        arguments: { fileName: 'report', format: 'text', content: 'bytes' },
      })
      .catch(() => undefined);
    await started.promise;
    let closed = false;
    const close = controller.close().then(() => {
      closed = true;
    });
    await aborted.promise;
    expect(closed).toBe(false);
    expect(committed).toBe(1);
    finish.resolve();
    await close;
    await pending;
    expect(committed).toBe(1);
    expect(f.services.deliverableCreate).toHaveBeenCalledTimes(1);
  });

  it('preserves native isError and named selection errors without leaking unexpected failures', async () => {
    const f = fixture();
    const { client } = await connect(f);
    f.services.referenceRead = async () => ({
      isError: true,
      content: [{ type: 'text', text: 'original module refusal' }],
    });
    expect(
      await client.callTool({ name: 'reference_read', arguments: pin }),
    ).toMatchObject({
      isError: true,
      content: [{ text: 'original module refusal' }],
    });
    const selection = ReferenceSelectionErrorSchema.parse({
      error: {
        code: 'REFERENCE_SELECTION_UNAVAILABLE',
        message: '文件可能被调整权限或移除',
        requestId: id(6),
        retryable: false,
        referenceRevisionIds: [pin.revisionId],
      },
    });
    f.services.referenceRead = async () => {
      throw selection;
    };
    expect(
      JSON.parse(
        (
          (await client.callTool({ name: 'reference_read', arguments: pin }))
            .content as { text: string }[]
        )[0]!.text,
      ),
    ).toEqual(selection);
    f.services.referenceRead = async () => {
      throw { error: { ...selection.error, referenceRevisionIds: [id(101)] } };
    };
    await expect(
      client.callTool({ name: 'reference_read', arguments: pin }),
    ).rejects.toThrow('Invalid module selection error');
    f.services.referenceRead = async () => {
      throw new Error('secret-sentinel SQL credentials');
    };
    await expect(
      client.callTool({ name: 'reference_read', arguments: pin }),
    ).rejects.toThrow('AllRice business service failed');
  });

  it('withholds unexpected host errors and refuses an unassociated native call', async () => {
    const f = fixture();
    const { client } = await connect(f);
    f.scope.nativeCallRef = null;
    await expect(
      client.callTool({ name: 'memory_read', arguments: { number: 1 } }),
    ).rejects.toThrow('Managed binding unavailable');
    f.host.current.mockRejectedValueOnce(
      new Error('secret-sentinel connection SQL'),
    );
    await expect(client.listTools()).rejects.toThrow(
      'Managed binding unavailable',
    );
    expect(f.services.memoryRead).not.toHaveBeenCalled();
  });

  it('fails closed on an incomplete host native-session binding', async () => {
    const f = fixture();
    f.binding.nativeSessionRef.profileId = '';
    const { client } = await connect(f);
    await expect(client.listTools()).rejects.toThrow(
      'Managed binding unavailable',
    );
    expect(f.services.memoryRead).not.toHaveBeenCalled();
  });

  it('a transport disconnect aborts active work and still drains its real completion', async () => {
    const f = fixture();
    const started = gate(),
      aborted = gate(),
      finish = gate();
    f.services.memoryRead = async (_scope, _input, signal) => {
      signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      started.resolve();
      await finish.promise;
      return { content: [{ type: 'text', text: 'withheld detail' }] };
    };
    const { client, controller } = await connect(f);
    const pending = client
      .callTool({ name: 'memory_read', arguments: { number: 1 } })
      .catch(() => undefined);
    await started.promise;
    await client.close();
    await aborted.promise;
    let idle = false;
    const waiting = controller.whenIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    finish.resolve();
    await waiting;
    await pending;
  });

  it('does not imply rollback when access changes after publication returned', async () => {
    const f = fixture();
    const { client } = await connect(f);
    f.services.deliverableCreate = async () => {
      f.scope.moduleConfigRevisionRef = 'revoked-after-commit';
      return {
        content: [{ type: 'text', text: 'persisted receipt withheld' }],
      };
    };
    const result = await client.callTool({
      name: 'deliverable_create',
      arguments: { fileName: 'report', format: 'text', content: 'bytes' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('may already be committed');
    expect(JSON.stringify(result)).not.toContain('persisted receipt withheld');
  });
});
