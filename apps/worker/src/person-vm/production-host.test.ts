/** Real inert constructors/installation; synthetic seal, SQL and required external sources only. */
import { createHash, randomUUID } from 'node:crypto';
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
  type PersonVmAuthority,
} from '@allrice/person-vm';
import type * as ProductionAuthority from './production-authority.js';
import type * as ProductionEgress from './production-egress.js';
import {
  DEntryNativeUnavailable,
  dEntryNativeOwnerPort,
} from '../d-entry/native-owner.js';
import { nativeEntryFixture } from '../d-entry/native-entry.fixture.js';
import { installDEntryNativePrewarmPort } from '../d-entry/native-prewarm.js';
import { productionInputsFixture } from './production-inputs.fixture.js';
import { personNativeWebRoster } from '../native-web/composition.js';
import {
  harness,
  MemoryStore,
} from '../../../../packages/person-vm/src/test-support.js';

const io = vi.hoisted(() => ({
  read: vi.fn(),
  database: vi.fn(),
  dedicated: vi.fn(),
  authority: vi.fn<() => PersonVmAuthority | undefined>(),
  installation:
    vi.fn<
      (
        owner: ReturnType<
          typeof ProductionEgress.createProductionEgressInstallation
        >,
      ) =>
        | ReturnType<typeof ProductionEgress.createProductionEgressInstallation>
        | undefined
    >(),
  gateway:
    vi.fn<
      (
        options: Parameters<typeof Egress.createEgressGateway>[0],
        gateway: ReturnType<typeof Egress.createEgressGateway>,
      ) => void
    >(),
}));
vi.mock('./production-config.js', () => ({
  readProductionHostConfiguration: io.read,
}));
vi.mock('./production-authority.js', async (original) => {
  const actual = await original<typeof ProductionAuthority>();
  return {
    ...actual,
    createProductionPersonVmAuthority: (
      ...args: Parameters<typeof actual.createProductionPersonVmAuthority>
    ) => {
      const owner = actual.createProductionPersonVmAuthority(...args),
        authority = io.authority();
      // Explicit construction-time test source; never mutate the frozen owner.
      return authority ? Object.freeze({ ...owner, authority }) : owner;
    },
  };
});
vi.mock('./production-egress.js', async (original) => {
  const actual = await original<typeof ProductionEgress>();
  return {
    ...actual,
    createProductionEgressInstallation: (
      ...args: Parameters<typeof actual.createProductionEgressInstallation>
    ) => {
      const owner = actual.createProductionEgressInstallation(...args);
      return io.installation(owner) ?? owner;
    },
  };
});
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
      const gateway = actual.createEgressGateway(options);
      io.gateway(options, gateway);
      return gateway;
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
/** Public service start/cleanup with synthetic physical/PG boundaries. The
 * actual Host, service receipt copies and gateway listener/revoke remain real. */
