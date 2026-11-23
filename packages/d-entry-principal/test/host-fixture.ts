import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  CredentialProvider,
  type CredentialKey,
  type CredentialRecord,
} from '@deepseek-ai/dsh-credentials';
import * as HostConnection from '@deepseek-ai/dsh-client-connection';
import {
  serverResponseSchema,
  RpcId,
} from '@deepseek-ai/dsh-client-connection';
import {
  installConnection,
  type ClientConnectionRpc,
} from '@deepseek-ai/dsh-client-connection/client';
import TypertRegistry, {
  type TypertContribution,
} from '@deepseek-ai/dsh-typert-registry';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import { TYPERT as AccessMetadata } from '@deepseek-ai/dsh-api-remote-access/typert';
import Gateway, {
  type TypertRemoteEventDispatch,
} from '@deepseek-ai/dsh-api-gateway';
import * as GatewayClient from '@deepseek-ai/dsh-api-gateway/client';
import {
  Remote,
  TypertRemoteService,
  type PeerScope,
} from '@deepseek-ai/dsh-typert-protocol';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {
  SessionFollowFrame,
  SessionFollowRequest,
  SessionPage,
  SessionPageRequest,
  SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/types';
import { TYPERT as NativeMetadata } from '@deepseek-ai/dsh-api-session-controller/typert';
import * as PrincipalHost from '@allrice/d-entry-principal/host';
import { TYPERT_REMOTE } from '@allrice/d-entry-principal/remote';
import type { DEntryPrincipalIssue } from '../src/types.js';

export function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function issue(
  access: 'history' | 'execute' = 'history',
): DEntryPrincipalIssue {
  return {
    scopeId: randomUUID(),
    access,
    identity: {
      organizationId: randomUUID(),
      personId: randomUUID(),
      workspaceId: randomUUID(),
      employeeInstanceId: randomUUID(),
      employeeRevision: 1,
      employeeVersionId: randomUUID(),
      threadId: randomUUID(),
    },
    root: {
      nativeSessionId: 'root',
      rootBindingRef: 'actual-sql-root-binding-fixture',
      rootOriginDigest: 'actual-sql-origin-fixture',
    },
  };
}
export function summary(id: string, parent?: string): SessionSummary {
  return {
    sessionId: SessionId(id),
    agentAvailable: false,
    updatedAt: 1,
    running: false,
    blank: false,
    ...(parent
      ? ({ parentSessionId: SessionId(parent), origin: 'subagent' } as const)
      : {}),
  };
}
function contribution(value: unknown): asserts value is TypertContribution {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof Reflect.get(value, 'package') !== 'string' ||
    Reflect.get(value, 'face') !== 'host' ||
    !Array.isArray(Reflect.get(value, 'schemas')) ||
    !Array.isArray(Reflect.get(value, 'invocations'))
  )
    throw Error('fixture generated metadata missing');
}
class Credentials extends CredentialProvider {
  private readonly records = new Map<CredentialKey, CredentialRecord>();
  override resolve() {
    return Promise.resolve(undefined);
  }
  override describe() {
    return Promise.resolve({ configured: false, writable: false });
  }
  override set(): Promise<void> {
    return Promise.reject(Error('fixture reference is read only'));
  }
  override unset(): Promise<void> {
    return Promise.reject(Error('fixture reference is read only'));
  }
  override readRecord(key: CredentialKey) {
    return Promise.resolve(this.records.get(key));
  }
  override describeRecord(key: CredentialKey) {
    const row = this.records.get(key);
    return Promise.resolve({
      configured: !!row,
      writable: true,
      ...(row ? { kind: row.kind } : {}),
    });
  }
  override listRecords() {
    return Promise.resolve(
      [...this.records].map(([key, row]) => ({ key, kind: row.kind })),
    );
  }
  override async modifyRecord(
    key: CredentialKey,
    mutate: (
      row: CredentialRecord | undefined,
    ) => Promise<CredentialRecord | undefined>,
  ) {
    const row = await mutate(this.records.get(key));
    if (row) this.records.set(key, row);
    return this.records.get(key);
  }
  override deleteRecord(key: CredentialKey) {
    this.records.delete(key);
    return Promise.resolve();
  }
}
/** Native catalog content is an explicit fixture. Peers, invocation scopes,
 * RemoteAccess snapshots/follow, event ready, codecs and carriers are real rc.2. */
