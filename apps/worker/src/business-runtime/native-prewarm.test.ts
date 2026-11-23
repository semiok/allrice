import { randomUUID } from 'node:crypto';
import type { CurrentSelectionPrewarm } from '../person-vm/production-prewarm.js';
import { afterEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { DataAccessError } from '@allrice/database';
import { harness } from '../../../../packages/person-vm/src/test-support.ts';
import {
  deferred,
  nativeEntryFixture,
  nativeEntryServer,
} from '../d-entry/native-entry.fixture.js';
import {
  dEntryNativePrewarmPort,
  installDEntryNativePrewarmPort,
} from '../d-entry/native-prewarm.js';
import {
  dEntryNativeOwnerPort,
  DEntryNativeUnavailable,
} from '../d-entry/native-owner.js';
import {
  createDEntryNativePrewarmPort,
  installAssignedDEntryNativeRuntime,
  installDEntryNativePrewarm,
} from './native-prewarm.js';

const authority = vi.hoisted(() => ({ identity: vi.fn() }));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  requireDEntryNativeIdentity: authority.identity,
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
function fixture() {
  // Actual lifecycle service with synthetic disk/native/runtime providers only.
  // No production installation, Host process, VM or performance claim.
  const base = nativeEntryFixture(),
    h = harness(),
    lifetime = new AbortController(),
    runPrewarm = h.service.prewarm.bind(h.service),
    vm = vi.spyOn(h.service, 'prewarm'),
    start = vi.spyOn(h.runtime, 'start'),
    stop = vi.spyOn(h.native, 'stop');
  authority.identity.mockResolvedValue(base.identity);
  // Explicit fixture adapter; production must use the shared H1 authority owner.
  const prewarmCurrent: CurrentSelectionPrewarm = (...args) =>
    h.service.prewarm(args[0], args[2], args[3]);
  const assembly = createDEntryNativePrewarmPort({
    prewarmCurrent,
    lifetime: lifetime.signal,
  });
  cleanups.push(assembly.close);
  return {
    base,
    h,
    lifetime,
    runPrewarm,
    vm,
    start,
    stop,
    assembly,
    prewarmCurrent,
  };
}
const signal = () => new AbortController().signal;

it('page then input uses each current RC and the same running VM without another runtime start', async () => {
  const f = fixture(),
    current = {
      ...f.base.context,
      requestId: randomUUID(),
      sessionId: randomUUID(),
    };
  await f.assembly.port.prewarm(
    f.base.context,
    f.base.identity,
    'page',
    signal(),
    f.lifetime.signal,
  );
  const first = await f.h.service.resolve(f.base.context, signal());
  await f.assembly.port.prewarm(
    current,
    f.base.identity,
    'input',
    signal(),
    f.lifetime.signal,
  );
  expect(await f.h.service.resolve(current, signal())).toEqual(first);
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.h.log.filter((item) => item === 'native:create')).toHaveLength(1);
  expect(authority.identity.mock.calls.map(([context]) => context)).toEqual([
    f.base.context,
    f.base.context,
    current,
    current,
  ]);
  expect(f.vm.mock.calls.map(([, input]) => input)).toEqual([
    { trigger: 'page' },
    { trigger: 'input' },
  ]);
  expect(f.stop).not.toHaveBeenCalled();
});

it('concurrent page/input cannot acquire a second lifecycle owner, and later valid input reuses the completed epoch', async () => {
  const f = fixture();
  const results = await Promise.allSettled([
    f.assembly.port.prewarm(
      f.base.context,
      f.base.identity,
      'page',
      signal(),
      f.lifetime.signal,
    ),
    f.assembly.port.prewarm(
      f.base.context,
      f.base.identity,
      'input',
      signal(),
      f.lifetime.signal,
    ),
  ]);
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toEqual([
    expect.objectContaining({
      reason: expect.objectContaining({ code: 'LEASE_CONFLICT' }),
    }),
  ]);
  await f.assembly.port.prewarm(
    f.base.context,
    f.base.identity,
    'input',
    signal(),
    f.lifetime.signal,
  );
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.h.log.filter((item) => item === 'native:create')).toHaveLength(1);
  expect(f.stop).not.toHaveBeenCalled();
});