async function receiptFixture() {
  const memory = new MemoryStore(),
    physical = harness(memory),
    entry = nativeEntryFixture(),
    value = fixture();
  io.authority.mockReturnValue(physical.options.authority);
  value.bound.egress.revokeModel = vi.fn(async () => {});
  const opened = await open(value),
    input = opened.input(),
    gateway = io.gateway.mock.calls[0]?.[1];
  if (!gateway) throw Error('actual gateway was not constructed');
  vi.spyOn(PostgresPersonVmStore.prototype, 'withLease').mockImplementation(
    memory.withLease.bind(memory),
  );
  // Replace the external shared PG observation only, not the service callback.
  vi.spyOn(input.admission, 'trackOwner').mockImplementation(
    async (_personId, active, work) => {
      active.throwIfAborted();
      return work(active);
    },
  );
  vi.spyOn(input.providers.disk, 'create').mockImplementation(
    physical.disk.create,
  );
  vi.spyOn(input.providers.disk, 'inspect').mockImplementation(
    physical.disk.inspect,
  );
  vi.spyOn(input.providers.disk, 'attach').mockImplementation(
    physical.disk.attach,
  );
  vi.spyOn(input.providers.disk, 'detach').mockImplementation(
    physical.disk.detach,
  );
  vi.spyOn(input.providers.native, 'prepare').mockImplementation(
    physical.native.prepare,
  );
  vi.spyOn(input.providers.native, 'status').mockImplementation(
    physical.native.status,
  );
  vi.spyOn(input.providers.native, 'stop').mockImplementation(
    physical.native.stop,
  );
  const startFailure = new PersonVmError('RUNTIME_NOT_READY');
  const prepareWeb = vi
    .spyOn(input.providers.native, 'prepareWebEndpoints')
    .mockRejectedValue(startFailure);
  const facts = {
    personId: entry.context.actor.id,
    organizationId: entry.context.organizationId,
    entries: [
      {
        workspaceId: entry.identity.workspaceId,
        employeeInstanceId: entry.identity.employeeInstanceId,
        employeeRevision: entry.identity.employeeRevision,
        employeeVersionId: entry.identity.employeeVersionId,
      },
    ],
  };
  vi.spyOn(personNativeWebRoster, 'prepare').mockResolvedValue({
    ...facts,
    digest: `sha256:${createHash('sha256').update(JSON.stringify(facts)).digest('hex')}`,
  });
  const provisioner = input.providers.egressInstallation.provisioner;
  vi.spyOn(provisioner, 'endpoint').mockImplementation(async (_vmId, ports) => {
    const port = ports[0] ?? 0;
    return { host: '127.0.0.1', port, guestOrigin: `http://127.0.0.1:${port}` };
  });
  vi.spyOn(provisioner, 'install').mockResolvedValue(undefined);
  vi.spyOn(provisioner, 'remove').mockResolvedValue(undefined);
  const prepare = vi.spyOn(gateway, 'prepare'),
    revoke = vi.spyOn(gateway, 'revoke');
  await input.vm.create(entry.context, signal());
  return {
    ...opened,
    memory,
    entry,
    gateway,
    prepare,
    revoke,
    prepareWeb,
    startFailure,
  };
}
beforeEach(async () => {
  vi.clearAllMocks();
  io.authority.mockReset();
  io.installation.mockReset();
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

it('actual service cleanup revokes a copied receipt once and Host.close does not revoke it again', async () => {
  const value = await receiptFixture();
  await expect(
    value.input().vm.start(value.entry.context, signal()),
  ).rejects.toBe(value.startFailure);
  expect(value.prepareWeb).toHaveBeenCalledTimes(1);
  expect(value.prepare).toHaveBeenCalledTimes(1);
  expect(value.revoke).toHaveBeenCalledTimes(1);
  const original = await value.prepare.mock.results[0]!.value,
    copied = value.revoke.mock.calls[0]![0];
  expect(copied).toEqual(original);
  expect(copied).not.toBe(original);
  expect(copied.binding).not.toBe(original.binding);
  expect(copied.gatewayPorts).not.toBe(original.gatewayPorts);
  expect(
    (await value.memory.read(value.entry.context.actor.id))?.egressReceipt,
  ).toBeNull();
  await value.host.close();
  expect(value.revoke).toHaveBeenCalledTimes(1);
  expect(value.bound.egress.revokeModel).toHaveBeenCalledTimes(1);
});

it('a failed actual service revoke retains the receipt for the real Host.close retry', async () => {
  const value = await receiptFixture(),
    modelFailure = Error('synthetic first model drain failure');
  vi.mocked(value.bound.egress.revokeModel).mockRejectedValueOnce(modelFailure);
  await expect(
    value.input().vm.start(value.entry.context, signal()),
  ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
  expect(value.prepareWeb).toHaveBeenCalledTimes(1);
  expect(value.revoke).toHaveBeenCalledTimes(1);
  const persisted = await value.memory.read(value.entry.context.actor.id);
  expect(persisted?.egressReceipt).toEqual(value.revoke.mock.calls[0]![0]);
  expect(persisted?.phase).toBe('failed');
  await value.host.close();
  expect(value.revoke).toHaveBeenCalledTimes(2);
  expect(value.revoke.mock.calls[1]![0]).toEqual(
    value.revoke.mock.calls[0]![0],
  );
  expect(value.bound.egress.revokeModel).toHaveBeenCalledTimes(2);
});

it('a stale persisted service receipt cannot remove a retained newer epoch from Host cleanup', async () => {
  const value = await receiptFixture(),
    vm = value.input().vm,
    context = value.entry.context;
  await expect(vm.start(context, signal())).rejects.toBe(value.startFailure);
  expect(value.prepareWeb).toHaveBeenCalledTimes(1);
  const old = await value.memory.read(context.actor.id);
  if (!old) throw Error('actual service did not persist its first epoch');
  const oldReceipt = await value.prepare.mock.results[0]!.value;
  let failNew = true;
  vi.mocked(value.bound.egress.revokeModel).mockImplementation(
    async (binding) => {
      if (binding.leaseEpoch > old.leaseEpoch && failNew)
        throw Error('synthetic new epoch drain failure');
    },
  );
  await expect(vm.start(context, signal())).rejects.toMatchObject({
    code: 'CLEANUP_INCOMPLETE',
  });
  expect(value.prepareWeb).toHaveBeenCalledTimes(2);
  const current = await value.memory.read(context.actor.id);
  if (!current?.egressReceipt)
    throw Error('new epoch receipt was not retained');
  expect(current.leaseEpoch).toBeGreaterThan(old.leaseEpoch);
  // Explicit stale-store fixture: the actual service delivers another copied
  // old epoch to gateway.revoke, whose exact check leaves the new state alone.
  value.memory.rows.set(context.actor.id, {
    ...old,
    egressReceipt: structuredClone(oldReceipt),
  });
  await expect(vm.stop(context, signal())).resolves.toMatchObject({
    phase: 'stopped',
  });
  const stale = value.revoke.mock.calls.at(-1)![0];
  expect(stale).toEqual(oldReceipt);
  expect(stale).not.toBe(oldReceipt);
  await expect(
    value.gateway.assertActive(current.egressReceipt, signal()),
  ).rejects.toBeInstanceOf(Error); // Failed drain fenced the new state.
  failNew = false;
  const beforeClose = value.revoke.mock.calls.length;
  await value.host.close();
  expect(value.revoke).toHaveBeenCalledTimes(beforeClose + 1);
  expect(value.revoke.mock.calls.at(-1)![0]).toEqual(current.egressReceipt);
  expect(value.revoke.mock.calls.at(-1)![0].binding.leaseEpoch).toBe(
    current.leaseEpoch,
  );
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
  let rolledBack = false;
  const providerClose = vi.fn();
  io.installation.mockImplementation((owner) => {
    expect(Object.isFrozen(owner)).toBe(true);
    return Object.freeze({
      ...owner,
      close: async () => {
        providerClose();
        entered.release();
        await released.promise;
        await owner.close();
        rolledBack = true;
      },
    });
  });
  vi.mocked(value.sources.bind).mockRejectedValue(reason);
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
    expect(rolledBack).toBe(false);
    expect(io.gateway).not.toHaveBeenCalled();
    released.release();
    expect(await outcome).toBe(reason);
    expect(providerClose).toHaveBeenCalledTimes(1);
    expect(rolledBack).toBe(true);
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
