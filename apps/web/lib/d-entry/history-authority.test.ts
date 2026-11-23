import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { DataAccessError } from '@allrice/database';
import { DEntryDependencyUnavailable } from './release-policy';
import {
  HostHistorySnapshotSchema,
  type HostHistoryBinding,
  type RequestContext,
  type StorageObject,
} from '@allrice/contracts';
import { hostHistoryDigest } from '@allrice/storage';
import { createDEntryHistoryRouteHandlers } from './history-authority';
import { GET as historyGET } from '../../app/api/v1/d-entry/history/route';
import { GET as downloadGET } from '../../app/api/v1/d-entry/history/download/route';

const db = vi.hoisted(() => ({
  root: vi.fn(),
  watch: vi.fn(),
  identity: vi.fn(),
  generation: vi.fn(),
  login: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getDEntryHistoryRootPin: db.root,
  watchDEntryHistoryAuthority: db.watch,
  resolveDEntryIdentity: db.identity,
  getSessionExecutionGeneration: db.generation,
}));
vi.mock('../identity/session', () => ({ requireRequestContext: db.login }));
const roots: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 271 contract unit substitutes only; the PG suite exercises the actual
 * public owner. binding/store/object ports below are explicitly 273/ACL fakes. */
async function fixture() {
  const binding: HostHistoryBinding = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    personId: randomUUID(),
    employeeInstanceId: randomUUID(),
    threadId: randomUUID(),
    nativeInstanceRef: 'test-273-instance',
    nativeProfileRef: 'test-273-profile',
    nativeSessionId: 'host-root',
    rootNativeSessionId: 'host-root',
    parentNativeSessionId: null,
    configurationRef: 'test-273-config',
    configurationDigest: hostHistoryDigest('test-config'),
    executionGeneration: '4.0',
  };
  const identity = {
    organizationId: binding.organizationId,
    workspaceId: binding.workspaceId,
    personId: binding.personId,
    employeeInstanceId: binding.employeeInstanceId,
    employeeRevision: 1,
    employeeVersionId: randomUUID(),
    threadId: binding.threadId,
  };
  const context: RequestContext = {
    actor: { type: 'user', id: binding.personId },
    organizationId: binding.organizationId,
    workspaceId: binding.workspaceId,
    sessionId: randomUUID(),
    requestId: randomUUID(),
    memberships: [],
    authenticatedAt: new Date().toISOString(),
  };
  const pin = {
    identity,
    rootNativeSessionId: binding.nativeSessionId,
    rootOriginDigest: hostHistoryDigest('host birth'),
    rootBindingRef: randomUUID(),
    vmId: randomUUID(),
  };
  const revoked = new AbortController();
  const subscription = {
    revoked: revoked.signal,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    close: vi.fn(async (): Promise<void> => undefined),
  };
  db.root.mockResolvedValue(pin);
  db.watch.mockResolvedValue(subscription);
  db.identity.mockResolvedValue(identity);
  db.generation.mockResolvedValue('4.0');
  db.login.mockResolvedValue(context);
  const bytes = new TextEncoder().encode('immutable history attachment');
  const object: StorageObject = {
    id: randomUUID(),
    organizationId: binding.organizationId,
    workspaceId: binding.workspaceId,
    ownerId: binding.personId,
    key: 'test-only-object',
    checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    sizeBytes: bytes.length,
    mediaType: 'text/plain',
    immutable: true,
    deletedAt: null,
    retentionUntil: null,
  };
  const snapshot = HostHistorySnapshotSchema.parse({
    schemaVersion: 1,
    binding,
    source: {
      dshVersion: '0.2.1-rc.2',
      sessionFormatVersion: 4,
      headerHash: hostHistoryDigest('test header'),
      inheritedEventCount: 0,
      throughSeq: 4,
      eventHashes: Array.from({ length: 5 }, (_, i) => hostHistoryDigest(i)),
    },
    entries: [
      {
        kind: 'message',
        seq: 1,
        time: 1,
        role: 'user',
        text: '关机后看上次历史',
        interrupted: false,
      },
      {
        kind: 'tool',
        seq: 2,
        time: 2,
        callId: 'old-call',
        name: 'publish',
        arguments: '{}',
        outcome: 'outcome-unknown',
        result: {
          seq: 3,
          text: 'unknown',
          isError: true,
          errorCode: 'TOOL_OUTCOME_UNKNOWN',
        },
      },
      { kind: 'turn-end', seq: 4, time: 4, turn: 1, reason: 'interrupted' },
    ],
    attachments: [
      {
        sourceSeq: 3,
        objectId: object.id,
        checksum: object.checksum,
        sizeBytes: bytes.length,
        mediaType: object.mediaType,
        fileName: 'receipt.txt',
      },
    ],
    lastTurn: { startSeq: 0, endSeq: 4, reason: 'interrupted' },
  });
  const digest = hostHistoryDigest(snapshot);
  const store = {
    read: vi.fn(async () => ({ digest, snapshot })),
    publish: vi.fn(async () => digest),
  };
  const bind = vi.fn(async () => binding);
  const objectRevoked = new AbortController();
  const owner = {
    object,
    revoked: objectRevoked.signal,
    reauthorize: vi.fn(async () => object),
    open: vi.fn(
      async () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
    ),
    close: vi.fn(async (): Promise<void> => undefined),
  };
  const spoolDirectory = await mkdtemp(`${tmpdir()}/met274-authority-`);
  roots.push(spoolDirectory);
  const files = { spoolDirectory, acquire: vi.fn(async () => owner) };
  function makeColdSource(input: {
    signal: AbortSignal;
    selection: Readonly<{ nativeSessionId: string; snapshotDigest?: string }>;
  }) {
    return {
      binding: bind,
      store,
      close: vi.fn(async (): Promise<void> => undefined),
      resolveColdResource: vi.fn(
        async (
          currentContext: RequestContext,
          current: Database.DEntryHistoryRootPin,
          nativeSessionId: string,
          active: AbortSignal,
        ) => {
          active.throwIfAborted();
          if (
            currentContext.organizationId !== current.identity.organizationId ||
            nativeSessionId !== input.selection.nativeSessionId ||
            nativeSessionId !== current.rootNativeSessionId
          )
            throw new DEntryDependencyUnavailable('native-route');
          return {
            organizationId: current.identity.organizationId,
            personId: current.identity.personId,
            employeeInstanceId: current.identity.employeeInstanceId,
            threadId: binding.threadId,
            nativeSessionId,
            rootNativeSessionId: current.rootNativeSessionId,
            parentNativeSessionId: null,
            bindingRef: current.rootBindingRef,
            revoked: input.signal,
          };
        },
      ),
    };
  }
  const scopes: ReturnType<typeof makeColdSource>[] = [];
  const createColdSource = vi.fn(
    (input: Parameters<typeof makeColdSource>[0]) => {
      const scope = makeColdSource(input);
      scopes.push(scope);
      return scope;
    },
  );
  const ports = { createColdSource, files };
  const selection = {
    workspaceId: binding.workspaceId,
    employeeInstanceId: binding.employeeInstanceId,
    threadId: binding.threadId,
  };
  const request = (download = false, signal?: AbortSignal) =>
    new Request(
      `https://allrice.test/api/v1/d-entry/history${download ? '/download' : ''}?${new URLSearchParams(
        {
          ...selection,
          nativeSessionId: binding.nativeSessionId,
          ...(download
            ? { snapshotDigest: digest, objectId: object.id }
            : { limit: '100' }),
        },
      )}`,
      { signal },
    );
  return {
    context,
    identity,
    pin,
    subscription,
    revoked,
    objectRevoked,
    ports,
    createColdSource,
    scopes,
    store,
    bind,
    files,
    owner,
    request,
    selection,
    digest,
    bytes,
  };
}

