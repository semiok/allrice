import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import {
  DataAccessError,
  EmployeeInstanceError,
  IdentityError,
} from '@allrice/database';
import {
  DEntryRolloutPolicySchema,
  selectDEntryGeneration,
  type DEntryIdentity,
  type RequestContext,
} from '@allrice/contracts';
import { GET } from '../../app/api/v1/d-entry/identity/route';
import { POST } from '../../app/api/v1/d-entry/admission/route';
import { resolveDEntryIdentity } from '../d-entry/identity';
import {
  resolveDEntryAdmission,
  dEntryClientMount,
} from '../d-entry/admission';
import { DEntryDependencyUnavailable } from '../d-entry/release-policy';
import type * as ReleasePolicy from '../d-entry/release-policy';
import {
  authorizeDEntryNativeResource,
  followDEntryNativeResource,
  runDEntryNativeActivity,
  type DEntryNativeResource,
} from '../d-entry/native-resource';
import type {
  PersonVmAdmissionBoundary,
  PersonVmAdmissionPort,
  PersonVmBinding,
} from '@allrice/person-vm/admission';

const ports = vi.hoisted(() => ({
  context: vi.fn(),
  employee: vi.fn(),
  historyEmployee: vi.fn(),
  owner: vi.fn(),
  historyOwner: vi.fn(),
  generation: vi.fn(),
  policy: vi.fn(),
  writable: vi.fn(),
}));
vi.mock('./session', () => ({ requireRequestContext: ports.context }));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  resolveDEntryIdentity: (
    await original<typeof Database>()
  ).createDEntryIdentityResolver({
    getEmployeeInstance: ports.employee,
    getEmployeeInstanceForHistory: ports.historyEmployee,
    authorizeSessionOwner: ports.owner,
    authorizeSessionHistoryOwner: ports.historyOwner,
    requireCurrentWorkspaceWriteAuthority: ports.writable,
  }),
  getEmployeeInstance: ports.employee,
  getEmployeeInstanceForHistory: ports.historyEmployee,
  authorizeSessionOwner: ports.owner,
  authorizeSessionHistoryOwner: ports.historyOwner,
  getSessionExecutionGeneration: ports.generation,
  requireCurrentWorkspaceWriteAuthority: ports.writable,
}));
vi.mock('../d-entry/release-policy', async (original) => ({
  ...(await original<typeof ReleasePolicy>()),
  readDEntryReleasePolicy: ports.policy,
}));

const organizationId = randomUUID(),
  workspaceId = randomUUID(),
  personId = randomUUID();
const employeeInstanceId = randomUUID(),
  employeeVersionId = randomUUID(),
  threadId = randomUUID();
