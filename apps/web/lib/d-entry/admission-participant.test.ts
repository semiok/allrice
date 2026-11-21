import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import {
  PersonVmError,
  type PersonVmAdmissionBoundary,
  type PersonVmAdmissionPermit,
  type PersonVmAdmissionPort,
  type PersonVmBinding,
} from '@allrice/person-vm';
import {
  runDEntryAdmittedActivity,
  type DEntryOwnedActivity,
} from './admission-participant';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function activity<T>(run: () => Promise<T>, close = async () => {}) {
  return {
    run: vi.fn(run),
    close: vi.fn(close),
  } satisfies DEntryOwnedActivity<T>;
}

/** Invocation double only. It has no SQL/unsafe state and cannot prove final
 * producer sticky unsafe, persistence, physical fencing or release behavior. */
function fixture(defer = false) {
  const events: string[] = [];
  const revoked = new AbortController(),
    caller = new AbortController();
  const binding: PersonVmBinding = {
    personId: randomUUID(),
    organizationId: randomUUID(),
    vmId: randomUUID(),
    instanceId: randomUUID(),
    leaseEpoch: 1,
  };
  const context: RequestContext = {
    requestId: randomUUID(),
    sessionId: randomUUID(),
    actor: { type: 'user', id: binding.personId },
    organizationId: binding.organizationId,
    workspaceId: randomUUID(),
    memberships: [],
    authenticatedAt: new Date().toISOString(),
  };
  const permits: { permit: PersonVmAdmissionPermit; abort: AbortController }[] =
    [];
  const invoke = async <T>(
    name: string,
    permit: PersonVmAdmissionPermit,
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ) => {
    events.push(name);
    try {
      const result = await operation(AbortSignal.any([signal, permit.signal]));
      events.push(name + ':fulfilled');
      return result;
    } catch (error) {
      events.push(name + ':rejected');
      throw error;
    }
  };
  const admit = vi.fn<PersonVmAdmissionBoundary['admit']>(
    async (_c, current, _input, signal) => {
      signal.throwIfAborted();
      events.push('admit');
      const abort = new AbortController();
      const permit: PersonVmAdmissionPermit = {
        permitId: randomUUID(),
        binding: current,
        participant: 'entry',
        disposition: defer && permits.length === 0 ? 'deferred' : 'queued',
        signal: abort.signal,
      };
      permits.push({ permit, abort });
      return permit;
    },
  );
  const finish = vi.fn<PersonVmAdmissionBoundary['finish']>(async (permit) => {
    events.push('finish');
    permits.find((value) => value.permit === permit)!.abort.abort();
  });
  const waitUntilReady = vi.fn<PersonVmAdmissionBoundary['waitUntilReady']>(
    async () => {
      events.push('ready');
      return binding;
    },
  );
  const boundary: PersonVmAdmissionBoundary = {
    admit,
    finish,
    waitUntilReady,
    queued: (permit, operation, signal) =>
      invoke('queued', permit, operation, signal),
    activate: (permit, operation, signal) =>
      invoke('activate', permit, operation, signal),
  };
  const participant: PersonVmAdmissionPort = {
    participant: 'entry',
    observe: vi.fn(),
    subscribe: vi.fn(),
    freeze: vi.fn(),
    assertFrozen: vi.fn(),
    thaw: vi.fn(),
  };
  const owner = {
    context,
    binding,
    operationId: randomUUID(),
    revoked: revoked.signal,
    assertCurrent: vi.fn(async () => {
      events.push('current');
    }),
    assertUndispatched: vi.fn(async () => {
      events.push('undispatched');
    }),
  };
  return {
    events,
    permits,
    owner,
    caller,
    revoked,
    admit,
    finish,
    waitUntilReady,
    input: { ports: { boundary, participant }, owner, signal: caller.signal },
  };
}