it('current authority rejects before any VM call, and post-start denial does not stop shared running work', async () => {
  const f = fixture();
  authority.identity.mockRejectedValueOnce(
    new DataAccessError('authorization_denied'),
  );
  await expect(
    f.assembly.port.prewarm(
      f.base.context,
      f.base.identity,
      'page',
      signal(),
      f.lifetime.signal,
    ),
  ).rejects.toThrow();
  expect(f.vm).not.toHaveBeenCalled();
  const original = f.runPrewarm;
  f.vm.mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    authority.identity.mockResolvedValue({
      ...f.base.identity,
      employeeRevision: 2,
    });
    return result;
  });
  await expect(
    f.assembly.port.prewarm(
      f.base.context,
      f.base.identity,
      'page',
      signal(),
      f.lifetime.signal,
    ),
  ).rejects.toMatchObject({ code: 'authorization_denied' });
  expect(f.stop).not.toHaveBeenCalled();
  authority.identity.mockResolvedValue(f.base.identity);
  await f.assembly.port.prewarm(
    f.base.context,
    f.base.identity,
    'input',
    signal(),
    f.lifetime.signal,
  );
  expect(f.start).toHaveBeenCalledTimes(1);
});

it('a cancelled request joins its actual prewarm and leaves a later valid request usable', async () => {
  const f = fixture(),
    caller = new AbortController(),
    started = deferred<void>(),
    finish = deferred<void>(),
    original = f.runPrewarm;
  f.vm.mockImplementationOnce(async (...args) => {
    started.resolve();
    await finish.promise;
    expect(args[2]).not.toBe(caller.signal);
    expect(args[2].aborted).toBe(false);
    return original(...args);
  });
  let ended = false;
  const cancelled = new Error('browser left');
  const work = f.assembly.port
    .prewarm(
      f.base.context,
      f.base.identity,
      'page',
      caller.signal,
      f.lifetime.signal,
    )
    .catch((error: unknown) => error)
    .finally(() => {
      ended = true;
    });
  await started.promise;
  try {
    caller.abort(cancelled);
    expect(ended).toBe(false);
  } finally {
    finish.resolve();
  }
  expect(await work).toBe(cancelled);
  await f.assembly.port.prewarm(
    f.base.context,
    f.base.identity,
    'input',
    signal(),
    f.lifetime.signal,
  );
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.stop).not.toHaveBeenCalled();
});

it('uninstallation closes admission immediately and joins actual work without aborting the VM lifetime', async () => {
  const f = fixture(),
    started = deferred<void>(),
    finish = deferred<void>(),
    original = f.runPrewarm;
  const installed = installDEntryNativePrewarm({
    prewarmCurrent: f.prewarmCurrent,
    lifetime: f.lifetime.signal,
  });
  cleanups.push(installed.close);
  f.vm.mockImplementationOnce(async (...args) => {
    started.resolve();
    await finish.promise;
    return original(...args);
  });
  const work = dEntryNativePrewarmPort
    .prewarm(
      f.base.context,
      f.base.identity,
      'page',
      signal(),
      f.lifetime.signal,
    )
    .catch((error: unknown) => error);
  await started.promise;
  let ended = false;
  const closing = installed.close().then(() => {
    ended = true;
  });
  try {
    expect(() =>
      dEntryNativePrewarmPort.prewarm(
        f.base.context,
        f.base.identity,
        'input',
        signal(),
        f.lifetime.signal,
      ),
    ).toThrow(DEntryNativeUnavailable);
    expect(ended).toBe(false);
    expect(f.lifetime.signal.aborted).toBe(false);
  } finally {
    finish.resolve();
  }
  expect(await work).toBeInstanceOf(DEntryNativeUnavailable);
  await closing;
  expect(f.stop).not.toHaveBeenCalled();
});

it('the real Worker listener requires current release eligibility and the installed prewarm port, without resolving catalog/data', async () => {
  const f = fixture();
  const server = await nativeEntryServer(f.base, {
    ...f.base.deps,
    owners: dEntryNativeOwnerPort,
    data: () => undefined,
  });
  cleanups.push(server.close);
  const body = { ...f.base.body, trigger: 'page' };
  expect((await server.request('native-prewarm', body)).status).toBe(503);
  expect(f.vm).not.toHaveBeenCalled();
  const installed = installDEntryNativePrewarm({
    prewarmCurrent: f.prewarmCurrent,
    lifetime: f.lifetime.signal,
  });
  cleanups.push(installed.close);
  f.base.deps.identity.mockRejectedValueOnce(
    new DataAccessError('authorization_denied'),
  );
  expect((await server.request('native-prewarm', body)).status).toBe(404);
  expect(f.vm).not.toHaveBeenCalled();
  for (const invalid of [
    { ...body, personId: randomUUID() },
    { ...body, trigger: 'send' },
  ])
    expect((await server.request('native-prewarm', invalid)).status).toBe(400);
  const response = await server.request('native-prewarm', body);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    identity: f.base.identity,
    trigger: 'page',
  });
  expect(f.base.deps.owners.resolve).not.toHaveBeenCalled();
  expect(f.base.data.acquireRoot).not.toHaveBeenCalled();
  expect(f.base.data.acquireRpc).not.toHaveBeenCalled();
  expect((await server.request()).status).toBe(503);
  expect((await server.request('native-root')).status).toBe(503);
  expect(f.start).toHaveBeenCalledTimes(1);
});