const context: RequestContext = {
  requestId: randomUUID(),
  sessionId: randomUUID(),
  actor: { type: 'user', id: personId },
  organizationId,
  workspaceId,
  memberships: [],
  authenticatedAt: new Date().toISOString(),
};
const identity: DEntryIdentity = {
  organizationId,
  workspaceId,
  personId,
  employeeInstanceId,
  employeeVersionId,
  employeeRevision: 1,
  threadId,
};
const employee = {
  id: employeeInstanceId,
  organizationId,
  workspaceId,
  ownerId: personId,
  revision: 1,
  source: { employeeVersionId },
};
const thread = {
  id: threadId,
  organizationId,
  workspaceId,
  ownerId: personId,
  employeeInstanceId,
  employeeAssignmentId: randomUUID(),
};
const selection = { workspaceId, employeeInstanceId, threadId };
const policy = {
  revision: 'approved-test-release',
  defaultGeneration: '3.x' as const,
  selections: [
    {
      organizationId,
      personId,
      employeeInstanceId,
      generation: '4.0' as const,
    },
  ],
};
function request(body?: unknown) {
  return new Request(
    `https://allrice.test/api/v1/d-entry/${body ? 'admission' : 'identity'}?${new URLSearchParams(selection)}`,
    {
      method: body ? 'POST' : 'GET',
      headers: { host: 'allrice.test', origin: 'https://allrice.test' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  ports.context.mockResolvedValue(context);
  ports.employee.mockResolvedValue(employee);
  ports.historyEmployee.mockResolvedValue(employee);
  ports.owner.mockResolvedValue(thread);
  ports.historyOwner.mockResolvedValue(thread);
  ports.generation.mockResolvedValue('4.0');
  ports.writable.mockResolvedValue(undefined);
  ports.policy.mockRejectedValue(
    new DEntryDependencyUnavailable('release-policy'),
  );
});

describe('trusted cookie D entry and explicit release selection', () => {
  it('requires current write authority for existing and new execution, while retaining history reads', async () => {
    ports.writable.mockRejectedValue(new IdentityError('authorization_denied'));
    await expect(
      resolveDEntryIdentity(context, selection, 'execute'),
    ).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    await expect(
      resolveDEntryIdentity(
        context,
        { workspaceId, employeeInstanceId },
        'execute',
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(ports.writable).toHaveBeenCalledTimes(2);
    await expect(
      resolveDEntryIdentity(context, selection, 'history'),
    ).resolves.toEqual(identity);
    expect(ports.writable).toHaveBeenCalledTimes(2);
  });
  it('requires a login before parsing selectors and ignores person headers', async () => {
    ports.context.mockRejectedValueOnce(
      new DataAccessError('authentication_required'),
    );
    expect((await GET(request())).status).toBe(401);
    expect(ports.employee).not.toHaveBeenCalled();
    const req = request();
    req.headers.set('x-allrice-person-id', randomUUID());
    const response = await GET(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ identity });
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('rejects forged identity fields, duplicate selectors and a different employee root', async () => {
    const forged = request();
    const url = new URL(forged.url);
    url.searchParams.set('personId', randomUUID());
    expect((await GET(new Request(url, forged))).status).toBe(400);
    url.searchParams.delete('personId');
    url.searchParams.append('threadId', threadId);
    expect((await GET(new Request(url, forged))).status).toBe(400);
    ports.historyOwner.mockResolvedValue({
      ...thread,
      employeeInstanceId: randomUUID(),
    });
    expect((await GET(request())).status).toBe(403);
    expect(ports.historyEmployee).not.toHaveBeenCalled();
  });
  it('preserves owner history while execute rechecks current employee assignment', async () => {
    ports.employee.mockRejectedValue(
      new EmployeeInstanceError('instance_archived'),
    );
    expect(await resolveDEntryIdentity(context, selection, 'history')).toEqual(
      identity,
    );
    await expect(
      resolveDEntryIdentity(context, selection, 'execute'),
    ).rejects.toMatchObject({ code: 'instance_archived' });
    expect((await POST(request(selection))).status).toBe(409);
    expect(ports.policy).not.toHaveBeenCalled();
  });
  it('rejects cross-workspace and current principal mismatches before returning identity', async () => {
    await expect(
      resolveDEntryIdentity(
        { ...context, workspaceId: randomUUID() },
        selection,
        'history',
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    ports.historyEmployee.mockResolvedValue({
      ...employee,
      ownerId: randomUUID(),
    });
    expect((await GET(request())).status).toBe(403);
  });
  it('requires explicit policy defaults and unique complete person/employee tuples', () => {
    expect(
      DEntryRolloutPolicySchema.safeParse({ selections: [] }).success,
    ).toBe(false);
    expect(
      DEntryRolloutPolicySchema.safeParse({
        ...policy,
        selections: [...policy.selections, ...policy.selections],
      }).success,
    ).toBe(false);
    expect(selectDEntryGeneration(policy, identity)).toBe('4.0');
    expect(
      selectDEntryGeneration(policy, { ...identity, personId: randomUUID() }),
    ).toBe('3.x');
    expect(
      selectDEntryGeneration(policy, {
        ...identity,
        employeeInstanceId: randomUUID(),
      }),
    ).toBe('3.x');
  });
  it('never changes an old thread writer and rejects unsupported 4.0 fallback', async () => {
    ports.generation.mockResolvedValue('3.x');
    expect(
      (await resolveDEntryAdmission(context, selection, policy))
        .executionGeneration,
    ).toBe('3.x');
    ports.generation.mockResolvedValue('4.0');
    await expect(
      resolveDEntryAdmission(context, selection, { ...policy, selections: [] }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });
  it('binds the real POST origin and reports missing configuration or route as unavailable', async () => {
    const foreign = request(selection);
    foreign.headers.set('origin', 'https://foreign.test');
    expect((await POST(foreign)).status).toBe(403);
    expect(ports.context).not.toHaveBeenCalled();
    const absentPolicy = await POST(request(selection));
    expect(absentPolicy.status).toBe(503);
    expect((await absentPolicy.json()).error.code).toBe(
      'DEPENDENCY_UNAVAILABLE',
    );
    ports.policy.mockResolvedValue(policy);
    const absentRoute = await POST(request(selection));
    expect(absentRoute.status).toBe(503);
    expect((await absentRoute.json()).error.code).toBe(
      'DEPENDENCY_UNAVAILABLE',
    );
  });
});

describe('4.0 native browser resource gate', () => {
  function fixture(child = true) {
    const revoked = new AbortController();
    const resource: DEntryNativeResource = {
      organizationId,
      personId,
      employeeInstanceId,
      threadId,
      nativeSessionId: child ? 'native-child' : 'native-root',
      rootNativeSessionId: 'native-root',
      parentNativeSessionId: child ? 'native-parent' : null,
      bindingRef: 'host-profile-epoch',
      revoked: revoked.signal,
    };
    const resolve = vi.fn(async () => resource);
    return {
      resource,
      revoked,
      resolve,
      input: {
        context,
        identity,
        nativeSessionId: resource.nativeSessionId,
        resources: { resolve },
        signal: new AbortController().signal,
      },
    };
  }
  // Consumer invocation double only; no producer/PG/physical-fence guarantee.
  function admission() {
    const binding: PersonVmBinding = {
      personId,
      organizationId,
      vmId: randomUUID(),
      instanceId: randomUUID(),
      leaseEpoch: 1,
    };
    const permit = {
      permitId: randomUUID(),
      binding,
      participant: 'entry' as const,
      disposition: 'queued' as const,
      signal: new AbortController().signal,
    };
    const boundary: PersonVmAdmissionBoundary = {
      admit: vi.fn(async () => permit),
      queued: async (_permit, operation, signal) => operation(signal),
      activate: async (_permit, operation, signal) => operation(signal),
      waitUntilReady: vi.fn(async () => binding),
      finish: vi.fn(async () => {}),
    };
    const participant: PersonVmAdmissionPort = {
      participant: 'entry',
      observe: vi.fn(),
      subscribe: vi.fn(),
      freeze: vi.fn(),
      assertFrozen: vi.fn(),
      thaw: vi.fn(),
    };
    return {
      admission: { boundary, participant },
      owner: {
        context,
        binding,
        operationId: randomUUID(),
        revoked: new AbortController().signal,
        assertCurrent: vi.fn(async () => {}),
        assertUndispatched: vi.fn(async () => {}),
        assertResource: vi.fn(async () => {}),
      },
    };
  }
  it('gates the VM-live hook with actual root authority while preserving cold history without a producer', async () => {
    ports.policy.mockResolvedValue(policy);
    const child = fixture(),
      host = admission(),
      acquire = vi.fn();
    await expect(
      runDEntryNativeActivity(
        { ...child.input, ...host, effect: 'write' },
        acquire,
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(host.admission.boundary.admit).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    const root = fixture(false),
      active = {
        run: vi.fn(async () => 'joined'),
        close: vi.fn(async () => {}),
      };
    await expect(
      runDEntryNativeActivity(
        { ...root.input, ...host, effect: 'write' },
        () => active,
      ),
    ).resolves.toBe('joined');
    expect(active.close).toHaveBeenCalledTimes(1);
    expect(host.admission.boundary.finish).toHaveBeenCalledTimes(1);
    // Cold read does not require a boundary or wake/prewarm capability.
    expect(
      await authorizeDEntryNativeResource({ ...child.input, effect: 'read' }),
    ).toBe(child.resource);
  });
  it('refuses acquire before any native initialization after the original root/profile changes', async () => {
    ports.policy.mockResolvedValue(policy);
    const f = fixture(false),
      host = admission();
    f.resolve
      .mockResolvedValueOnce(f.resource)
      .mockResolvedValueOnce(f.resource)
      .mockResolvedValue({ ...f.resource, bindingRef: 'replaced-host' });
    const active = {
        run: vi.fn(async () => 'must not dispatch'),
        close: vi.fn(async () => {}),
      },
      acquire = vi.fn(() => active);
    await expect(
      runDEntryNativeActivity(
        { ...f.input, ...host, effect: 'write' },
        acquire,
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(acquire).not.toHaveBeenCalled();
    expect(active.run).not.toHaveBeenCalled();
    expect(active.close).not.toHaveBeenCalled();
    expect(host.admission.boundary.finish).toHaveBeenCalledTimes(1);
    expect(host.admission.boundary.admit).toHaveBeenCalledTimes(1);
  });
  it('requires the actual envelope owner to bind this resource to its original native call before admission', async () => {
    ports.policy.mockResolvedValue(policy);
    const f = fixture(false),
      host = admission(),
      acquire = vi.fn();
    host.owner.assertResource.mockRejectedValue(
      new DataAccessError('authorization_denied'),
    );
    await expect(
      runDEntryNativeActivity(
        { ...f.input, ...host, effect: 'write' },
        acquire,
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(host.admission.boundary.admit).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });
  it('reads children through their root and blocks all browser write effects', async () => {
    ports.policy.mockResolvedValue(policy);
    const f = fixture();
    expect(
      await authorizeDEntryNativeResource({ ...f.input, effect: 'read' }),
    ).toBe(f.resource);
    // prompt/send/continue/edit/updateQueue/cancel are write effects from native
    // descriptors; there is no browser-supplied isChild or readOnly bypass.
    await expect(
      authorizeDEntryNativeResource({ ...f.input, effect: 'write' }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    const root = fixture(false);
    expect(
      await authorizeDEntryNativeResource({ ...root.input, effect: 'write' }),
    ).toBe(root.resource);
  });
  it('refuses wrong native owner, stale employee config, revoked leases and disabled writes', async () => {
    const f = fixture();
    f.resolve.mockResolvedValue({ ...f.resource, personId: randomUUID() });
    await expect(
      authorizeDEntryNativeResource({ ...f.input, effect: 'read' }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    f.resolve.mockResolvedValue(f.resource);
    await expect(
      authorizeDEntryNativeResource({
        ...f.input,
        identity: { ...identity, employeeRevision: 2 },
        effect: 'read',
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    f.revoked.abort();
    await expect(
      authorizeDEntryNativeResource({ ...f.input, effect: 'read' }),
    ).rejects.toThrow();
    ports.policy.mockResolvedValue({ ...policy, selections: [] });
    const root = fixture(false);
    await expect(
      authorizeDEntryNativeResource({ ...root.input, effect: 'write' }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });
  it('rechecks current authority for each chunk and closes the actual reader after revocation', async () => {
    const f = fixture();
    let closed = false;
    let readerSignal: AbortSignal | undefined;
    const stream = followDEntryNativeResource(
      f.input,
      async function* (_resource, signal) {
        readerSignal = signal;
        try {
          yield 'first';
          yield 'must not escape';
        } finally {
          closed = true;
        }
      },
    );
    expect(await stream.next()).toMatchObject({ value: 'first', done: false });
    ports.historyEmployee.mockRejectedValueOnce(
      new DataAccessError('authorization_denied'),
    );
    await expect(stream.next()).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    expect(readerSignal?.aborted).toBe(true);
    expect(closed).toBe(true);
  });
  it('aborts a stalled resource stream from the host revocation signal without polling', async () => {
    const f = fixture();
    let opened!: () => void;
    const started = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let closed = false;
    const stream = followDEntryNativeResource(
      f.input,
      async function* (_resource, signal) {
        try {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
            opened();
          });
          yield 'never';
        } finally {
          closed = true;
        }
      },
    );
    const next = stream.next();
    await started;
    f.revoked.abort();
    await expect(next).rejects.toThrow();
    expect(closed).toBe(true);
  });
  it('uses employee/config/host binding changes as the Client remount boundary', () => {
    const mount = dEntryClientMount(identity, '4.0', 'host-one');
    expect(
      dEntryClientMount(
        { ...identity, threadId: randomUUID() },
        '4.0',
        'host-one',
      ).remountKey,
    ).toBe(mount.remountKey);
    for (const changed of [
      dEntryClientMount(
        { ...identity, employeeInstanceId: randomUUID() },
        '4.0',
        'host-one',
      ),
      dEntryClientMount(
        { ...identity, employeeRevision: 2 },
        '4.0',
        'host-one',
      ),
      dEntryClientMount(identity, '4.0', 'host-two'),
      dEntryClientMount(identity, '3.x', 'host-one'),
    ])
      expect(changed.remountKey).not.toBe(mount.remountKey);
  });
});
