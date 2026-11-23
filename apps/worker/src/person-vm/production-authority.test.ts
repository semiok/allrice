/** Explicit source doubles; the companion PG file exercises the real owners. */
import { setImmediate as turn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DEntryIdentity, RequestContext } from '@allrice/contracts';

const source = vi.hoisted(() => ({ principal: vi.fn(), native: vi.fn() }));
vi.mock('@allrice/database', () => ({
  readContentPrincipal: source.principal,
  requireDEntryNativeIdentity: source.native,
}));
import { createProductionPersonVmAuthority } from './production-authority.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context: RequestContext = {
  requestId: id(1),
  sessionId: id(2),
  actor: { type: 'user', id: id(3) },
  organizationId: id(4),
  workspaceId: id(5),
  memberships: [],
  authenticatedAt: '2026-11-22T00:00:00Z',
};
const identity: DEntryIdentity = {
  organizationId: id(4),
  workspaceId: id(5),
  personId: id(3),
  employeeInstanceId: id(6),
  employeeRevision: 2,
  employeeVersionId: id(7),
  threadId: null,
};
const principal = (rc = context) => ({
  userId: rc.actor.id,
  organizationId: rc.organizationId,
  departmentId: null,
  maintenanceLevel: 'personal',
  writable: true,
});
const signal = () => new AbortController().signal;
const owners: ReturnType<typeof createProductionPersonVmAuthority>[] = [];
const owner = () => {
  const value = createProductionPersonVmAuthority();
  owners.push(value);
  return value;
};
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  source.principal.mockImplementation(async (rc: RequestContext) =>
    principal(rc),
  );
  source.native.mockResolvedValue(identity);
});
afterEach(async () => {
  await Promise.all(owners.splice(0).map((value) => value.close()));
});