it('browser disconnect through real HTTP does not cancel shared physical startup or close its authority watcher early', async () => {
  const f = fixture(),
    started = deferred<void>(),
    finish = deferred<void>(),
    disconnected = deferred<void>(),
    caller = new AbortController(),
    original = f.runPrewarm;
  const installed = installDEntryNativePrewarm({
    prewarmCurrent: f.prewarmCurrent,
    lifetime: f.lifetime.signal,
  });
  cleanups.push(installed.close);
  let physical: AbortSignal | undefined,
    completion: Promise<unknown> | undefined;
  const delegate = dEntryNativePrewarmPort.prewarm;
  vi.spyOn(dEntryNativePrewarmPort, 'prewarm').mockImplementation((...args) => {
    args[3].addEventListener('abort', () => disconnected.resolve(), {
      once: true,
    });
    const task = delegate(...args);
    completion = task.catch((error: unknown) => error);
    return task;
  });
  const watch = vi.fn<typeof Database.watchDEntryNativeAuthority>(
    async (...args) => {
      const subscription = await f.base.deps.watch();
      return {
        ...subscription,
        revoked: AbortSignal.any([subscription.revoked, args[3]]),
      };
    },
  );
  f.vm.mockImplementationOnce(async (...args) => {
    physical = args[2];
    started.resolve();
    await finish.promise;
    expect(args[2].aborted).toBe(false);
    return original(...args);
  });
  const server = await nativeEntryServer(f.base, { ...f.base.deps, watch });
  cleanups.push(server.close);
  const request = fetch(`${server.origin}/internal/d-entry/native-prewarm`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer original_session_opaque_token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ...f.base.body, trigger: 'page' }),
    signal: caller.signal,
  }).catch((error: unknown) => error);
  await started.promise;
  try {
    caller.abort();
    expect(await request).toBeInstanceOf(Error);
    await disconnected.promise;
    expect(watch.mock.calls[0]![3].aborted).toBe(false);
    expect(physical?.aborted).toBe(false);
    expect(f.base.authorityClose).not.toHaveBeenCalled();
  } finally {
    finish.resolve();
  }
  expect(completion).toBeDefined();
  expect(await completion).toBeInstanceOf(Error);
  await server.close();
  expect(f.base.authorityClose).toHaveBeenCalledTimes(1);
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.stop).not.toHaveBeenCalled();
});

it('genuine current-authority revocation still reaches physical prewarm without treating browser cancellation as authority', async () => {
  const f = fixture(),
    revoked = new AbortController(),
    started = deferred<void>(),
    finish = deferred<void>(),
    original = f.runPrewarm;
  let physical: AbortSignal | undefined;
  f.vm.mockImplementationOnce(async (...args) => {
    physical = args[2];
    started.resolve();
    await finish.promise;
    return original(...args);
  });
  const failure = new DataAccessError('authorization_denied');
  const work = f.assembly.port
    .prewarm(f.base.context, f.base.identity, 'page', signal(), revoked.signal)
    .catch((error: unknown) => error);
  await started.promise;
  try {
    revoked.abort(failure);
    expect(physical?.aborted).toBe(true);
  } finally {
    finish.resolve();
  }
  expect(await work).toBe(failure);
  expect(f.start).not.toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
});

it('combined production API rolls back its new catalog registration when prewarm registration already has an owner', async () => {
  const f = fixture(),
    uninstall = installDEntryNativePrewarmPort(f.assembly.port);
  cleanups.push(async () => uninstall());
  expect(() =>
    installAssignedDEntryNativeRuntime({
      vm: f.h.service,
      prewarmCurrent: f.prewarmCurrent,
      lifetime: f.lifetime.signal,
      startup: {
        catalog: () => {
          throw new DEntryNativeUnavailable();
        },
      },
    }),
  ).toThrow(DEntryNativeUnavailable);
  expect(() =>
    dEntryNativeOwnerPort.resolve(f.base.context, f.base.identity, signal()),
  ).toThrow(DEntryNativeUnavailable);
  expect(f.vm).not.toHaveBeenCalled();
});
