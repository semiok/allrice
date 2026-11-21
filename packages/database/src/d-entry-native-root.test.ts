import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DEntryIdentity, RequestContext } from '@allrice/contracts';
import {
  ensureDEntryNativeRoot,
  DEntryNativeRootStorageCloseError,
} from './d-entry-native-root.ts';

const source = vi.hoisted(() => ({
  identity: vi.fn(),
  read: vi.fn(),
  end: vi.fn(),
  query: vi.fn(),
}));
vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Client: class extends EventEmitter {
      connect = async () => {};
      query = source.query;
      end = source.end;
    },
  };
});
vi.mock('./d-entry.ts', () => ({
  requireDEntryNativeIdentity: source.identity,
}));
vi.mock('./core/client.ts', () => ({ getDatabase: () => source.read }));
vi.mock('./d-entry-release-policy.ts', () => ({
  readDEntryReleasePolicy: vi.fn(),
}));
vi.mock('./employees/employee-instances.ts', () => ({
  resolveEmployeeSessionInstance: vi.fn(),
}));
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
  actor: { type: 'user', id: identity.personId },
  organizationId: identity.organizationId,
  workspaceId: identity.workspaceId,
  requestId: randomUUID(),
  sessionId: randomUUID(),
  memberships: [],
  authenticatedAt: new Date().toISOString(),
};
const selection = {
  workspaceId: identity.workspaceId,
  employeeInstanceId: identity.employeeInstanceId,
  threadId: identity.threadId,
};
const pin = {
  schemaVersion: 1,
  identity,
  nativeSessionId: 'actual-existing-native-root',
  operationId: randomUUID(),
  releaseRevision: 'published',
  host: {
    binding: {
      organizationId: identity.organizationId,
      personId: identity.personId,
      vmId: randomUUID(),
      instanceId: randomUUID(),
      leaseEpoch: 1,
    },
    bindingRef: 'birth-owner',
    rosterDigest: 'birth-profile-roster',
  },
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgres://driver-double.invalid/not-connected');
  source.identity.mockReset().mockResolvedValue(identity);
  source.read.mockReset().mockResolvedValue([{ d_entry_native_root: pin }]);
  source.query.mockReset().mockResolvedValue({ rows: [{ held: true }] });
  source.end.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('root storage gate owned close (driver/store doubles, not PG/VM evidence)', () => {
  it('retains the actual connection close promise and never recreates an existing root', async () => {
    const closing = deferred(),
      closed = deferred(),
      create = vi.fn(async () => ({
        nativeSessionId: pin.nativeSessionId,
        host: pin.host,
      }));
    source.end.mockImplementationOnce(async () => {
      closing.resolve();
      await closed.promise;
    });
    let settled = false;
    const result = ensureDEntryNativeRoot(context, selection, identity, {
      operationId: randomUUID(),
      host: pin.host,
      signal: new AbortController().signal,
      create,
    });
    void result.then(() => {
      settled = true;
    });
    await closing.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(create).not.toHaveBeenCalled();
    closed.resolve();
    expect(await result).toMatchObject({
      rootNativeSessionId: pin.nativeSessionId,
      rootBindingRef: pin.operationId,
    });
    expect(source.end).toHaveBeenCalledTimes(1);
  });

  it('marks failed storage close as unknown for the outer admitted owner, preserving the actual error', async () => {
    const cleanup = Error('storage gate end unknown');
    source.end.mockRejectedValueOnce(cleanup);
    const result = ensureDEntryNativeRoot(context, selection, identity, {
      operationId: randomUUID(),
      host: pin.host,
      signal: new AbortController().signal,
      create: vi.fn(async () => ({
        nativeSessionId: pin.nativeSessionId,
        host: pin.host,
      })),
    });
    await expect(result).rejects.toBeInstanceOf(
      DEntryNativeRootStorageCloseError,
    );
    await expect(result).rejects.toMatchObject({
      cause: cleanup,
      errors: [cleanup],
    });
  });

  it('preserves both a business failure and unknown gate close without calling native create', async () => {
    const business = Error('current root read failed'),
      cleanup = Error('gate close unknown');
    source.read.mockRejectedValueOnce(business);
    source.end.mockRejectedValueOnce(cleanup);
    const create = vi.fn(async () => ({
      nativeSessionId: pin.nativeSessionId,
      host: pin.host,
    }));
    await expect(
      ensureDEntryNativeRoot(context, selection, identity, {
        operationId: randomUUID(),
        host: pin.host,
        signal: new AbortController().signal,
        create,
      }),
    ).rejects.toMatchObject({ cause: business, errors: [business, cleanup] });
    expect(create).not.toHaveBeenCalled();
  });
});