describe('production person VM authority', () => {
  it('reads current self metadata without rollout, selector, B or VM readiness', async () => {
    source.principal.mockResolvedValue({ ...principal(), writable: false });
    await expect(
      owner().authority.authorize(context, 'read', signal()),
    ).resolves.toEqual({
      personId: context.actor.id,
      organizationId: context.organizationId,
    });
    expect(source.principal).toHaveBeenCalledWith(context);
    expect(source.native).not.toHaveBeenCalled();
  });
  it('reads the original principal again instead of trusting old memberships', async () => {
    const vm = owner();
    await vm.authority.authorize(context, 'read', signal());
    source.principal.mockResolvedValue(null);
    await expect(
      vm.authority.authorize(context, 'read', signal()),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    expect(source.principal).toHaveBeenCalledTimes(2);
  });
  it.each(['create', 'start'] as const)(
    'denies %s without an operation selector before source I/O',
    async (action) => {
      await expect(
        owner().authority.authorize(context, action, signal()),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
      expect(source.native).not.toHaveBeenCalled();
      expect(source.principal).not.toHaveBeenCalled();
    },
  );
  it.each(['stop', 'delete', 'delete-disk'] as const)(
    'does not invent %s permission from metadata read',
    async (action) => {
      await expect(
        owner().authority.authorize(context, action, signal()),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
      expect(source.native).not.toHaveBeenCalled();
      expect(source.principal).not.toHaveBeenCalled();
    },
  );
  it('rechecks original current authority for each create/start callback', async () => {
    const vm = owner();
    await vm.withCurrentSelection(context, identity, signal(), async () => {
      for (const action of ['create', 'start'] as const) {
        const before = source.native.mock.calls.length;
        await expect(
          vm.authority.authorize(context, action, signal()),
        ).resolves.toEqual({
          personId: identity.personId,
          organizationId: identity.organizationId,
        });
        expect(source.native.mock.calls.length).toBe(before + 1);
      }
    });
    expect(source.native).toHaveBeenCalledWith(context, {
      workspaceId: id(5),
      employeeInstanceId: id(6),
    });
  });
  it('keeps the original gate error and never invokes work when rollout denies', async () => {
    const denied = Object.assign(Error('original current denial'), {
      code: 'authorization_denied',
    });
    source.native.mockRejectedValue(denied);
    const work = vi.fn();
    await expect(
      owner().withCurrentSelection(context, identity, signal(), work),
    ).rejects.toBe(denied);
    expect(work).not.toHaveBeenCalled();
  });
  it('discards a result when the original employee revision changed', async () => {
    const vm = owner();
    const work = vi.fn(async () => {
      source.native.mockResolvedValue({
        ...identity,
        employeeRevision: identity.employeeRevision + 1,
      });
      return 'private result';
    });
    await expect(
      vm.withCurrentSelection(context, identity, signal(), work),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    expect(work).toHaveBeenCalledOnce();
  });
  it('checks the real principal after the asynchronous rollout read', async () => {
    source.native.mockImplementation(async () => {
      source.principal.mockResolvedValue({ ...principal(), writable: false });
      return identity;
    });
    const work = vi.fn();
    await expect(
      owner().withCurrentSelection(context, identity, signal(), work),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    expect(work).not.toHaveBeenCalled();
  });
  it.each([
    { label: 'person', expected: { ...identity, personId: id(20) } },
    {
      label: 'organization',
      expected: { ...identity, organizationId: id(20) },
    },
    { label: 'workspace', expected: { ...identity, workspaceId: id(20) } },
  ])(
    'rejects a foreign $label selector before source I/O',
    async ({ expected }) => {
      await expect(
        owner().withCurrentSelection(context, expected, signal(), vi.fn()),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
      expect(source.native).not.toHaveBeenCalled();
    },
  );
  it('cannot use one session operation to authorize another current session', async () => {
    const vm = owner();
    await vm.withCurrentSelection(context, identity, signal(), async () => {
      const before = source.native.mock.calls.length;
      await expect(
        vm.authority.authorize(
          { ...context, sessionId: id(99) },
          'start',
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
      expect(source.native.mock.calls.length).toBe(before);
    });
  });
  it('isolates simultaneous selectors and snapshots caller-owned identity values', async () => {
    const vm = owner(),
      entered = gate(),
      release = gate();
    const expected = { ...identity };
    const second = { ...identity, employeeInstanceId: id(30) };
    source.native.mockImplementation(async (_rc, selection) =>
      selection.employeeInstanceId === second.employeeInstanceId
        ? second
        : identity,
    );
    const first = vm.withCurrentSelection(
      context,
      expected,
      signal(),
      async () => {
        entered.resolve();
        await release.promise;
        return vm.authority.authorize(context, 'start', signal());
      },
    );
    try {
      await entered.promise;
      expected.employeeRevision = 100;
      await vm.withCurrentSelection(context, second, signal(), async () => {
        await vm.authority.authorize(context, 'create', signal());
      });
    } finally {
      release.resolve();
      await first;
    }
  });
  it('closes an escaped operation selector rather than retaining a permit', async () => {
    const vm = owner(),
      release = gate();
    let escaped: Promise<unknown> | undefined;
    await vm.withCurrentSelection(context, identity, signal(), async () => {
      escaped = release.promise.then(() =>
        vm.authority.authorize(context, 'start', signal()),
      );
    });
    const before = source.native.mock.calls.length;
    release.resolve();
    await expect(escaped).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    });
    expect(source.native.mock.calls.length).toBe(before);
  });
  it('joins the actual work after cancellation and never discloses its result', async () => {
    const vm = owner(),
      entered = gate(),
      release = gate(),
      abort = new AbortController();
    const reason = Error('cancelled operation');
    let settled = false;
    const outcome = vm
      .withCurrentSelection(context, identity, abort.signal, async () => {
        entered.resolve();
        await release.promise;
        return 'private';
      })
      .then(
        () => {
          settled = true;
          return null;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
    try {
      await entered.promise;
      abort.abort(reason);
      await turn();
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      expect(await outcome).toBe(reason);
    }
  });
  it('close fences admission and joins an already-started principal read', async () => {
    const vm = owner(),
      entered = gate(),
      release = gate();
    let closed = false;
    source.principal.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return principal();
    });
    const outcome = vm.authority
      .authorize(context, 'read', signal())
      .catch((error: unknown) => error);
    await entered.promise;
    const closing = vm.close().then(() => {
      closed = true;
    });
    try {
      await turn();
      expect(closed).toBe(false);
      await expect(
        vm.authority.authorize(context, 'read', signal()),
      ).rejects.toMatchObject({ code: 'RUNTIME_NOT_READY' });
    } finally {
      release.resolve();
      await outcome;
      await closing;
    }
    expect(closed).toBe(true);
    await expect(outcome).resolves.toMatchObject({ code: 'RUNTIME_NOT_READY' });
  });
  it('preserves a selected thread in each original 271 check', async () => {
    const expected = { ...identity, threadId: id(40) };
    source.native.mockResolvedValue(expected);
    await owner().withCurrentSelection(
      context,
      expected,
      signal(),
      async () => {},
    );
    expect(source.native).toHaveBeenCalledWith(context, {
      workspaceId: id(5),
      employeeInstanceId: id(6),
      threadId: id(40),
    });
  });
});
