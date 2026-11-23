/** Real inert constructors/installation; synthetic seal, SQL and required external sources only. */
import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { setImmediate as turn } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import type * as Egress from '@allrice/egress-gateway';
import {
  ApfsPersonVmDisk,
  MicrosandboxPersonVm,
  PersonVmAdmissionHost,
  PersonVmError,
  PersonVmService,
  PostgresPersonVmStore,
} from '@allrice/person-vm';
import {
  DEntryNativeUnavailable,
  dEntryNativeOwnerPort,
} from '../d-entry/native-owner.js';
import { nativeEntryFixture } from '../d-entry/native-entry.fixture.js';
import { installDEntryNativePrewarmPort } from '../d-entry/native-prewarm.js';
import { productionInputsFixture } from './production-inputs.fixture.js';

const io = vi.hoisted(() => ({
  read: vi.fn(),
  database: vi.fn(),
  dedicated: vi.fn(),
  gateway: vi.fn(),
}));
vi.mock('./production-config.js', () => ({
  readProductionHostConfiguration: io.read,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getDatabase: io.database,
  createDedicatedDatabase: io.dedicated,
}));
vi.mock('@allrice/egress-gateway', async (original) => {
  const actual = await original<typeof Egress>();
  return {
    ...actual,
    createEgressGateway: (
      options: Parameters<typeof actual.createEgressGateway>[0],
    ) => {
      io.gateway(options);
      return actual.createEgressGateway(options);
    },
  };
});
import {
  createProductionPersonVmHost,
  ProductionPersonVmHostUnavailable,
  type ProductionPersonVmHostSources,
} from './production-host.js';