describe('D entry consumer preparation: outcome only after actual owner close', () => {
  it('owns the queued and complete active lifetime, awaiting each actual close before finish', async () => {
    const f = fixture(),
      queueClosed = deferred<void>(),
      activeClosed = deferred<void>();
    const queueClosing = deferred<void>(),
      activeClosing = deferred<void>();
    const queued = activity(
      async () => {},
      async () => {
        queueClosing.resolve();
        await queueClosed.promise;
      },
    );
    const active = activity(
      async () => 'done',
      async () => {
        activeClosing.resolve();
        await activeClosed.promise;
      },
    );
    const run = runDEntryAdmittedActivity(
      { ...f.input, queued: () => queued },
      () => active,
    );
    await queueClosing.promise;
    expect(active.run).not.toHaveBeenCalled();
    expect(f.finish).not.toHaveBeenCalled();
    queueClosed.resolve();
    await activeClosing.promise;
    expect(f.finish).not.toHaveBeenCalled();
    activeClosed.resolve();
    await expect(run).resolves.toBe('done');
    expect(f.events).toEqual([
      'current',
      'admit',
      'queued',
      'current',
      'queued:fulfilled',
      'activate',
      'current',
      'activate:fulfilled',
      'finish',
    ]);
    expect(queued.close).toHaveBeenCalledTimes(1);
    expect(active.close).toHaveBeenCalledTimes(1);
  });

  it('fulfils a joined business outcome to the callback and rethrows the same provider error after finish', async () => {
    const f = fixture(),
      failure = new Error('provider failed'),
      closed = deferred<void>(),
      closing = deferred<void>();
    const owned = activity(
      async () => {
        throw failure;
      },
      async () => {
        closing.resolve();
        await closed.promise;
      },
    );
    const run = runDEntryAdmittedActivity(f.input, () => owned);
    const rejected = expect(run).rejects.toBe(failure);
    await closing.promise;
    expect(f.finish).not.toHaveBeenCalled();
    closed.resolve();
    await rejected;
    expect(f.events.slice(-2)).toEqual(['activate:fulfilled', 'finish']);
  });

  it('rechecks authority inside the callback before acquiring an actual owner', async () => {
    const f = fixture(),
      denied = new Error('current authority withdrawn');
    f.owner.assertCurrent.mockRejectedValueOnce(denied);
    await expect(
      runDEntryAdmittedActivity(f.input, () => {
        throw Error('must not acquire');
      }),
    ).rejects.toBe(denied);
    expect(f.admit).not.toHaveBeenCalled();
    f.owner.assertCurrent
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(denied);
    const owned = activity(async () => 'never'),
      acquire = vi.fn(() => owned);
    await expect(runDEntryAdmittedActivity(f.input, acquire)).rejects.toBe(
      denied,
    );
    expect(acquire).not.toHaveBeenCalled();
    expect(owned.run).not.toHaveBeenCalled();
    expect(owned.close).not.toHaveBeenCalled();
    expect(f.events).toContain('activate:rejected');
    expect(f.finish).toHaveBeenCalledTimes(1);
  });

  it.each(['active', 'queued'] as const)(
    'rechecks cancellation after awaiting %s current authority and before acquire',
    async (phase) => {
      const f = fixture(),
        checking = deferred<void>(),
        authorized = deferred<void>(),
        reason = new Error('revoked while authorizing'),
        acquire = vi.fn();
      f.owner.assertCurrent
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(async () => {
          checking.resolve();
          await authorized.promise;
        });
      const run = runDEntryAdmittedActivity(
        { ...f.input, ...(phase === 'queued' ? { queued: acquire } : {}) },
        acquire,
      );
      const rejected = expect(run).rejects.toBe(reason);
      await checking.promise;
      f.caller.abort(reason);
      authorized.resolve();
      await rejected;
      expect(acquire).not.toHaveBeenCalled();
      expect(f.events).toContain(
        (phase === 'queued' ? 'queued' : 'activate') + ':rejected',
      );
      expect(f.finish).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['active', 'queued'] as const)(
    'rejects an unknown %s acquisition without a handle and still calls finish',
    async (phase) => {
      const f = fixture(),
        unknown = new Error('partial open unknown');
      const acquire = vi.fn(() => {
        throw unknown;
      });
      await expect(
        runDEntryAdmittedActivity(
          { ...f.input, ...(phase === 'queued' ? { queued: acquire } : {}) },
          acquire,
        ),
      ).rejects.toBe(unknown);
      const callback = phase === 'queued' ? 'queued' : 'activate';
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(f.events).toContain(callback + ':rejected');
      expect(f.events).not.toContain(callback + ':fulfilled');
      expect(f.finish).toHaveBeenCalledTimes(1);
      // Invocation assertions do not prove durable retention by the producer.
    },
  );

  it.each(['active', 'queued'] as const)(
    'does not turn %s close rejection into a safe business outcome',
    async (phase) => {
      const f = fixture(),
        unknown = new Error('actual close unknown');
      const owned = activity(
        async () => {},
        async () => {
          throw unknown;
        },
      );
      await expect(
        runDEntryAdmittedActivity(
          {
            ...f.input,
            ...(phase === 'queued' ? { queued: () => owned } : {}),
          },
          () => owned,
        ),
      ).rejects.toBe(unknown);
      expect(f.events).toContain(
        (phase === 'queued' ? 'queued' : 'activate') + ':rejected',
      );
      expect(f.events).not.toContain(
        (phase === 'queued' ? 'queued' : 'activate') + ':fulfilled',
      );
      expect(f.finish).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['active', 'queued'] as const)(
    'finishes when the boundary rejects %s before entering the callback',
    async (phase) => {
      const f = fixture(),
        failure = new Error('authority rejected before callback'),
        acquire = vi.fn();
      const callback = phase === 'queued' ? 'queued' : 'activate';
      f.input.ports.boundary[callback] = vi.fn(async () => {
        throw failure;
      });
      await expect(
        runDEntryAdmittedActivity(
          { ...f.input, ...(phase === 'queued' ? { queued: acquire } : {}) },
          acquire,
        ),
      ).rejects.toBe(failure);
      expect(acquire).not.toHaveBeenCalled();
      expect(f.finish).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['provider', 'cancellation', 'cancellation during close'] as const)(
    'preserves %s and close errors in a rejecting callback, including a later finish failure',
    async (kind) => {
      for (const finishFails of [false, true]) {
        const f = fixture(),
          original = new Error(kind),
          closeError = new Error('actual close unknown'),
          finishError = new PersonVmError('CLEANUP_INCOMPLETE');
        if (finishFails) f.finish.mockRejectedValue(finishError);
        const owned = activity(
          async () => {
            if (kind === 'cancellation during close') return 'not delivered';
            if (kind === 'cancellation') f.caller.abort(original);
            throw original;
          },
          async () => {
            if (kind === 'cancellation during close') f.caller.abort(original);
            throw closeError;
          },
        );
        const joinedFailure = {
          errors: [original, closeError],
          cause: original,
        };
        await expect(
          runDEntryAdmittedActivity(f.input, () => owned),
        ).rejects.toMatchObject(
          finishFails
            ? { errors: [joinedFailure, finishError], cause: joinedFailure }
            : joinedFailure,
        );
        expect(f.events).toContain('activate:rejected');
        expect(f.events).not.toContain('activate:fulfilled');
        expect(owned.close).toHaveBeenCalledTimes(1);
        expect(f.finish).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('does not fulfil an outer callback when its caught inner callback still has an unknown owner close', async () => {
    const f = fixture(),
      unknown = new Error('nested owner close unknown'),
      finishError = new PersonVmError('CLEANUP_INCOMPLETE');
    f.finish.mockRejectedValue(finishError);
    let actualClose: Promise<void> | undefined;
    const closeChild = () => (actualClose ??= Promise.reject(unknown));
    const caught = vi.fn();
    const owned: DEntryOwnedActivity<void> = {
      run: async (signal) => {
        await f.input.ports.boundary
          .queued(f.permits[0]!.permit, closeChild, signal)
          .catch(caught);
      },
      close: closeChild,
    };
    await expect(
      runDEntryAdmittedActivity(f.input, () => owned),
    ).rejects.toMatchObject({
      errors: [unknown, finishError],
      cause: unknown,
    });
    expect(caught).toHaveBeenCalledWith(unknown);
    expect(f.events).toContain('queued:rejected');
    expect(f.events).toContain('activate:rejected');
    expect(f.events).not.toContain('activate:fulfilled');
    expect(f.finish).toHaveBeenCalledTimes(1);
    // The configured finish failure proves no PG/sticky-unsafe behavior.
  });

  it('does not activate after a queued business failure whose owner has joined', async () => {
    const f = fixture(),
      failure = new Error('capacity canceled'),
      open = vi.fn();
    const queued = activity(async () => {
      throw failure;
    });
    await expect(
      runDEntryAdmittedActivity({ ...f.input, queued: () => queued }, open),
    ).rejects.toBe(failure);
    expect(f.events).toContain('queued:fulfilled');
    expect(f.events).not.toContain('activate');
    expect(open).not.toHaveBeenCalled();
    expect(f.finish).toHaveBeenCalledTimes(1);
  });

  it('finishes a same-epoch deferred permit and re-admits with the live request root signal exactly once', async () => {
    const f = fixture(true),
      open = vi.fn(() => activity(async () => 'same call'));
    await expect(runDEntryAdmittedActivity(f.input, open)).resolves.toBe(
      'same call',
    );
    expect(f.admit).toHaveBeenCalledTimes(2);
    expect(f.finish).toHaveBeenCalledTimes(2);
    expect(f.permits[0]!.permit.signal.aborted).toBe(true);
    expect(f.admit.mock.calls[1]![3].aborted).toBe(false);
    expect(f.admit.mock.calls[1]![2]).toEqual(f.admit.mock.calls[0]![2]);
    expect(f.owner.assertUndispatched).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(f.events.indexOf('finish')).toBeLessThan(
      f.events.indexOf('undispatched'),
    );
  });

  it('cancels an old epoch without acquiring a new handle or changing the original VM envelope', async () => {
    const f = fixture(true),
      open = vi.fn();
    f.waitUntilReady.mockResolvedValue({ ...f.owner.binding, leaseEpoch: 2 });
    await expect(
      runDEntryAdmittedActivity(f.input, open),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(f.admit).toHaveBeenCalledTimes(1);
    expect(f.finish).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(f.owner.binding.leaseEpoch).toBe(1);
  });

  it('finishes a deferred permit when its wait rejects without activating or opening anything', async () => {
    const f = fixture(true),
      failure = new Error('deferred wait canceled'),
      acquire = vi.fn();
    f.waitUntilReady.mockRejectedValue(failure);
    await expect(runDEntryAdmittedActivity(f.input, acquire)).rejects.toBe(
      failure,
    );
    expect(f.admit).toHaveBeenCalledTimes(1);
    expect(f.finish).toHaveBeenCalledTimes(1);
    expect(f.events).not.toContain('activate');
    expect(acquire).not.toHaveBeenCalled();
  });

  it('requires the real owner to prove the original full binding and undispatched call before re-admit', async () => {
    const f = fixture(true),
      stale = new Error('Run/native/release/route changed'),
      open = vi.fn();
    f.owner.assertUndispatched.mockRejectedValue(stale);
    await expect(runDEntryAdmittedActivity(f.input, open)).rejects.toBe(stale);
    expect(f.admit).toHaveBeenCalledTimes(1);
    expect(f.finish).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it('actively requests owner close on idle cancellation and waits for real join before rethrowing its reason', async () => {
    const f = fixture(),
      reason = new Error('caller canceled'),
      started = deferred<void>(),
      closing = deferred<void>(),
      closed = deferred<void>();
    const owned: DEntryOwnedActivity<void> = {
      run: (signal) =>
        new Promise((_done, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
          started.resolve();
        }),
      close: vi.fn(async () => {
        closing.resolve();
        await closed.promise;
      }),
    };
    const run = runDEntryAdmittedActivity(f.input, () => owned);
    const rejected = expect(run).rejects.toBe(reason);
    await started.promise;
    f.caller.abort(reason);
    await closing.promise;
    expect(f.finish).not.toHaveBeenCalled();
    closed.resolve();
    await rejected;
    expect(owned.close).toHaveBeenCalledTimes(1);
    expect(f.events.slice(-2)).toEqual(['activate:fulfilled', 'finish']);
  });

  it('preserves the first provider failure when finish also fails, without claiming cleanup succeeded', async () => {
    const f = fixture(),
      original = new Error('provider failed'),
      unknown = new Error('finish unavailable');
    f.finish.mockRejectedValue(unknown);
    await expect(
      runDEntryAdmittedActivity(f.input, () =>
        activity(async () => {
          throw original;
        }),
      ),
    ).rejects.toMatchObject({ errors: [original, unknown], cause: original });
  });

  it('keeps cancellation during actual close as a joined business outcome, not successful delivery', async () => {
    const f = fixture(),
      closing = deferred<void>(),
      closed = deferred<void>();
    const reason = new Error('canceled during close');
    const owned = activity(
      async () => 'not delivered',
      async () => {
        closing.resolve();
        await closed.promise;
      },
    );
    const run = runDEntryAdmittedActivity(f.input, () => owned);
    const rejected = expect(run).rejects.toBe(reason);
    await closing.promise;
    f.caller.abort(reason);
    expect(f.finish).not.toHaveBeenCalled();
    closed.resolve();
    await rejected;
    expect(f.events.slice(-2)).toEqual(['activate:fulfilled', 'finish']);
  });

  it('rejects a gateway participant or foreign owner before acquiring any permit', async () => {
    const f = fixture(),
      open = vi.fn();
    await expect(
      runDEntryAdmittedActivity(
        {
          ...f.input,
          ports: {
            ...f.input.ports,
            participant: {
              ...f.input.ports.participant,
              participant: 'gateway',
            },
          },
        },
        open,
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      runDEntryAdmittedActivity(
        {
          ...f.input,
          owner: {
            ...f.owner,
            binding: { ...f.owner.binding, personId: randomUUID() },
          },
        },
        open,
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(f.admit).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
