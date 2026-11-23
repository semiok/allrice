/** Native SDK + real owner/PG/Storage. Host qualification below is a named
 * test substitute, never a production 271/273 binding, Run or carrier. */
import { randomUUID } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { RequestContext, StoragePort } from '@allrice/contracts';
import {
  authenticateSession,
  createDeliverablesMcpReadPort,
  createDeliverablesPort,
  createSession,
  ensureBootstrapPortalPrincipal,
  readWorkbenchFile,
  uploadWorkbenchFile,
} from '@allrice/database';
import * as database from '../../../packages/database/src/core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../../../packages/database/src/runtime.fixture.ts';
import {
  createAllriceMcpServer,
  type AllriceMcpDeliverableRead,
  type AllriceMcpScope,
} from '../src/mcp/allrice-server.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const body = '\ufeff验收🙂\n回款出处。';
const checksum =
  'sha256:d5156d964b08f981ba23cb894f477410dc266504402c3a24ef15261964494b25';
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function call(
  client: Client,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) {
  return client.callTool(
    { name: 'deliverable_read', arguments: input },
    undefined,
    { signal },
  );
}

suite('SDK deliverable_read: real owners, test-only qualification', () => {
  let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  const contexts: RequestContext[] = [];
  const releases: (() => void)[] = [];
  const cleanup: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    f = await createRuntimeFixtureDatabase();
    vi.spyOn(database, 'getDatabase').mockReturnValue(f.db);
    for (const [index, name] of ['owner', 'peer', 'tenant'].entries()) {
      const principal = await ensureBootstrapPortalPrincipal({
        organizationSlug: index === 2 ? 'sdk-other' : 'sdk-owner',
        organizationName: 'SDK owner fixture',
        workspaceSlug: 'sdk',
        workspaceName: 'SDK',
        email: name + '@sdk-owner.example.test',
        displayName: name,
        role: 'member',
      });
      contexts.push(
        (await authenticateSession(
          (await createSession(principal.user.id)).token,
          {
            organizationId: principal.organizationId,
            workspaceId: principal.workspaceId,
          },
        ))!,
      );
    }
  }, 120000);
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    const closing = cleanup.splice(0).reverse();
    const results = await Promise.allSettled(closing.map((close) => close()));
    for (const result of results) expect(result.status).toBe('fulfilled');
  }, 30000);
  afterAll(async () => {
    try {
      if (f)
        expect(await f.close()).toMatchObject({
          schemaRemoved: true,
          storageRemoved: true,
          databaseClosed: true,
          adminClosed: true,
        });
    } finally {
      vi.restoreAllMocks();
    }
  }, 30000);
  const actual = () => runtimeFixtureStorage(f.db);

  async function connect(
    context = contexts[0]!,
    getInput?: StoragePort['get'],
    qualified = true,
  ) {
    const storage = actual();
    const get = vi.fn(getInput ?? storage.get.bind(storage));
    const owner = createDeliverablesPort({
      storage: {
        put: storage.put.bind(storage),
        get,
        delete: storage.delete.bind(storage),
        exists: storage.exists.bind(storage),
      },
      requireCurrentAccess: qualified ? async () => {} : undefined, // Test qualification only.
    });
    const adapter = createDeliverablesMcpReadPort(owner);
    const read = vi.fn<AllriceMcpDeliverableRead>((scope, input, signal) =>
      adapter.readExact(scope.requestContext, input, signal),
    );
    const scope: AllriceMcpScope = {
      personId: context.actor.id,
      organizationId: context.organizationId,
      workspaceId: context.workspaceId,
      employeeInstanceId: randomUUID(),
      allriceThreadRef: randomUUID(),
      nativeSessionRef: {
        instanceId: 'test',
        profileId: 'test',
        sessionId: 'test',
      },
      executionGeneration: '4.0',
      requestContext: context,
      enabledModules: ['deliverables'],
      moduleConfigRevisionRef: 'test-only-qualification',
      nativeCallRef: 'test-only-call',
    };
    const port = createAllriceMcpServer({
      host: { binding: scope, current: async () => scope },
      services: { executionGeneration: '4.0', deliverableRead: read },
    });
    const client = new Client({ name: 'real-owner-fixture', version: '1' });
    cleanup.push(async () => {
      try {
        await port.close();
      } finally {
        await client.close();
      }
    });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await port.server.connect(right);
    await client.connect(left);
    return { port, client, read, get };
  }
  async function seed(fileName: string) {
    const uploaded = await uploadWorkbenchFile(
      contexts[0]!,
      {
        workspaceId: contexts[0]!.workspaceId!,
        requestId: randomUUID(),
        fileName,
        mediaType: 'text/plain',
        contentBase64: Buffer.from(body).toString('base64'),
      },
      actual(),
    );
    const stored = await readWorkbenchFile(contexts[0]!, uploaded.objectId);
    expect(stored.object.checksum).toBe(checksum);
    expect(stored.object.sizeBytes).toBe(29);
    return {
      input: { objectId: uploaded.objectId, checksum },
      object: stored.object,
    };
  }
  function expected(objectId: string, fileName: string) {
    return {
      id: objectId,
      checksum,
      downloadUrl: '/api/v1/files/' + objectId + '/download?name=' + fileName,
      fileName,
      mediaType: 'text/plain',
      content: body,
      offset: 0,
      totalCharacters: 11,
      truncated: false,
      nextOffset: null,
    };
  }
  function controlledGet() {
    const entered = gate(),
      finishRead = gate(),
      cancelling = gate(),
      nativeCanceled = gate(),
      finishCancel = gate();
    let stream: ReadableStream<Uint8Array> | undefined;
    const get: StoragePort['get'] = async (object) => {
      stream = await actual().get(object);
      const reader = stream.getReader();
      let work = Promise.resolve(),
        canceled = false;
      return new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            return (work = (async () => {
              const chunk = await reader.read(); // Actual LocalStorage read, no substitute bytes.
              entered.resolve();
              await finishRead.promise;
              if (!canceled) {
                if (chunk.done) {
                  reader.releaseLock();
                  controller.close();
                } else controller.enqueue(chunk.value);
              }
            })());
          },
          async cancel(reason) {
            canceled = true;
            const canceling = reader.cancel(reason);
            cancelling.resolve();
            const results = await Promise.allSettled([work, canceling]);
            nativeCanceled.resolve();
            try {
              await finishCancel.promise;
            } finally {
              reader.releaseLock();
            }
            for (const result of results)
              if (result.status === 'rejected') throw result.reason;
          },
        },
        { highWaterMark: 0 },
      );
    };
    const release = () => {
      finishRead.resolve();
      finishCancel.resolve();
    };
    releases.push(release);
    return {
      get,
      entered,
      finishRead,
      cancelling,
      nativeCanceled,
      finishCancel,
      release,
      locked: () => stream?.locked,
    };
  }

  it('discovers and reads fixed UTF-8 projections, pages and complete original bytes', async () => {
    const { input, object } = await seed('source.txt');
    const { client, read, get } = await connect();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'identity_read',
      'deliverable_read',
    ]);
    await expect(
      call(client, { ...input, personId: 'guest' }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(read).not.toHaveBeenCalled();
    const projection = expected(input.objectId, 'source.txt');
    const cases: [Record<string, unknown>, ReturnType<typeof expected>][] = [
      [input, projection],
      [
        { ...input, offset: 6, limit: 5 },
        { ...projection, content: '回款出处。', offset: 6, truncated: true },
      ],
    ];
    for (const [args, value] of cases)
      expect(await call(client, args)).toEqual({
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: value,
      });
    expect(get).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(2);
    expect(
      Buffer.from(await new Response(await actual().get(object)).arrayBuffer()),
    ).toEqual(Buffer.from(body));
  }, 30000);

  it.each(['peer', 'tenant', 'pin', 'unqualified'] as const)(
    'preserves real owner denial for %s',
    async (mode) => {
      const { input } = await seed(mode + '.txt');
      const context =
        contexts[mode === 'peer' ? 1 : mode === 'tenant' ? 2 : 0]!;
      const connection = await connect(
        context,
        undefined,
        mode !== 'unqualified',
      );
      const args =
        mode === 'pin'
          ? { ...input, checksum: 'sha256:' + '0'.repeat(64) }
          : input;
      const denied = mode === 'unqualified';
      expect(await call(connection.client, args)).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: {
                code: denied ? 'AUTHORIZATION_DENIED' : 'RESOURCE_NOT_FOUND',
                message: denied ? 'authorization_denied' : 'not_found',
                requestId: context.requestId,
                retryable: false,
              },
            }),
          },
        ],
      });
      expect(connection.read).toHaveBeenCalledTimes(1);
      expect(connection.get).not.toHaveBeenCalled();
    },
    30000,
  );

  it('redacts an unknown real storage boundary failure exactly once', async () => {
    const { input } = await seed('unknown.txt');
    const connection = await connect(contexts[0], async (object) => {
      const stream = await actual().get(object);
      await stream.cancel();
      throw new Error('fixture-private://storage-key');
    });
    await expect(call(connection.client, input)).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message:
        'MCP error -32603: MCP error -32603: AllRice business service failed',
      data: undefined,
    });
    expect(connection.read).toHaveBeenCalledTimes(1);
    expect(connection.get).toHaveBeenCalledTimes(1);
  }, 30000);

  it.each(['cancel', 'revoke', 'close'] as const)(
    'joins actual read/cancel after %s and leaves another connection independent',
    async (mode) => {
      const { input } = await seed(mode + '.txt');
      const flow = controlledGet();
      const first = await connect(contexts[0], flow.get);
      const second = await connect();
      const abort = new AbortController();
      const reason = new Error('fixture client cancelled');
      let disclosed = false,
        joined = false,
        idle = false,
        closed = false;
      let ending = Promise.resolve(),
        waiting = Promise.resolve();
      const pending = call(first.client, input, abort.signal).then(
        (result) => {
          disclosed = true;
          return result;
        },
        (error: unknown) => error,
      );
      try {
        await flow.entered.promise;
        const completed = () => {
          joined = true;
        };
        void first.read.mock.results[0]!.value.then(completed, completed);
        const signal = first.read.mock.calls[0]![2];
        waiting = first.port.whenIdle().then(() => {
          idle = true;
        });
        expect(signal.aborted).toBe(false); // Passive whenIdle is not cancellation.
        if (mode === 'cancel') {
          abort.abort(reason);
          expect(await pending).toMatchObject({
            code: ErrorCode.RequestTimeout,
          });
        } else
          ending = first.port[mode]().then(() => {
            closed = true;
          });
        await flow.cancelling.promise;
        expect(signal.aborted).toBe(true);
        await turn();
        expect(joined).toBe(false);
        expect(idle).toBe(false);
        expect(closed).toBe(false);
        expect(flow.locked()).toBe(true);
        expect((await call(second.client, input)).structuredContent).toEqual(
          expected(input.objectId, mode + '.txt'),
        );
        expect(second.read).toHaveBeenCalledTimes(1);
        expect(first.read).toHaveBeenCalledTimes(1);
        flow.finishRead.resolve();
        await flow.nativeCanceled.promise; // Actual read forwarding and native reader.cancel both settled.
        await turn();
        expect(joined).toBe(false);
        expect(idle).toBe(false);
        expect(closed).toBe(false);
        expect(flow.locked()).toBe(true);
        flow.finishCancel.resolve();
        await waiting;
        await ending;
        const outcome = await pending;
        expect(outcome).toBeInstanceOf(McpError);
        if (mode === 'cancel')
          expect(outcome).toMatchObject({ code: ErrorCode.RequestTimeout });
        else
          expect([signal.reason.code, ErrorCode.ConnectionClosed]).toContain(
            (outcome as McpError).code,
          );
        expect(joined).toBe(true);
        expect(disclosed).toBe(false);
        expect(flow.locked()).toBe(false);
        expect(first.get).toHaveBeenCalledTimes(1);
        expect(first.read).toHaveBeenCalledTimes(1);
      } finally {
        flow.release();
        await first.port.whenIdle();
        await ending;
        await waiting;
        await pending;
      }
    },
    30000,
  );
});