type Bound = Awaited<ReturnType<ProductionPersonVmHostSources['bind']>>;
type BindInput = Parameters<ProductionPersonVmHostSources['bind']>[0];
let f: Awaited<ReturnType<typeof productionInputsFixture>>;
const cleanup: (() => Promise<unknown>)[] = [];
const signal = () => new AbortController().signal;
const trustedDatabase = Object.freeze({
  source: 'synthetic-trusted-connection-options-not-a-DSN',
});
function gate() {
  let release: () => void = () => {
    throw Error('fixture latch is not initialized');
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function expectUninstalled() {
  const scope = nativeEntryFixture();
  expect(() =>
    dEntryNativeOwnerPort.resolve(scope.context, scope.identity, signal()),
  ).toThrowError(DEntryNativeUnavailable);
}
function fixture() {
  let input: BindInput | undefined;
  const bound: Bound = {
    runtime: {
      readiness: vi.fn(async () => {
        throw new PersonVmError('RUNTIME_NOT_READY');
      }),
      activity: vi.fn(async () => {
        throw new PersonVmError('ACTIVITY_UNKNOWN');
      }),
      close: vi.fn(async () => {}),
    },
    egress: {
      authority: {
        context: vi.fn(async () => {
          throw new PersonVmError('AUTHORIZATION_DENIED');
        }),
        allow: vi.fn(async () => {
          throw new PersonVmError('AUTHORIZATION_DENIED');
        }),
      },
      // No model/read route is exercised by this inert construction fixture.
      // This is not a production model-disabled adapter or send-ready proof.
      policy: { routes: [] },
      transport: {
        read: vi.fn(async () => {
          throw Error('no transport should start during construction');
        }),
      },
      revokeModel: vi.fn(async () => {
        throw Error('no model should exist in this construction fixture');
      }),
      close: vi.fn(async () => {}),
    },
  };
  const sources: ProductionPersonVmHostSources = {
    publicUrl: vi.fn(() => 'https://synthetic.example.test/employee/'),
    bind: vi.fn(async (value: BindInput) => {
      input = value;
      return bound;
    }),
  };
  return {
    sources,
    bound,
    input: () => {
      if (!input) throw Error('source was not bound');
      return input;
    },
  };
}
async function open(value = fixture(), lifetime = new AbortController()) {
  const host = await createProductionPersonVmHost({
    sources: value.sources,
    lifetime: lifetime.signal,
  });
  cleanup.push(() => host.close());
  return { ...value, host, lifetime };
}
beforeEach(async () => {
  vi.clearAllMocks();
  f = await productionInputsFixture();
  io.read.mockResolvedValue(f.loaded);
  io.database.mockReturnValue(trustedDatabase);
  io.dedicated.mockImplementation(() => {
    throw Error('synthetic SQL boundary: no PostgreSQL is opened');
  });
});
afterEach(async () => {
  const joined = await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
  vi.restoreAllMocks();
  await rm(f.root, { recursive: true, force: true });
  const errors = joined.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (errors.length) throw new AggregateError(errors, 'fixture cleanup');
});

it('missing required production sources leaves ports uninstalled before any provider/SQL construction', async () => {
  await expect(
    createProductionPersonVmHost({ lifetime: signal() }),
  ).rejects.toMatchObject({
    name: 'ProductionPersonVmHostUnavailable',
    code: 'HOST_SOURCES_UNAVAILABLE',
  });
  expect(io.read).not.toHaveBeenCalled();
  expect(io.database).not.toHaveBeenCalled();
  expect(io.gateway).not.toHaveBeenCalled();
  expectUninstalled();
});

it('an already cancelled lifetime returns the original reason without constructing sources', async () => {
  const value = fixture(),
    lifetime = new AbortController(),
    reason = Error('synthetic caller cancellation');
  lifetime.abort(reason);
  await expect(
    createProductionPersonVmHost({
      lifetime: lifetime.signal,
      sources: value.sources,
    }),
  ).rejects.toBe(reason);
  expect(io.read).not.toHaveBeenCalled();
  expect(value.sources.bind).not.toHaveBeenCalled();
  expect(value.bound.egress.close).not.toHaveBeenCalled();
});

it('constructs the real store/service/admission/startup with one SQL factory and the same nondefault platform snapshot', async () => {
  const factory = vi.spyOn(
    PostgresPersonVmStore.prototype,
    'assertAdmissionFactory',
  );
  const admission = vi.spyOn(PersonVmService.prototype, 'createAdmissionHost');
  const platform = Object.freeze({
    ...f.loaded.platform,
    memoryMiB: 3072,
    idleMs: 3333,
  });
  io.read.mockResolvedValue({
    ...f.loaded,
    platform,
    configuration: {
      ...f.loaded.configuration,
      memory: {
        ...f.loaded.configuration.memory,
        policy: {
          ...f.loaded.configuration.memory.policy,
          physicalBytes: platform.memoryMiB * 1024 ** 2,
        },
      },
    },
  });
  const value = await open(),
    actual = value.input();
  expect(actual.vm).toBeInstanceOf(PersonVmService);
  expect(actual.admission).toBeInstanceOf(PersonVmAdmissionHost);
  expect(actual.providers.native).toBeInstanceOf(MicrosandboxPersonVm);
  expect(actual.providers.disk).toBeInstanceOf(ApfsPersonVmDisk);
  expect(actual.providers.platform).toBe(platform);
  expect(admission).toHaveBeenCalledExactlyOnceWith({
    openSql: expect.any(Function),
    idleMs: platform.idleMs,
    nativeActivity: expect.any(Object),
  });
  const options = admission.mock.calls[0]?.[0];
  if (!options) throw Error('real admission constructor was not called');
  expect(factory).toHaveBeenCalledExactlyOnceWith(options.openSql);
  expect(() => options.openSql()).toThrow('synthetic SQL boundary');
  expect(io.dedicated).toHaveBeenCalledExactlyOnceWith(trustedDatabase);
  expect(io.database).toHaveBeenCalledTimes(1);
  expect(io.read).toHaveBeenCalledTimes(1);
  await expect(stat(f.loaded.configuration.disk.root)).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(value.bound.runtime.readiness).not.toHaveBeenCalled();
  expect(value.bound.runtime.activity).not.toHaveBeenCalled();
  expect(value.bound.egress.transport.read).not.toHaveBeenCalled();
  expect(value.sources.publicUrl).not.toHaveBeenCalled();
  expect(() =>
    actual.startup.owner(
      {
        vmId: randomUUID(),
        personId: randomUUID(),
        organizationId: randomUUID(),
        instanceId: randomUUID(),
        leaseEpoch: 1,
      },
      randomUUID(),
    ),
  ).toThrowError(PersonVmError);
});

it('an egress source cannot substitute another VM or shared admission boundary', async () => {
  const value = fixture();
  Object.assign(value.bound.egress, {
    vm: { wrong: 'synthetic conflicting VM' },
    admission: { wrong: 'synthetic conflicting boundary' },
  });
  const actual = (await open(value)).input();
  expect(io.gateway).toHaveBeenCalledTimes(1);
  expect(io.gateway.mock.calls[0]?.[0]).toMatchObject({
    vm: actual.vm,
    admission: actual.admission,
    authority: value.bound.egress.authority,
    revokeModel: value.bound.egress.revokeModel,
    provisioner: actual.providers.egressInstallation.provisioner,
  });
});

it('missing native activity is unknown, and a real later observer is forwarded without synthesized counts', async () => {
  const admission = vi.spyOn(PersonVmService.prototype, 'createAdmissionHost');
  const value = await open(),
    observer = admission.mock.calls[0]?.[0].nativeActivity;
  if (!observer) throw Error('missing native observation forwarding');
  const binding = {
      vmId: randomUUID(),
      personId: randomUUID(),
      organizationId: randomUUID(),
      instanceId: randomUUID(),
      leaseEpoch: 1,
    },
    current = signal();
  await expect(observer.observe(binding, current)).rejects.toMatchObject({
    code: 'ACTIVITY_UNKNOWN',
  });
  await expect(observer.subscribe(binding, current)).rejects.toMatchObject({
    code: 'ACTIVITY_UNKNOWN',
  });
  const reason = Error('synthetic real source result');
  value.bound.nativeActivity = {
    observe: vi.fn(async () => {
      throw reason;
    }),
    subscribe: vi.fn(async () => {
      throw reason;
    }),
  };
  await expect(observer.observe(binding, current)).rejects.toBe(reason);
  expect(value.bound.nativeActivity.observe).toHaveBeenCalledExactlyOnceWith(
    binding,
    expect.any(AbortSignal),
  );
});

it('a missing verified artifact prevents source binding and any native installation', async () => {
  const value = fixture();
  await rm(f.loaded.configuration.native.binary);
  await expect(
    createProductionPersonVmHost({
      sources: value.sources,
      lifetime: signal(),
    }),
  ).rejects.toThrow('PERSON_VM_ARTIFACTS_UNAVAILABLE');
  expect(value.sources.bind).not.toHaveBeenCalled();
  expect(io.database).not.toHaveBeenCalled();
  expect(io.gateway).not.toHaveBeenCalled();
});

it('cancellation during source construction joins both late source publication and its actual close', async () => {
  const value = fixture(),
    entered = gate(),
    returned = gate(),
    closing = gate(),
    closed = gate(),
    lifetime = new AbortController(),
    reason = Error('synthetic final-construction cancellation');
  vi.mocked(value.sources.bind).mockImplementation(async () => {
    entered.release();
    await returned.promise;
    return value.bound;
  });
  vi.mocked(value.bound.egress.close).mockImplementation(async () => {
    closing.release();
    await closed.promise;
  });
  let settled = false;
  const outcome = createProductionPersonVmHost({
    sources: value.sources,
    lifetime: lifetime.signal,
  }).then(
    () => {
      settled = true;
      throw Error('cancelled constructor must not install');
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await entered.promise;
    lifetime.abort(reason);
    await turn();
    expect(settled).toBe(false);
    returned.release();
    await closing.promise;
    await turn();
    expect(settled).toBe(false);
    expect(io.gateway).not.toHaveBeenCalled();
    closed.release();
    expect(await outcome).toBe(reason);
    expect(value.bound.egress.close).toHaveBeenCalledTimes(1);
  } finally {
    returned.release();
    closed.release();
    await outcome;
  }
});

it('failed source construction joins actual provider rollback before returning the primary error', async () => {
  const value = fixture(),
    entered = gate(),
    released = gate(),
    reason = Error('synthetic source construction failed');
  vi.mocked(value.sources.bind).mockImplementation(async (input) => {
    const original = input.providers.egressInstallation.close.bind(
      input.providers.egressInstallation,
    );
    vi.spyOn(input.providers.egressInstallation, 'close').mockImplementation(
      async () => {
        entered.release();
        await released.promise;
        await original();
      },
    );
    throw reason;
  });
  let settled = false;
  const outcome = createProductionPersonVmHost({
    sources: value.sources,
    lifetime: signal(),
  }).catch((error: unknown) => {
    settled = true;
    return error;
  });
  try {
    await entered.promise;
    await turn();
    expect(settled).toBe(false);
    expect(io.gateway).not.toHaveBeenCalled();
    released.release();
    expect(await outcome).toBe(reason);
    expect(value.bound.egress.close).not.toHaveBeenCalled();
  } finally {
    released.release();
    await outcome;
  }
});

it('close fences the native ports and joins source work; repeated close has one actual owner', async () => {
  const value = await open(),
    entered = gate(),
    released = gate();
  vi.mocked(value.bound.egress.close).mockImplementation(async () => {
    entered.release();
    await released.promise;
  });
  let settled = false;
  const closed = value.host.close();
  expect(value.host.close()).toBe(closed);
  const outcome = closed.then(() => {
    settled = true;
  });
  try {
    await entered.promise;
    await turn();
    expect(settled).toBe(false);
    expect(value.input().lifetime.aborted).toBe(true);
    expectUninstalled();
    released.release();
    await outcome;
    expect(value.bound.egress.close).toHaveBeenCalledTimes(1);
    expect(value.bound.egress.revokeModel).not.toHaveBeenCalled();
  } finally {
    released.release();
    await outcome;
  }
});

it('runtime close drives cancellation of an outstanding native observation and the Host joins its real outcome', async () => {
  const admission = vi.spyOn(PersonVmService.prototype, 'createAdmissionHost');
  const value = await open(),
    reading = gate(),
    readReleased = gate(),
    closing = gate(),
    closeReleased = gate(),
    failedRead = Error('synthetic native observation failure');
  value.bound.nativeActivity = {
    observe: vi.fn(async () => {
      reading.release();
      await readReleased.promise;
      throw failedRead;
    }),
    subscribe: vi.fn(async () => {
      throw new PersonVmError('ACTIVITY_UNKNOWN');
    }),
  };
  vi.mocked(value.bound.runtime.close).mockImplementation(async () => {
    closing.release();
    await closeReleased.promise;
    readReleased.release();
  });
  const observer = admission.mock.calls[0]?.[0].nativeActivity;
  if (!observer) throw Error('missing actual observer forwarding');
  const binding = nativeEntryFixture().binding;
  let readSettled = false,
    closeSettled = false;
  const read = observer.observe(binding, signal()).catch((error: unknown) => {
    readSettled = true;
    return error;
  });
  let closed: Promise<void> | undefined;
  try {
    await reading.promise;
    closed = value.host.close().then(() => {
      closeSettled = true;
    });
    await closing.promise;
    await turn();
    expect(readSettled).toBe(false);
    expect(closeSettled).toBe(false);
    closeReleased.release();
    const result = await read;
    expect(result).toBeInstanceOf(AggregateError);
    if (!(result instanceof AggregateError))
      throw Error('missing read outcome');
    expect(result.errors).toContain(failedRead);
    expect(result.errors).toContain(value.input().lifetime.reason);
    await closed;
    expect(readSettled).toBe(true);
  } finally {
    closeReleased.release();
    readReleased.release();
    await read;
    await closed;
  }
});

it('a native subscription published after cancellation is closed and really joined before either result settles', async () => {
  const admission = vi.spyOn(PersonVmService.prototype, 'createAdmissionHost');
  const value = await open(),
    entered = gate(),
    published = gate(),
    closing = gate(),
    released = gate();
  let closingTask: Promise<void> | undefined;
  const subscription = {
    wait: vi.fn(async () => {
      throw new PersonVmError('ACTIVITY_UNKNOWN');
    }),
    close: vi.fn(() => {
      closingTask ??= (async () => {
        closing.release();
        await released.promise;
      })();
      return closingTask;
    }),
  };
  value.bound.nativeActivity = {
    observe: vi.fn(async () => {
      throw new PersonVmError('ACTIVITY_UNKNOWN');
    }),
    subscribe: vi.fn(async () => {
      entered.release();
      await published.promise;
      return subscription;
    }),
  };
  const observer = admission.mock.calls[0]?.[0].nativeActivity;
  if (!observer) throw Error('missing actual subscription forwarding');
  let subscribed = false,
    closed = false;
  const reading = observer
    .subscribe(nativeEntryFixture().binding, signal())
    .then(
      () => {
        throw Error('cancelled subscription must not escape');
      },
      (error: unknown) => {
        subscribed = true;
        return error;
      },
    );
  let outcome: Promise<void> | undefined;
  try {
    await entered.promise;
    outcome = value.host.close().then(() => {
      closed = true;
    });
    published.release();
    await closing.promise;
    await turn();
    expect(subscribed).toBe(false);
    expect(closed).toBe(false);
    released.release();
    expect(await reading).toBe(value.input().lifetime.reason);
    await outcome;
    expect(subscription.close).toHaveBeenCalledTimes(1);
    expect(subscription.wait).not.toHaveBeenCalled();
  } finally {
    published.release();
    released.release();
    await reading;
    await outcome;
  }
});

it('rollback preserves both the construction error and an unknown source cleanup result', async () => {
  const value = fixture(),
    entered = gate(),
    returned = gate(),
    lifetime = new AbortController(),
    reason = Error('synthetic primary cancellation'),
    failedClose = Error('synthetic unconfirmed source close');
  vi.mocked(value.sources.bind).mockImplementation(async () => {
    entered.release();
    await returned.promise;
    return value.bound;
  });
  vi.mocked(value.bound.egress.close).mockRejectedValue(failedClose);
  const outcome = createProductionPersonVmHost({
    sources: value.sources,
    lifetime: lifetime.signal,
  }).catch((error: unknown) => error);
  try {
    await entered.promise;
    lifetime.abort(reason);
    returned.release();
    const result = await outcome;
    expect(result).toBeInstanceOf(AggregateError);
    if (!(result instanceof AggregateError)) throw Error('missing aggregate');
    expect(result.errors[0]).toBe(reason);
    expect(result.errors[1]).toBeInstanceOf(AggregateError);
    expect(result.errors[1].errors).toContain(failedClose);
    expect(io.gateway).not.toHaveBeenCalled();
  } finally {
    returned.release();
    await outcome;
  }
});

it('a real duplicate port registration failure rolls back without replacing the existing owner', async () => {
  const value = fixture(),
    existing = {
      prewarm: vi.fn(async () => {
        throw new ProductionPersonVmHostUnavailable('HOST_SOURCES_UNAVAILABLE');
      }),
    },
    uninstall = installDEntryNativePrewarmPort(existing);
  try {
    await expect(
      createProductionPersonVmHost({
        sources: value.sources,
        lifetime: signal(),
      }),
    ).rejects.toThrow();
    expect(value.bound.egress.close).toHaveBeenCalledTimes(1);
    expect(() => installDEntryNativePrewarmPort(existing)).toThrow();
    expect(existing.prewarm).not.toHaveBeenCalled();
  } finally {
    uninstall();
  }
});
