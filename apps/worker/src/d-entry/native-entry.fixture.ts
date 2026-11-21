/** Consumer test double only: no VM, PG permit, native job or physical fence. */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote';
import type { RequestContext, DEntryIdentity } from '@allrice/contracts';
import type { DEntryAdmissionPorts } from '@allrice/database';
import { createDEntryHttpHandler } from './http.js';
import { createDEntryMuxHandler } from './mux.js';
import type { DEntryNativeDataPort } from './native-data.js';
import type { ResolvedDEntryNativeOwner } from './native-owner.js';

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function frameQueue() {
  const frames: string[] = [];
  let ended = false,
    wake: (() => void) | undefined;
  return {
    push(frame: string) {
      frames.push(frame);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (frames.length) yield frames.shift()!;
        else if (ended) return;
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    },
  };
}
export function nativeEntryFixture() {
  const context: RequestContext = {
    requestId: randomUUID(),
    sessionId: randomUUID(),
    actor: { type: 'user', id: randomUUID() },
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    memberships: [],
    authenticatedAt: new Date().toISOString(),
  };
  const identity: DEntryIdentity = {
    organizationId: context.organizationId,
    workspaceId: context.workspaceId!,
    personId: context.actor.id,
    employeeInstanceId: randomUUID(),
    employeeRevision: 1,
    employeeVersionId: randomUUID(),
    threadId: randomUUID(),
  };
  const selection = {
    workspaceId: identity.workspaceId,
    employeeInstanceId: identity.employeeInstanceId,
    threadId: identity.threadId!,
  };
  const binding = {
    organizationId: identity.organizationId,
    personId: identity.personId,
    vmId: randomUUID(),
    instanceId: randomUUID(),
    leaseEpoch: 1,
  };
  const endpoint = {
    workspaceId: identity.workspaceId,
    employeeInstanceId: identity.employeeInstanceId,
    employeeRevision: identity.employeeRevision,
    employeeVersionId: identity.employeeVersionId,
    hostPort: 12345,
    guestPort: 12345,
  };
  const revoked = new AbortController(),
    authorization = new AbortController();
  const catalog = TYPERT_REMOTE.methods['session/list'].result.create().parse({
    items: [
      {
        sessionId: 'dsh-root',
        agentAvailable: true,
        updatedAt: 1,
        running: false,
        blank: false,
      },
      {
        sessionId: 'dsh-child',
        parentSessionId: 'dsh-root',
        origin: 'subagent',
        agentAvailable: true,
        updatedAt: 1,
        running: false,
        blank: false,
      },
      {
        sessionId: 'dsh-grandchild',
        parentSessionId: 'dsh-child',
        origin: 'subagent',
        agentAvailable: true,
        updatedAt: 1,
        running: false,
        blank: false,
      },
      {
        sessionId: 'dsh-foreign',
        agentAvailable: true,
        updatedAt: 1,
        running: false,
        blank: false,
      },
    ],
  });
  const owner: ResolvedDEntryNativeOwner = {
    receipt: { binding, rosterDigest: 'fixture-roster', endpoints: [endpoint] },
    endpoint,
    bindingRef: 'fixture-exact-native-owner',
    revoked: revoked.signal,
    controlReady: () => true,
    assertCurrent: vi.fn(async () => {}),
    readSessions: vi.fn(async () => ({ ok: true as const, value: catalog })),
  };
  const permit = {
    permitId: randomUUID(),
    binding,
    participant: 'entry' as const,
    disposition: 'queued' as const,
    signal: new AbortController().signal,
  };
  const admission: DEntryAdmissionPorts = {
    boundary: {
      admit: vi.fn(async () => permit),
      queued: async (_permit, callback, signal) => callback(signal),
      activate: async (_permit, callback, signal) => callback(signal),
      waitUntilReady: vi.fn(async () => binding),
      finish: vi.fn(async () => {}),
    },
    participant: {
      participant: 'entry',
      observe: vi.fn(),
      subscribe: vi.fn(),
      freeze: vi.fn(),
      assertFrozen: vi.fn(),
      thaw: vi.fn(),
    },
  };
  const rpcClose = vi.fn(async () => {});
  const rpcDispatch = vi.fn(async (consume: () => Promise<void>) => consume());
  const muxFrames = frameQueue(),
    sent = vi
      .fn<(frame: string) => Promise<void>>()
      .mockResolvedValue(undefined);
  const muxClosed = deferred<void>();
  const data: DEntryNativeDataPort = {
    admission,
    resolveAdmissionOwner: vi.fn(async (input) => ({
      context,
      binding,
      operationId: input.operationId,
      revoked: authorization.signal,
      assertCurrent: vi.fn(async () => {}),
      assertUndispatched: vi.fn(async () => {}),
    })),
    acquireRpc: vi.fn((input) => ({
      run: async (signal: AbortSignal) =>
        rpcDispatch(() =>
          input.consume(
            new Response('{"ok":true}', {
              headers: {
                'set-cookie': 'native-secret=never-browser',
                'content-type': 'application/json',
              },
            }),
            signal,
          ),
        ),
      close: rpcClose,
    })),
    acquireMux: vi.fn((input) => {
      let running: Promise<void> | undefined;
      return {
        run(signal: AbortSignal) {
          return (running = input.serve(
            { frames: muxFrames, send: sent },
            signal,
          ));
        },
        async close() {
          muxFrames.end();
          await running?.catch(() => {});
          muxClosed.resolve();
        },
      };
    }),
  };
  const root = vi.fn(async () => ({
    identity,
    rootNativeSessionId: 'dsh-root',
    rootOriginDigest: 'fixture-immutable-business-pin',
    threadGeneration: 1,
  }));
  const deps = {
    authenticate: vi.fn(async () => context as RequestContext | null),
    identity: vi.fn(async () => identity),
    root,
    owners: { resolve: vi.fn(async () => owner) },
    data: vi.fn(() => data as DEntryNativeDataPort | undefined),
  };
  return {
    context,
    identity,
    selection,
    binding,
    endpoint,
    revoked,
    authorization,
    owner,
    admission,
    permit,
    data,
    rpcClose,
    rpcDispatch,
    catalog,
    muxFrames,
    muxClosed,
    sent,
    deps,
    root,
    body: { organizationId: identity.organizationId, selection },
  };
}
export async function nativeEntryServer(f = nativeEntryFixture()) {
  const stop = new AbortController();
  const http = createDEntryHttpHandler(f.deps, stop.signal),
    mux = createDEntryMuxHandler(f.deps, stop.signal);
  const server = createServer(async (request, response) => {
    if (!(await http(request, response))) response.writeHead(404).end();
  });
  server.on('upgrade', (request, socket, head) => {
    void mux.upgrade(request, socket, head).catch(() => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = {
    authorization: 'Bearer original_session_opaque_token',
    'content-type': 'application/json',
  };
  return {
    ...f,
    origin,
    mux,
    server,
    request(
      path = 'native-owner',
      body: unknown = f.body,
      extra: Record<string, string> = {},
    ) {
      return fetch(`${origin}/internal/d-entry/${path}`, {
        method: 'POST',
        headers: { ...headers, ...extra },
        body: JSON.stringify(body),
      });
    },
    async close() {
      stop.abort();
      let errors: unknown[];
      try {
        const results = await Promise.allSettled([mux.close(), http.close()]);
        errors = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      if (errors.length)
        throw new AggregateError(errors, 'Entry fixture cleanup unknown');
    },
  };
}