class Catalog extends TypertRemoteService {
  items = [summary('root'), summary('child', 'root'), summary('other')];
  beforeList?: () => Promise<void>;
  beforeFollow?: () => Promise<void>;
  afterFollowSnapshot?: () => Promise<void>;
  afterFollow?: () => Promise<void>;
  readonly pages: PeerScope[] = [];
  readonly follows: PeerScope[] = [];
  constructor(ctx: Context) {
    super(ctx, 'sessionController', { namespace: 'session' });
  }
  @Remote('list')
  async list(_request: object, signal: AbortSignal) {
    await this.beforeList?.();
    signal.throwIfAborted();
    return { items: this.items };
  }
  @Remote({
    name: 'page',
    resources: {
      session: (request: SessionPageRequest) =>
        request.address.kind === 'session'
          ? request.address.sessionId
          : request.address.childSessionId,
    },
  })
  page(request: SessionPageRequest): SessionPage {
    void request;
    this.pages.push(this.ctx.invocation.peer);
    return { records: [], hasMore: false };
  }
  @Remote({
    mode: 'stream',
    resources: {
      session: (request: SessionFollowRequest) =>
        request.address.kind === 'session'
          ? request.address.sessionId
          : request.address.childSessionId,
    },
  })
  async *follow(
    request: SessionFollowRequest,
    signal: AbortSignal,
  ): AsyncIterable<SessionFollowFrame> {
    this.follows.push(this.ctx.invocation.peer);
    const sessionId =
      request.address.kind === 'session'
        ? request.address.sessionId
        : request.address.childSessionId;
    try {
      await this.beforeFollow?.();
      signal.throwIfAborted();
      // Session content is fixture data; the descriptor, resource guard,
      // cancellableStream and codec are the actual public native path.
      yield {
        type: 'snapshot',
        header: { version: 1, id: sessionId, createdAt: 1, isSeeded: false },
        cursor: 0,
        records: [],
        hasMore: false,
        projections: { asOfSeq: 0, values: {} },
      };
      await this.afterFollowSnapshot?.();
      await new Promise<void>((resolve) => {
        const stop = () => {
          signal.removeEventListener('abort', stop);
          resolve();
        };
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
      });
    } finally {
      await this.afterFollow?.();
    }
  }
}
export async function hostFixture(selected = issue(), install = true) {
  const host = new Context();
  await host.plugin(Credentials);
  await host.plugin(HostConnection);
  await host.plugin(TypertRegistry);
  contribution(AccessMetadata);
  contribution(NativeMetadata);
  host.typert.register(AccessMetadata);
  host.typert.register(NativeMetadata);
  host.typert.resources.register('session', { field: 'sessionId' });
  await host.plugin(RemoteAccess);
  await host.plugin(Gateway);
  const catalog = new Catalog(host);
  const dispatched: TypertRemoteEventDispatch[] = [];
  let wake = () => {};
  const source = (
    signal: AbortSignal,
  ): AsyncIterable<TypertRemoteEventDispatch> => ({
    async *[Symbol.asyncIterator]() {
      const abort = () => wake();
      signal.addEventListener('abort', abort, { once: true });
      try {
        while (!signal.aborted) {
          const row = dispatched.shift();
          if (row) yield row;
          else
            await new Promise<void>((yes) => {
              wake = yes;
            });
        }
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
  });
  host.effect(() =>
    host.typertGateway.registerRemoteEvents(source, {
      home: '/home/native-fixture',
    }),
  );
  const config = {
    profile: {
      workspaceId: selected.identity.workspaceId,
      employeeInstanceId: selected.identity.employeeInstanceId,
      employeeRevision: selected.identity.employeeRevision,
      employeeVersionId: selected.identity.employeeVersionId,
    },
    binding: {
      organizationId: selected.identity.organizationId,
      personId: selected.identity.personId,
      vmId: 'vm-fixture',
      instanceId: 'instance-fixture',
      leaseEpoch: 1,
    },
    moduleBase: createRequire(import.meta.url).resolve(
      '@allrice/d-entry-principal/host',
    ),
  };
  if (install) await host.plugin(PrincipalHost, config);
  const parent = host.connection.createPeer({
    principal: { kind: 'owner' },
    interactions: 'none',
  });
  const node = new Context();
  await node.plugin(TypertRegistry);
  const fetch = host.connection.createSharedFetchHandler('/api');
  const wire: ClientConnectionRpc = {
    async call(channel, endpoint, payload, signal) {
      const response = await fetch.fetch(
        new Request(`http://127.0.0.1${channel}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: RpcId(randomUUID()),
            method: endpoint,
            payload,
          }),
          signal,
        }),
        parent,
      );
      return serverResponseSchema.parse(await response.json()).result;
    },
    open(channel, endpoint, payload, signal, uplink) {
      if (channel !== '/api') throw Error('fixture channel');
      return {
        async *[Symbol.asyncIterator]() {
          yield* await host.typertGateway.wireStream.open(
            endpoint,
            payload,
            uplink ?? { async *[Symbol.asyncIterator]() {} },
            parent,
            signal,
          );
        },
      };
    },
  };
  installConnection(node, { interactions: 'none', transport: { rpc: wire } });
  await node.plugin(GatewayClient);
  await node.remote.$mount(TYPERT_REMOTE);
  return {
    host,
    node,
    parent,
    catalog,
    selected,
    config,
    wire,
    emit(row: TypertRemoteEventDispatch) {
      dispatched.push(row);
      wake();
    },
    async close() {
      await node.fiber.dispose();
      await host.fiber.dispose();
    },
  };
}

/** Observe real native next/return; never manufacture a baseline or terminal. */
export function observeNativeFollow(
  host: Context,
  endpoint: 'remoteAccess/follow' | 'session/follow',
) {
  const errors: unknown[] = [];
  const observed = {
    pending: deferred(),
    returned: deferred(),
    pendingSettled: false,
    returnJoined: false,
    errors,
  };
  const open = host.typertGateway.wireStream.open.bind(
    host.typertGateway.wireStream,
  );
  vi.spyOn(host.typertGateway.wireStream, 'open').mockImplementation(
    async (...args) => {
      const source = await open(...args);
      if (args[0] !== endpoint) return source;
      return {
        [Symbol.asyncIterator]() {
          const iterator = source[Symbol.asyncIterator]();
          let reads = 0;
          return {
            async next() {
              const read = ++reads,
                next = iterator.next();
              if (read === 2) observed.pending.resolve();
              try {
                return await next;
              } catch (error) {
                errors.push(error);
                throw error;
              } finally {
                if (read === 2) observed.pendingSettled = true;
              }
            },
            async return(): Promise<IteratorResult<unknown>> {
              const result = await iterator.return?.();
              observed.returnJoined = true;
              observed.returned.resolve();
              return result ?? { done: true, value: undefined };
            },
          };
        },
      };
    },
  );
  return observed;
}
