import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ErrorCode,
  McpError,
  ToolListChangedNotificationSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ApiErrorSchema,
  ReferenceSelectionErrorSchema,
} from '@allrice/contracts';
import { riceToolDefinitions } from '../tool-broker/definitions.js';
import {
  ALLRICE_MCP_CONTRACT_VERSION,
  createAllriceMcpServer,
  type AllriceMcpBinding,
  type AllriceMcpScope,
  type AllriceMcpServices,
  type AllriceMcpMemoryRead,
  type AllriceMcpServerPort,
  type AllriceMcpReferenceSearch,
  type AllriceMcpReferenceReadImage,
  type AllriceMcpReferenceArchiveList,
  type AllriceMcpReferenceArchiveRead,
  type AllriceMcpDeliverableDocumentRead,
  type AllriceMcpMemoryRemember,
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

const extensionCases = [
  {
    name: 'reference_search',
    method: 'referenceSearch',
    input: { query: '  handbook  ' },
    expected: { query: 'handbook', category: 'all', limit: 3 },
  },
  {
    name: 'reference_read_image',
    method: 'referenceReadImage',
    input: pin,
    expected: pin,
  },
  {
    name: 'reference_archive_list',
    method: 'referenceArchiveList',
    input: pin,
    expected: { ...pin, limit: 50 },
  },
  {
    name: 'reference_archive_read',
    method: 'referenceArchiveRead',
    input: { ...pin, entryId: `entry:sha256:${'c'.repeat(64)}`, as: 'text' },
    expected: {
      ...pin,
      entryId: `entry:sha256:${'c'.repeat(64)}`,
      as: 'text',
      offset: 0,
      limit: 4000,
    },
  },
  {
    name: 'deliverable_document_read',
    method: 'deliverableDocumentRead',
    input: { objectId: id(30) },
    expected: { objectId: id(30) },
  },
  {
    name: 'memory_remember',
    method: 'memoryRemember',
    input: { summary: '  human\npreference  ' },
    expected: {
      summary: 'human preference',
      details: null,
      memoryClass: 'work_note',
    },
  },
] as const;

function extensionFixture() {
  const f = fixture();
  const result = async (): Promise<CallToolResult> => ({
    content: [{ type: 'text', text: 'protocol fixture, no business carrier' }],
  });
  return {
    ...f,
    services: {
      ...f.services,
      referenceSearch: vi.fn<AllriceMcpReferenceSearch>(result),
      referenceReadImage: vi.fn<AllriceMcpReferenceReadImage>(result),
      referenceArchiveList: vi.fn<AllriceMcpReferenceArchiveList>(result),
      referenceArchiveRead: vi.fn<AllriceMcpReferenceArchiveRead>(result),
      deliverableDocumentRead: vi.fn<AllriceMcpDeliverableDocumentRead>(result),
      memoryRemember: vi.fn<AllriceMcpMemoryRemember>(result),
    },
  };
}

describe('AllRice M2 six optional native SDK callbacks (protocol fixtures only)', () => {
  it.each(extensionCases)(
    'lists and dispatches $name with its exact input semantics',
    async ({ name, method, input, expected }) => {
      const f = extensionFixture();
      const { client } = await connect(f);
      const catalog = (await client.listTools()).tools;
      expect(catalog.map((item) => item.name)).not.toContain(
        'deliverable_read',
      );
      const tool = catalog.find((item) => item.name === name)!;
      expect(tool.inputSchema.additionalProperties).toBe(false);
      if (name === 'memory_remember') {
        expect(tool.inputSchema).toEqual(
          JSON.parse(
            JSON.stringify(
              riceToolDefinitions.find(
                (item) => item.name === 'workspace.memory.remember',
              )!.inputSchema,
            ),
          ),
        );
        expect(tool.annotations?.readOnlyHint).not.toBe(true);
      } else expect(tool.annotations?.readOnlyHint).toBe(true);
      await expect(
        client.callTool({ name, arguments: input }),
      ).resolves.toMatchObject({
        content: [{ text: 'protocol fixture, no business carrier' }],
      });
      const callback = f.services[method];
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0]).toEqual([
        f.scope,
        expected,
        expect.any(AbortSignal),
      ]);
      expect(f.services.deliverableCreate).not.toHaveBeenCalled();
      for (const other of extensionCases)
        if (other.method !== method)
          expect(f.services[other.method]).not.toHaveBeenCalled();
    },
  );

  it.each(extensionCases)(
    'does not list or call unbound $name',
    async ({ name, input }) => {
      const f = fixture();
      const { client } = await connect(f);
      expect(
        (await client.listTools()).tools.map((tool) => tool.name),
      ).not.toContain(name);
      expect(await client.callTool({ name, arguments: input })).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining('DEPENDENCY_UNAVAILABLE') }],
      });
      expect(f.services.deliverableCreate).not.toHaveBeenCalled();
    },
  );

  it.each(['module disabled', 'wrong generation'])(
    'refuses all extensions with %s',
    async (reason) => {
      const f = extensionFixture();
      if (reason === 'module disabled') f.scope.enabledModules = [];
      const services = {
        ...f.services,
        executionGeneration:
          reason === 'wrong generation' ? ('3.x' as const) : ('4.0' as const),
      };
      const { client } = await connect({ host: f.host, services });
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        ['identity_read'],
      );
      for (const { name, method, input } of extensionCases) {
        expect(await client.callTool({ name, arguments: input })).toMatchObject(
          { isError: true },
        );
        expect(f.services[method]).not.toHaveBeenCalled();
      }
    },
  );

  it.each(extensionCases)(
    'rejects guest authority in $name before dispatch',
    async ({ name, method, input }) => {
      const f = extensionFixture();
      const { client } = await connect(f);
      for (const field of [
        'personId',
        'tenantId',
        'employeeInstanceId',
        'worker',
        'approved',
        'nativeCallRef',
      ])
        await expect(
          client.callTool({
            name,
            arguments: { ...input, [field]: 'guest authority' },
          }),
        ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      expect(f.services[method]).not.toHaveBeenCalled();
    },
  );

  it('keeps memory limits/source exclusion, archive continuation and document omission semantics', async () => {
    const f = extensionFixture();
    const { client } = await connect(f);
    for (const args of [
      {},
      { summary: 'a'.repeat(41) },
      { summary: 'fact', details: 'a'.repeat(2001) },
      { summary: 'fact', sourceId: id(44) },
    ])
      await expect(
        client.callTool({ name: 'memory_remember', arguments: args }),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(
      client.callTool({
        name: 'reference_archive_read',
        arguments: { ...extensionCases[3].input, offset: 1 },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(
      client.callTool({
        name: 'deliverable_document_read',
        arguments: { objectId: id(30), pages: null },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(f.services.memoryRemember).not.toHaveBeenCalled();
    expect(f.services.referenceArchiveRead).not.toHaveBeenCalled();
    expect(f.services.deliverableDocumentRead).not.toHaveBeenCalled();
  });

  it('preserves native image, resource and structured content without a new envelope', async () => {
    const f = extensionFixture();
    const native: CallToolResult = {
      content: [
        { type: 'text', text: 'protocol image fixture' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        {
          type: 'resource',
          resource: {
            uri: 'allrice-fixture://reference',
            mimeType: 'text/plain',
            text: 'fixture bytes',
          },
        },
      ],
      structuredContent: { receipt: 'protocol-only' },
    };
    f.services.referenceReadImage.mockResolvedValue(native);
    const { client } = await connect(f);
    expect(
      await client.callTool({ name: 'reference_read_image', arguments: pin }),
    ).toEqual(native);
  });

  it('allows only exact-input selection errors on pinned reads and none on search', async () => {
    const f = extensionFixture();
    const selection = ReferenceSelectionErrorSchema.parse({
      error: {
        code: 'REFERENCE_SELECTION_UNAVAILABLE',
        message: 'original selection refusal',
        requestId: id(6),
        retryable: false,
        referenceRevisionIds: [pin.revisionId],
      },
    });
    const { client } = await connect(f);
    for (const { name, method, input } of extensionCases.slice(0, 4)) {
      f.services[method].mockRejectedValue(selection);
      if (name === 'reference_search')
        await expect(
          client.callTool({ name, arguments: input }),
        ).rejects.toThrow('Invalid module selection error');
      else {
        const result = await client.callTool({ name, arguments: input });
        expect(result).toMatchObject({
          isError: true,
          content: [{ text: JSON.stringify(selection) }],
        });
        f.services[method].mockRejectedValue({
          error: { ...selection.error, referenceRevisionIds: [id(101)] },
        });
        await expect(
          client.callTool({ name, arguments: input }),
        ).rejects.toThrow('Invalid module selection error');
      }
    }
  });

  it.each(['api', 'selection'])(
    'rechecks current access after a named thrown %s error',
    async (kind) => {
      const f = extensionFixture();
      const payload =
        kind === 'api'
          ? ApiErrorSchema.parse({
              error: {
                code: 'AUTHORIZATION_DENIED',
                message: 'original named business refusal',
                requestId: id(6),
                retryable: false,
              },
            })
          : ReferenceSelectionErrorSchema.parse({
              error: {
                code: 'REFERENCE_SELECTION_UNAVAILABLE',
                message: 'original named business refusal',
                requestId: id(6),
                retryable: false,
                referenceRevisionIds: [pin.revisionId],
              },
            });
      f.services.referenceReadImage.mockRejectedValue(payload);
      const { client } = await connect(f);
      expect(
        await client.callTool({ name: 'reference_read_image', arguments: pin }),
      ).toMatchObject({
        isError: true,
        content: [{ text: JSON.stringify(payload) }],
      });
      f.services.referenceReadImage.mockImplementation(async () => {
        f.scope.enabledModules = [];
        throw payload;
      });
      const denied = await client.callTool({
        name: 'reference_read_image',
        arguments: pin,
      });
      expect(denied).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining('AUTHORIZATION_DENIED') }],
      });
      expect(JSON.stringify(denied)).not.toContain(
        'original named business refusal',
      );
    },
  );

  it.each(extensionCases)(
    'native cancellation still joins $name without redispatch',
    async ({ name, method, input }) => {
      const f = extensionFixture();
      const entered = gate(),
        aborted = gate(),
        finish = gate();
      let joined = false;
      f.services[method].mockImplementation(
        async (
          _scope: AllriceMcpScope,
          _input: unknown,
          signal: AbortSignal,
        ) => {
          signal.addEventListener('abort', () => aborted.resolve(), {
            once: true,
          });
          entered.resolve();
          try {
            await finish.promise;
            return {
              content: [{ type: 'text' as const, text: 'late fixture result' }],
            };
          } finally {
            joined = true;
          }
        },
      );
      const { client, controller } = await connect(f);
      const abort = new AbortController();
      const rejected = expect(
        client.callTool({ name, arguments: input }, undefined, {
          signal: abort.signal,
        }),
      ).rejects.toThrow();
      try {
        await entered.promise;
        abort.abort();
        await rejected;
        await aborted.promise;
        let idle = false;
        const waiting = controller.whenIdle().then(() => {
          idle = true;
        });
        await Promise.resolve();
        expect(idle).toBe(false);
        expect(joined).toBe(false);
        finish.resolve();
        await waiting;
        expect(joined).toBe(true);
        expect(f.services[method]).toHaveBeenCalledTimes(1);
      } finally {
        finish.resolve();
        await controller.whenIdle();
        await rejected;
      }
    },
  );

  it('withholds a candidate receipt after revocation without claiming rollback', async () => {
    const f = extensionFixture();
    f.services.memoryRemember.mockImplementation(async () => {
      f.scope.moduleConfigRevisionRef = 'changed-after-candidate-fixture';
      return {
        content: [{ type: 'text', text: 'candidate fixture receipt withheld' }],
      };
    });
    const { client } = await connect(f);
    const result = await client.callTool({
      name: 'memory_remember',
      arguments: { summary: 'human preference' },
    });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain(
      'Candidate may already be committed',
    );
    expect(JSON.stringify(result)).not.toContain(
      'candidate fixture receipt withheld',
    );
    expect(f.services.memoryRemember).toHaveBeenCalledTimes(1);
  });
});

describe('AllRice native SDK MCP managed boundary (contract fixtures, no production gateway)', () => {
  it('a business owner implements the public callback and consumes the versioned native SDK port', async () => {
    const f = fixture();
    const read: AllriceMcpMemoryRead = async (scope, input, signal) => {
      expect(scope.nativeCallRef).toBe('host-native-call');
      expect(scope.executionGeneration).toBe('4.0');
      signal.throwIfAborted();
      return {
        content: [{ type: 'text', text: `issued ordinal ${input.number}` }],
      };
    };
    f.services.memoryRead = read;
    const { client, controller } = await connect(f);
    const port: AllriceMcpServerPort = controller;
    expect(port.contractVersion).toBe(ALLRICE_MCP_CONTRACT_VERSION);
    expect(client.getServerVersion()).toEqual({
      name: 'allrice',
      version: '1',
    });
    await expect(
      client.callTool({ name: 'memory_read', arguments: { number: 1 } }),
    ).resolves.toMatchObject({ content: [{ text: 'issued ordinal 1' }] });
  });

  it('host revocation joins its actual work, rejects new admission and leaves another MCP connection usable', async () => {
    const f = fixture();
    const entered = gate(),
      aborted = gate(),
      finish = gate();
    let signal: AbortSignal | undefined;
    let completed = false;
    const read = vi.fn<AllriceMcpMemoryRead>(
      async (_scope, _input, incoming) => {
        signal = incoming;
        incoming.addEventListener('abort', () => aborted.resolve(), {
          once: true,
        });
        entered.resolve();
        // Simulates an owner Promise which cannot finish until its I/O joins.
        await finish.promise;
        completed = true;
        return { content: [{ type: 'text', text: 'late private result' }] };
      },
    );
    f.services.memoryRead = read;
    const first = await connect(f);
    const second = await connect(fixture());
    let disclosed = false;
    const pending = first.client
      .callTool({ name: 'memory_read', arguments: { number: 1 } })
      .then((result) => {
        disclosed = true;
        return result;
      })
      .catch((error: unknown) => error);
    let revoked: Promise<void> | undefined;
    let idle: Promise<void> | undefined;
    let closed = false;
    try {
      await entered.promise;
      idle = first.controller.whenIdle();
      expect(signal?.aborted).toBe(false); // whenIdle is passive.
      revoked = first.controller.revoke().then(() => {
        closed = true;
      });
      await aborted.promise;
      expect(closed).toBe(false);
      expect(completed).toBe(false);
      expect(signal?.reason).toBeInstanceOf(DOMException);
      expect(signal?.reason.name).toBe('AbortError');
      const nativeAbort = {
        code: signal!.reason.code,
        message: expect.stringContaining(signal!.reason.message),
      };
      // operation rejects with the native abort before list/current can run.
      await expect(first.client.listTools()).rejects.toMatchObject(nativeAbort);
      await expect(
        first.client.callTool({
          name: 'memory_read',
          arguments: { number: 2 },
        }),
      ).rejects.toMatchObject(nativeAbort);
      expect(read).toHaveBeenCalledTimes(1);
      await expect(
        second.client.callTool({
          name: 'memory_read',
          arguments: { number: 1 },
        }),
      ).resolves.toMatchObject({ content: [{ text: 'actual module result' }] });
      expect(closed).toBe(false);
    } finally {
      finish.resolve();
      await revoked;
      await idle;
      await pending;
    }
    expect(completed).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(disclosed).toBe(false);
    const late = await pending;
    expect(late).toBeInstanceOf(McpError);
    // SDK response delivery can observe the native abort or joined close;
    // neither is a successful late disclosure of the owner's result.
    expect([signal!.reason.code, ErrorCode.ConnectionClosed]).toContain(
      (late as McpError).code,
    );
    await first.controller.close(); // Joined shutdown is idempotent with revoke.
  });

  it('advertises the complete existing export input schema through the SDK projection', async () => {
    const f = fixture();
    const { client } = await connect(f);
    const original = riceToolDefinitions.find(
      (tool) => tool.name === 'workspace.export.create',
    )!.inputSchema;
    const advertised = (await client.listTools()).tools.find(
      (tool) => tool.name === 'deliverable_create',
    )!.inputSchema;
    expect(advertised).toEqual(JSON.parse(JSON.stringify(original)));
  });

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
      f.services.referenceRead = vi.fn<
        NonNullable<AllriceMcpServices['referenceRead']>
      >(async () => {
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
    f.services.memoryRead = vi.fn<
      NonNullable<AllriceMcpServices['memoryRead']>
    >(async (_scope, _input, signal) => {
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
    f.services.deliverableCreate = vi.fn<
      NonNullable<AllriceMcpServices['deliverableCreate']>
    >(async (_scope, _input, signal) => {
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