describe('formal 271 history composition contract', () => {
  it('uses trusted login plus the two barrel APIs with no production feed and joins close before returning JSON', async () => {
    const f = await fixture(),
      closing = gate(),
      closed = gate();
    f.subscription.close.mockImplementationOnce(async () => {
      closing.release();
      await closed.promise;
    });
    const request = f.request();
    let settled = false;
    const pending = createDEntryHistoryRouteHandlers(f.ports).history(request);
    void pending.then(() => {
      settled = true;
    });
    try {
      await closing.promise;
      await turn();
      expect(settled).toBe(false);
      expect(db.login).toHaveBeenCalledWith(request);
      expect(db.watch.mock.calls[0]).toEqual([
        f.context,
        f.selection,
        f.identity,
        request.signal,
      ]);
      expect(db.root).toHaveBeenCalledWith(f.context, f.selection);
    } finally {
      closed.release();
      await Promise.allSettled([pending]);
    }
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      snapshotDigest: f.digest,
      notice: 'interrupted',
      externalEffects: 'unverified',
    });
    expect(f.subscription.close).toHaveBeenCalledTimes(1);
    expect(f.store.publish).not.toHaveBeenCalled();
  });

  it('registers real history/download GET factories but returns explicit missing273 after closing authority', async () => {
    const f = await fixture();
    for (const [handler, download] of [
      [historyGET, false],
      [downloadGET, true],
    ] as const) {
      const response = await handler(f.request(download));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: expect.stringContaining('MET-273'),
        },
      });
    }
    expect(f.subscription.close).toHaveBeenCalledTimes(2);
    expect(f.store.read).not.toHaveBeenCalled();
    expect(f.files.acquire).not.toHaveBeenCalled();
  });

  it('does not turn an absent/claim-only root into creation, fallback or a subscription', async () => {
    const f = await fixture();
    db.root.mockResolvedValue(null);
    expect(
      (await createDEntryHistoryRouteHandlers(f.ports).history(f.request()))
        .status,
    ).toBe(404);
    expect(db.watch).not.toHaveBeenCalled();
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.store.read).not.toHaveBeenCalled();
  });

  it('does not use the 271 subscription as an attachment ACL owner', async () => {
    const f = await fixture();
    const response = await createDEntryHistoryRouteHandlers({
      createColdSource: f.createColdSource,
    }).download(f.request(true));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'DEPENDENCY_UNAVAILABLE' },
    });
    expect(f.subscription.close).toHaveBeenCalledTimes(1);
    expect(f.files.acquire).not.toHaveBeenCalled();
  });

  it('fails closed on a changed persistent birth pin and does not authorize browser-selected ancestry', async () => {
    const f = await fixture();
    db.root.mockResolvedValueOnce(f.pin).mockResolvedValue({
      ...f.pin,
      rootOriginDigest: hostHistoryDigest('other birth'),
    });
    const handlers = createDEntryHistoryRouteHandlers(f.ports);
    expect((await handlers.history(f.request())).status).toBe(403);
    expect(f.store.read).not.toHaveBeenCalled();
    db.root.mockResolvedValue(f.pin);
    const url = new URL(f.request().url);
    url.searchParams.set('nativeSessionId', 'guest-same-string-child');
    expect((await handlers.history(new Request(url))).status).toBe(503);
    expect(f.subscription.close).toHaveBeenCalledTimes(2);
  });

  it.each(['binding', 'store', 'object'] as const)(
    'joins authority after partial %s initialization failure',
    async (stage) => {
      const f = await fixture();
      const denied = new DataAccessError('authorization_denied');
      if (stage === 'binding') f.bind.mockRejectedValueOnce(denied);
      if (stage === 'store') f.store.read.mockRejectedValueOnce(denied);
      if (stage === 'object') f.files.acquire.mockRejectedValueOnce(denied);
      const handler = createDEntryHistoryRouteHandlers(f.ports);
      const response = await (stage === 'object'
        ? handler.download(f.request(true))
        : handler.history(f.request()));
      expect(response.status).toBe(403);
      expect(f.subscription.close).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['revoke', 'cancel'] as const)(
    'joins a pending store read and authority close on %s',
    async (mode) => {
      const f = await fixture(),
        entered = gate(),
        drained = gate(),
        closing = gate(),
        closed = gate();
      const read = f.store.read.getMockImplementation()!;
      f.store.read.mockImplementationOnce(async () => {
        entered.release();
        await drained.promise;
        return read();
      });
      f.subscription.close.mockImplementationOnce(async () => {
        closing.release();
        await closed.promise;
      });
      const cancel = new AbortController();
      let settled = false;
      const pending = createDEntryHistoryRouteHandlers(f.ports).history(
        f.request(false, cancel.signal),
      );
      void pending.then(() => {
        settled = true;
      });
      const reason = new DataAccessError('authorization_denied');
      try {
        await entered.promise;
        if (mode === 'revoke') f.revoked.abort(reason);
        else cancel.abort(reason);
        await turn();
        expect(settled).toBe(false);
        expect(f.subscription.close).not.toHaveBeenCalled();
        drained.release();
        await closing.promise;
        await turn();
        expect(settled).toBe(false);
      } finally {
        cancel.abort(reason);
        drained.release();
        closed.release();
        await Promise.allSettled([pending]);
      }
      expect((await pending).status).toBe(403);
      expect(f.subscription.close).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'eof',
    'cancel',
    'revoke',
    'early-response-assertion',
    'initialization-failure',
  ] as const)(
    'keeps subscription distinct from object owner and joins streamed %s',
    async (mode) => {
      const f = await fixture(),
        closing = gate(),
        closed = gate();
      let closePromise: Promise<void> | undefined;
      let closeFinished = false;
      f.subscription.close.mockImplementationOnce(() => {
        closePromise = (async () => {
          closing.release();
          await closed.promise;
          await turn();
          closeFinished = true;
        })();
        return closePromise;
      });
      if (mode === 'initialization-failure')
        f.files.acquire.mockRejectedValueOnce(
          new DataAccessError('authorization_denied'),
        );
      const initializationClosed = new Error(
        'Download entered authority close before returning a response',
      );
      let injectedAssertion: unknown;
      let pending: Promise<Response> | undefined;
      let response: Response | undefined;
      let settled = false;
      let operation: Promise<unknown> | undefined;
      let outcome: Promise<{ value: unknown } | { error: unknown }> | undefined;
      const exercise = async () => {
        try {
          pending = createDEntryHistoryRouteHandlers(f.ports).download(
            f.request(true),
          );
          // Failed initialization may already be awaiting our closed gate.
          // Enter finally instead of awaiting that blocked request forever.
          const ready = await Promise.race([
            pending.then((response) => ({ response })),
            closing.promise.then(() => undefined),
          ]);
          if (!ready) throw initializationClosed;
          response = ready.response;
          expect(response.status).toBe(200);
          expect(f.subscription.close).not.toHaveBeenCalled();
          if (mode === 'early-response-assertion') {
            try {
              expect(response.status, 'controlled early response failure').toBe(
                201,
              );
            } catch (error) {
              injectedAssertion = error;
              throw error;
            }
          }
          if (mode === 'cancel') operation = response.body!.cancel();
          else {
            operation = response.arrayBuffer();
            if (mode === 'revoke')
              f.revoked.abort(new DataAccessError('authorization_denied'));
          }
          outcome = operation.then(
            (value) => {
              settled = true;
              return { value };
            },
            (error: unknown) => {
              settled = true;
              return { error };
            },
          );
          await closing.promise;
          await turn();
          expect(settled).toBe(false);
          expect(f.owner.close).toHaveBeenCalledTimes(1);
          expect(f.subscription.close).toHaveBeenCalledTimes(1);
        } finally {
          closed.release();
          const [request] = await Promise.allSettled([pending]);
          if (request?.status === 'fulfilled') response ??= request.value;
          // A failed response assertion leaves an unconsumed spool body.
          // Drain it and every actual Promise without replacing the assertion.
          await Promise.allSettled([
            operation,
            outcome,
            (async () => {
              if (response?.body && !response.bodyUsed && !response.body.locked)
                await response.body.cancel();
            })(),
          ]);
          await Promise.allSettled([closePromise]);
        }
        const result = await outcome!;
        if (mode === 'eof')
          expect(
            new Uint8Array((result as { value: ArrayBuffer }).value),
          ).toEqual(f.bytes);
        if (mode === 'revoke')
          expect(result).toMatchObject({
            error: { code: 'authorization_denied' },
          });
      };
      if (
        mode === 'early-response-assertion' ||
        mode === 'initialization-failure'
      ) {
        const failure = await exercise().then(
          () => {
            throw new Error('Controlled failure did not occur');
          },
          (error: unknown) => error,
        );
        expect(failure).toBe(
          mode === 'early-response-assertion'
            ? injectedAssertion
            : initializationClosed,
        );
        expect(response?.bodyUsed).toBe(true);
        expect(response?.body?.locked).toBe(false);
        if (mode === 'early-response-assertion') {
          expect(injectedAssertion).toBeInstanceOf(Error);
          expect(f.owner.close).toHaveBeenCalledTimes(1);
        } else {
          expect(response?.status).toBe(403);
          expect(f.owner.close).not.toHaveBeenCalled();
          expect(f.owner.open).not.toHaveBeenCalled();
        }
      } else await exercise();
      expect(closeFinished).toBe(true);
      expect(f.subscription.close).toHaveBeenCalledTimes(1);
      expect(f.subscription.close.mock.results[0]?.value).toBe(closePromise);
    },
  );

  it('does not return history for an unjoined/failing subscription close or forged query authority', async () => {
    const f = await fixture();
    f.subscription.close.mockRejectedValueOnce(new Error('close unknown'));
    expect(
      (await createDEntryHistoryRouteHandlers(f.ports).history(f.request()))
        .status,
    ).toBe(500);
    const url = new URL(f.request().url);
    url.searchParams.set('personId', randomUUID());
    db.root.mockClear();
    expect((await historyGET(new Request(url))).status).toBe(400);
    expect(db.root).not.toHaveBeenCalled();
  });

  it('creates one fresh cold loader only after parse, login, watch and readPin', async () => {
    const f = await fixture();
    const create = f.createColdSource.getMockImplementation()!;
    const url = new URL(f.request().url);
    url.searchParams.set('snapshotDigest', f.digest);
    f.createColdSource.mockImplementationOnce((input) => {
      expect(db.login).toHaveBeenCalledTimes(1);
      expect(db.watch).toHaveBeenCalledTimes(1);
      expect(db.root).toHaveBeenCalledTimes(2);
      expect(input.selection).toEqual({
        nativeSessionId: f.pin.rootNativeSessionId,
        snapshotDigest: f.digest,
      });
      expect(input.signal.aborted).toBe(false);
      return create(input);
    });
    const handlers = createDEntryHistoryRouteHandlers(f.ports);
    expect((await handlers.history(new Request(url))).status).toBe(200);
    expect((await handlers.history(f.request())).status).toBe(200);
    expect(f.createColdSource).toHaveBeenCalledTimes(2);
    expect(f.scopes).toHaveLength(2);
    expect(f.scopes[0]).not.toBe(f.scopes[1]);
    for (const scope of f.scopes) {
      expect(scope.resolveColdResource).toHaveBeenCalled();
      expect(scope.close).toHaveBeenCalledTimes(1);
    }
  });

  it('does not fall back to raw projection when the cold constructor rejects', async () => {
    const f = await fixture();
    f.createColdSource.mockImplementationOnce(() => {
      throw new DEntryDependencyUnavailable('native-route');
    });
    const response = await createDEntryHistoryRouteHandlers(f.ports).history(
      f.request(),
    );
    expect(response.status).toBe(503);
    expect(f.createColdSource).toHaveBeenCalledTimes(1);
    expect(f.scopes).toHaveLength(0);
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.store.read).not.toHaveBeenCalled();
    expect(f.subscription.close).toHaveBeenCalledTimes(1);
  });

  it('owns a returned cold handle before checking cancellation again', async () => {
    const f = await fixture();
    const create = f.createColdSource.getMockImplementation()!;
    const cancel = new AbortController();
    f.createColdSource.mockImplementationOnce((input) => {
      const scope = create(input);
      cancel.abort(new DataAccessError('authorization_denied'));
      return scope;
    });
    const response = await createDEntryHistoryRouteHandlers(f.ports).history(
      f.request(false, cancel.signal),
    );
    expect(response.status).toBe(403);
    expect(f.scopes).toHaveLength(1);
    expect(f.scopes[0]!.close).toHaveBeenCalledTimes(1);
    expect(f.subscription.close).toHaveBeenCalledTimes(1);
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.store.read).not.toHaveBeenCalled();
  });

  it('rejects a root replacement during the actual cold resolver await', async () => {
    const f = await fixture(),
      entered = gate(),
      released = gate();
    const create = f.createColdSource.getMockImplementation()!;
    f.createColdSource.mockImplementationOnce((input) => {
      const scope = create(input);
      const resolve = scope.resolveColdResource.getMockImplementation()!;
      scope.resolveColdResource.mockImplementationOnce(async (...args) => {
        const resource = await resolve(...args);
        entered.release();
        await released.promise;
        return resource;
      });
      return scope;
    });
    const pending = createDEntryHistoryRouteHandlers(f.ports).history(
      f.request(),
    );
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('History settled before the cold resolver barrier');
        }),
      ]);
      db.root.mockResolvedValue({ ...f.pin, rootBindingRef: randomUUID() });
    } finally {
      released.release();
      await Promise.allSettled([pending]);
    }
    expect((await pending).status).toBe(403);
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.store.read).not.toHaveBeenCalled();
    expect(f.scopes[0]!.close).toHaveBeenCalledTimes(1);
    expect(f.subscription.close).toHaveBeenCalledTimes(1);
  });

  it.each(['cold', 'subscription', 'both'] as const)(
    'joins both real close promises when %s close rejects',
    async (failure) => {
      const f = await fixture(),
        coldEntered = gate(),
        authorityEntered = gate(),
        coldReleased = gate(),
        authorityReleased = gate();
      const create = f.createColdSource.getMockImplementation()!;
      f.createColdSource.mockImplementationOnce((input) => {
        const scope = create(input);
        scope.close.mockImplementationOnce(async () => {
          coldEntered.release();
          await coldReleased.promise;
          if (failure !== 'subscription') throw new Error('cold close unknown');
        });
        return scope;
      });
      f.subscription.close.mockImplementationOnce(async () => {
        authorityEntered.release();
        await authorityReleased.promise;
        if (failure !== 'cold') throw new Error('authority close unknown');
      });
      let settled = false;
      const pending = createDEntryHistoryRouteHandlers(f.ports).history(
        f.request(),
      );
      void pending.then(() => {
        settled = true;
      });
      try {
        await Promise.race([
          Promise.all([coldEntered.promise, authorityEntered.promise]),
          pending.then(() => {
            throw new Error('History settled before both close barriers');
          }),
        ]);
        await turn();
        expect(settled).toBe(false);
        if (failure === 'subscription') authorityReleased.release();
        else coldReleased.release();
        await turn();
        expect(settled).toBe(false);
      } finally {
        coldReleased.release();
        authorityReleased.release();
        await Promise.allSettled([pending]);
      }
      expect((await pending).status).toBe(500);
      expect(f.scopes[0]!.close).toHaveBeenCalledTimes(1);
      expect(f.subscription.close).toHaveBeenCalledTimes(1);
    },
  );
});
