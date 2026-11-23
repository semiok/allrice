/** Real H1 operation owner; DB boundary and VM effect are explicit fixture doubles. */
import type * as Database from '@allrice/database';
import { DataAccessError } from '@allrice/database';
import {
  PersonVmError,
  type PersonVmPort,
  type PersonVmView,
} from '@allrice/person-vm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setImmediate as turn } from 'node:timers/promises';
import {
  deferred,
  nativeEntryFixture,
} from '../d-entry/native-entry.fixture.js';
import { createDEntryNativePrewarmPort } from '../business-runtime/native-prewarm.js';
import { createProductionPersonVmAuthority } from './production-authority.js';
import { createProductionCurrentPrewarm } from './production-prewarm.js';

const source = vi.hoisted(() => ({ identity: vi.fn(), principal: vi.fn() }));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  requireDEntryNativeIdentity: source.identity,
  readContentPrincipal: source.principal,
}));
const owners: ReturnType<typeof createProductionPersonVmAuthority>[] = [];
const signal = () => new AbortController().signal;
beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  vi.restoreAllMocks();
});
function fixture() {
  const base = nativeEntryFixture(),
    current = createProductionPersonVmAuthority();
  owners.push(current);
  const view: PersonVmView = {
    vmId: base.binding.vmId,
    personId: base.identity.personId,
    organizationId: base.identity.organizationId,
    phase: 'running',
    ready: true,
    diskRetained: true,
    lastActivityAt: '2026-11-22T00:00:00Z',
  };
  source.identity.mockResolvedValue(base.identity);
  source.principal.mockResolvedValue({
    userId: base.identity.personId,
    organizationId: base.identity.organizationId,
    writable: true,
  });
  const vm = {
    prewarm: vi.fn<PersonVmPort['prewarm']>(async (context, _input, active) => {
      // A VM sharing this owner can authorize within the actual operation scope.
      await current.authority.authorize(context, 'start', active);
      return view;
    }),
  };
  const prewarm = createProductionCurrentPrewarm({ vm, current });
  const invoke = (active = signal()) =>
    prewarm(base.context, base.identity, { trigger: 'page' }, active);
  return { base, current, vm, prewarm, invoke, view };
}

it('carries the exact current selection through the real H1 scope to the shared VM and rechecks each request', async () => {
  const f = fixture(),
    active = signal();
  expect(await f.invoke(active)).toBe(f.view);
  expect(f.vm.prewarm).toHaveBeenCalledExactlyOnceWith(
    f.base.context,
    { trigger: 'page' },
    active,
  );
  expect(source.identity).toHaveBeenCalledTimes(3);
  expect(source.principal).toHaveBeenCalledTimes(3);
  await f.invoke();
  expect(source.identity).toHaveBeenCalledTimes(6);
  expect(source.principal).toHaveBeenCalledTimes(6);
});

it('rejects stale selection before any VM effect and preserves a later valid request', async () => {
  const f = fixture();
  source.identity.mockResolvedValueOnce({
    ...f.base.identity,
    employeeRevision: 2,
  });
  await expect(f.invoke()).rejects.toBeInstanceOf(DataAccessError);
  expect(f.vm.prewarm).not.toHaveBeenCalled();
  expect(await f.invoke()).toBe(f.view);
  expect(f.vm.prewarm).toHaveBeenCalledOnce();
});

it('discards a completed VM result when current authority changes during it', async () => {
  const f = fixture();
  let completed = false;
  f.vm.prewarm.mockImplementationOnce(async () => {
    source.identity.mockResolvedValue({
      ...f.base.identity,
      employeeRevision: 2,
    });
    completed = true;
    return f.view;
  });
  await expect(f.invoke()).rejects.toMatchObject({
    code: 'authorization_denied',
  });
  expect(completed).toBe(true);
  source.identity.mockResolvedValue(f.base.identity);
  expect(await f.invoke()).toBe(f.view);
});

it('does not rewrite actual non-authority VM failures', async () => {
  const f = fixture(),
    reason = new PersonVmError('EGRESS_UNAVAILABLE');
  f.vm.prewarm.mockRejectedValueOnce(reason);
  await expect(f.invoke()).rejects.toBe(reason);
});

it.each(['abort', 'close'] as const)(
  '%s while the actual callback is pending joins it before rejecting',
  async (action) => {
    const f = fixture(),
      entered = deferred<void>(),
      release = deferred<void>();
    const abort = new AbortController(),
      reason = new Error('physical revocation');
    f.vm.prewarm.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return f.view;
    });
    let settled = false;
    const outcome = f
      .invoke(abort.signal)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      if (action === 'close') closing = f.current.close();
      else abort.abort(reason);
      await turn();
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      await outcome;
      await closing;
    }
    if (action === 'abort') expect(await outcome).toBe(reason);
    else expect(await outcome).toMatchObject({ code: 'RUNTIME_NOT_READY' });
  },
);

it('the existing prewarm port consumes the named production callback with exact server identity', async () => {
  const f = fixture(),
    lifetime = new AbortController();
  const assembly = createDEntryNativePrewarmPort({
    prewarmCurrent: f.prewarm,
    lifetime: lifetime.signal,
  });
  try {
    await assembly.port.prewarm(
      f.base.context,
      f.base.identity,
      'input',
      signal(),
      signal(),
    );
    expect(f.vm.prewarm).toHaveBeenCalledOnce();
    expect(f.vm.prewarm.mock.calls[0]![1]).toEqual({ trigger: 'input' });
    expect(source.identity).toHaveBeenCalledTimes(5);
  } finally {
    await assembly.close();
  }
});
