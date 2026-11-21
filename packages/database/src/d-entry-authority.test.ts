import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DEntryIdentity, RequestContext } from '@allrice/contracts';
import {
  createDEntryAuthorityFeed,
  watchDEntryNativeAuthority,
} from './d-entry-authority.ts';

type ClientDouble = EventEmitter & {
  connect: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};
const state = vi.hoisted(() => ({
  clients: [] as ClientDouble[],
  identity: vi.fn(),
  read: vi.fn(),
}));
vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Client: class extends EventEmitter {
      constructor() {
        super();
        state.clients.push(this);
      }
      connect = vi.fn(async () => {});
      query = vi.fn(async () => {});
      end = vi.fn(async () => {
        this.emit('end');
      });
    },
  };
});
vi.mock('./core/client.ts', () => ({
  getDatabase: () => state.read,
  registerDatabaseCloseHook: vi.fn(),
}));
vi.mock('./d-entry.ts', () => ({
  requireDEntryNativeIdentity: state.identity,
}));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const identity: DEntryIdentity = {
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
  personId: randomUUID(),
  employeeInstanceId: randomUUID(),
  employeeRevision: 1,
  employeeVersionId: randomUUID(),
  threadId: randomUUID(),
};
const context: RequestContext = {
  requestId: randomUUID(),
  sessionId: randomUUID(),
  actor: { type: 'user', id: identity.personId },
  organizationId: identity.organizationId,
  workspaceId: identity.workspaceId,
  memberships: [],
  authenticatedAt: new Date().toISOString(),
};
const selection = {
  workspaceId: identity.workspaceId,
  employeeInstanceId: identity.employeeInstanceId,
  threadId: identity.threadId,
};
const feeds: ReturnType<typeof createDEntryAuthorityFeed>[] = [];
beforeEach(() => {
  state.clients = [];
  state.identity.mockReset().mockResolvedValue(identity);
  state.read
    .mockReset()
    .mockResolvedValue([
      { schema: 'isolated', expires_at: new Date(Date.now() + 60_000) },
    ]);
});
afterEach(async () => {
  for (const feed of feeds.splice(0)) await feed.close();
});
const feed = () => {
  const value = createDEntryAuthorityFeed(
    'postgres://test.invalid/not-connected',
  );
  feeds.push(value);
  return value;
};

describe('authority subscription lifecycle (driver double; not PG commit proof)', () => {
  it('LISTENs before rechecking and joins an in-flight notification recheck when closing the subscription', async () => {
    const source = feed();
    const watch = await watchDEntryNativeAuthority(
      context,
      selection,
      identity,
      new AbortController().signal,
      source,
    );
    const client = state.clients[0]!;
    expect(client.query).toHaveBeenCalledWith(
      'LISTEN allrice_d_entry_authority',
    );
    expect(client.query.mock.invocationCallOrder[0]).toBeLessThan(
      state.identity.mock.invocationCallOrder[0]!,
    );
    const entered = deferred(),
      settle = deferred();
    state.identity.mockImplementationOnce(async () => {
      entered.resolve();
      await settle.promise;
      return identity;
    });
    client.emit('notification', {
      channel: 'allrice_d_entry_authority',
      payload: JSON.stringify({
        schema: 'isolated',
        table: 'allrice_memberships',
        id: randomUUID(),
        organizationId: identity.organizationId,
        workspaceId: identity.workspaceId,
        personId: identity.personId,
      }),
    });
    await entered.promise;
    let joined = false;
    const closing = watch.close().then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    settle.resolve();
    await closing;
    expect(watch.revoked.aborted).toBe(false); // A hint does not itself revoke.
    const before = state.identity.mock.calls.length;
    client.emit('notification', {
      channel: 'allrice_d_entry_authority',
      payload: '{}',
    });
    await Promise.resolve();
    expect(state.identity).toHaveBeenCalledTimes(before);
  });

  it('aborts idle subscribers immediately on driver error and awaits the actual connection end promise', async () => {
    const source = feed(),
      watch = await watchDEntryNativeAuthority(
        context,
        selection,
        identity,
        new AbortController().signal,
        source,
      );
    const client = state.clients[0]!,
      ended = deferred(),
      failure = Error('notification connection lost');
    client.end.mockImplementationOnce(async () => {
      await ended.promise;
      client.emit('end');
    });
    client.emit('error', failure);
    expect(watch.revoked.reason).toBe(failure);
    let closed = false;
    const closing = source.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    ended.resolve();
    await closing;
    await watch.close();
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('fails setup when current rights change after LISTEN and never caches permission from the notification payload', async () => {
    const source = feed(),
      denied = Error('current SQL authority denied');
    state.identity.mockRejectedValueOnce(denied);
    await expect(
      watchDEntryNativeAuthority(
        context,
        selection,
        identity,
        new AbortController().signal,
        source,
      ),
    ).rejects.toBe(denied);
    expect(state.read).not.toHaveBeenCalled();
  });
});
