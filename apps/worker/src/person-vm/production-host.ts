import { createDedicatedDatabase, getDatabase } from '@allrice/database';
import {
  createEgressGateway,
  type EgressAuthority,
  type EgressDependencies,
  type EgressPolicy,
  type EgressTransport,
  type ManagedHostService,
} from '@allrice/egress-gateway';
import {
  PersonVmError,
  PersonVmService,
  PostgresPersonVmStore,
  sameVmBinding,
  type PersonVmBinding,
  type PersonVmEgressPort,
  type PersonVmEgressReceipt,
  type PersonVmNativeActivityPort,
  type PersonVmAdmissionSubscription,
  type PersonVmRuntimePort,
  type PersonVmWebEndpointReceipt,
} from '@allrice/person-vm';
import { installAssignedDEntryNativeRuntime } from '../business-runtime/native-prewarm.js';
import {
  createAssignedNativeWebStartup,
  personNativeWebRoster,
} from '../native-web/composition.js';
import { createProductionPersonVmAuthority } from './production-authority.js';
import { createProductionCurrentPrewarm } from './production-prewarm.js';
import { createProductionPersonVmProviders } from './production-providers.js';

type Providers = Awaited<ReturnType<typeof createProductionPersonVmProviders>>;
type Startup = ReturnType<typeof createAssignedNativeWebStartup>;
type Admission = ReturnType<PersonVmService['createAdmissionHost']>;
type Current = ReturnType<typeof createProductionPersonVmAuthority>;

export class ProductionPersonVmHostUnavailable extends Error {
  constructor(readonly code: 'HOST_SOURCES_UNAVAILABLE' | 'HOST_CLOSED') {
    super(code);
    this.name = 'ProductionPersonVmHostUnavailable';
  }
}

/** Internal production owners, never a parsed DTO or browser-installed port.
 * bind is inert: it must not create/start a VM or enter a business operation,
 * and must roll back its own failed construction. On success this composition
 * owns each close, including actual model/observation transports and callbacks.
 * First-start facts must come from the valid native bootstrap scope, never
 * running-only resolve/assertCurrentBinding self-certification during readiness.
 * No producer is implemented by accepting an object of this shape. */
export type ProductionPersonVmHostSources = Readonly<{
  publicUrl(
    endpoint: PersonVmWebEndpointReceipt['endpoints'][number],
    binding: PersonVmBinding,
  ): string;
  bind(input: {
    vm: PersonVmService;
    startup: Startup;
    admission: Admission;
    providers: Providers;
    current: Current;
    lifetime: AbortSignal;
  }): Promise<{
    runtime: Pick<PersonVmRuntimePort, 'readiness' | 'activity'> & {
      /** Fence observations and join their actual work/subscriptions. */
      close(): Promise<void>;
    };
    nativeActivity?: PersonVmNativeActivityPort;
    egress: {
      authority: EgressAuthority;
      policy: EgressPolicy;
      transport: EgressTransport;
      /** Actual installed model owner revoke/drain, never an empty callback. */
      revokeModel: EgressDependencies['revokeModel'];
      services?: readonly ManagedHostService[];
      /** After gateway revoke/drain, close the real model/route owner. */
      close(): Promise<void>;
    };
  }>;
}>;
type BoundSources = Awaited<ReturnType<ProductionPersonVmHostSources['bind']>>;

/** Real inert construction and narrow-port installation. Required authorities
 * must already have formal producers; missing ones leave ALL ports uninstalled.
 * This does not start a VM, create an execution or acquire a business permit. */
export function createProductionPersonVmHost(input: {
  lifetime: AbortSignal;
  sources?: ProductionPersonVmHostSources;
}): Promise<{ close(): Promise<void> }> {
  if (!input.sources)
    return Promise.reject(
      new ProductionPersonVmHostUnavailable('HOST_SOURCES_UNAVAILABLE'),
    );
  const sources = input.sources;
  const stopped = new AbortController();
  const lifetime = AbortSignal.any([input.lifetime, stopped.signal]);
  let finishConstruction: () => void = () => {
    throw Error('PERSON_VM_HOST_CONSTRUCTION_NOT_INITIALIZED');
  };
  const prepared = new Promise<void>((resolve) => {
    finishConstruction = resolve;
  });
  const pending = new Set<Promise<unknown>>();
  const receipts = new Set<PersonVmEgressReceipt>();
  const nativeSubscriptions = new Set<PersonVmAdmissionSubscription>();
  const uncertainPreparation: unknown[] = [];
  let providers: Providers | undefined,
    current: Current | undefined,
    startup: Startup | undefined,
    bound: BoundSources | undefined,
    gateway: ReturnType<typeof createEgressGateway> | undefined,
    installed:
      ReturnType<typeof installAssignedDEntryNativeRuntime> | undefined,
    closing: Promise<void> | undefined;
  function requireGateway() {
    if (!gateway) throw new PersonVmError('EGRESS_UNAVAILABLE');
    return gateway;
  }
  function requireStartup() {
    if (!startup) throw new PersonVmError('RUNTIME_NOT_READY');
    return startup;
  }
  function requireRuntime() {
    if (!bound) throw new PersonVmError('RUNTIME_NOT_READY');
    return bound.runtime;
  }
  function own<T>(work: () => Promise<T>) {
    const operation = Promise.resolve().then(work);
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  }
  async function currentWork<T>(
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
  ) {
    const active = AbortSignal.any([signal, lifetime]);
    active.throwIfAborted();
    const result = await Promise.resolve()
      .then(() => {
        active.throwIfAborted();
        return work(active);
      })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    if ('error' in result) {
      if (active.aborted && !Object.is(result.error, active.reason))
        throw new AggregateError(
          [result.error, active.reason],
          'PERSON_VM_HOST_OPERATION_FAILED',
        );
      throw result.error;
    }
    active.throwIfAborted();
    return result.value;
  }
  const egress: PersonVmEgressPort = {
    prepare(binding, preparation, signal) {
      return own(async () => {
        const active = AbortSignal.any([signal, lifetime]);
        active.throwIfAborted();
        const receipt = await requireGateway()
          .prepare(binding, preparation, active)
          .catch((error: unknown) => {
            // The gateway preserves a failed prepare plus failed retirement
            // as AggregateError. Without its private receipt no outer owner can
            // certify that unknown state closed; retain that original failure.
            if (error instanceof AggregateError)
              uncertainPreparation.push(error);
            throw error;
          });
        // Register actual late success before cancellation can discard it.
        receipts.add(receipt);
        active.throwIfAborted();
        return receipt;
      });
    },
    assertActive(receipt, signal) {
      return own(async () => {
        const active = AbortSignal.any([signal, lifetime]);
        active.throwIfAborted();
        await requireGateway().assertActive(receipt, active);
        active.throwIfAborted();
      });
    },
    revoke(receipt, reason, signal) {
      // Genuine service failure cleanup has its own non-aborted cleanup scope.
      // Host shutdown must not make that existing cleanup impossible.
      return own(async () => {
        await requireGateway().revoke(receipt, reason, signal);
        // The service freezes fresh copies before saving and cleanup. Remove
        // only this exact value after actual revoke succeeds, never a new epoch.
        for (const retained of receipts)
          if (
            retained.bindingId === receipt.bindingId &&
            sameVmBinding(retained.binding, receipt.binding) &&
            retained.gatewayPorts.length === receipt.gatewayPorts.length &&
            retained.gatewayPorts.every(
              (port, index) => port === receipt.gatewayPorts[index],
            )
          )
            receipts.delete(retained);
      });
    },
  };
  function close(): Promise<void> {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      // Construction may be held in real I/O. Join it before taking the owner
      // snapshot; a late returned source must never escape rollback.
      await prepared;
      const errors: unknown[] = [];
      async function settle(tasks: (() => Promise<unknown>)[]) {
        const results = await Promise.allSettled(
          tasks.map((task) => Promise.resolve().then(task)),
        );
        for (const result of results)
          if (result.status === 'rejected') errors.push(result.reason);
      }
      // Each close fences its own ingress synchronously and joins owned work.
      const installation = installed,
        authorityOwner = current,
        startupOwner = startup,
        sourceOwner = bound;
      await settle([
        ...(installation ? [() => installation.close()] : []),
        ...(authorityOwner ? [() => authorityOwner.close()] : []),
        ...(startupOwner ? [() => startupOwner.close()] : []),
        ...(sourceOwner ? [() => sourceOwner.runtime.close()] : []),
        ...[...nativeSubscriptions].map(
          (subscription) => () => subscription.close(),
        ),
      ]);
      while (pending.size) await Promise.allSettled([...pending]);
      await settle(
        [...nativeSubscriptions].map(
          (subscription) => () => subscription.close(),
        ),
      );
      if (gateway && providers) {
        const cleanup = AbortSignal.timeout(
          providers.configuration.lifecycle.cleanupTimeoutMs,
        );
        await settle(
          [...receipts].map(
            (receipt) => () => egress.revoke(receipt, 'failure', cleanup),
          ),
        );
      }
      // Model/source transports close only after all gateway calls revoke/drain.
      // No VM stop/delete or assertion of guest termination is made here.
      const providerOwner = providers;
      await settle([
        ...(sourceOwner ? [() => sourceOwner.egress.close()] : []),
        ...(providerOwner
          ? [() => providerOwner.egressInstallation.close()]
          : []),
      ]);
      errors.push(...uncertainPreparation);
      input.lifetime.removeEventListener('abort', aborted);
      if (errors.length)
        throw new AggregateError(errors, 'PERSON_VM_HOST_CLOSE_INCOMPLETE');
    });
    stopped.abort(new ProductionPersonVmHostUnavailable('HOST_CLOSED'));
    return closing;
  }
  const aborted = () => {
    void close().catch(() => {});
  };
  input.lifetime.addEventListener('abort', aborted, { once: true });
  const construction = (async () => {
    try {
      lifetime.throwIfAborted();
      providers = await createProductionPersonVmProviders(lifetime);
      lifetime.throwIfAborted();
      current = createProductionPersonVmAuthority(lifetime);
      // The shared client supplies trusted connection options only. Every
      // actual store/admission operation opens its own dedicated SQL client.
      const trustedDatabase = getDatabase();
      const openSql = () => createDedicatedDatabase(trustedDatabase);
      const store = new PostgresPersonVmStore(openSql);
      const runtime: PersonVmRuntimePort = {
        memoryGuestPlan: (...args) => requireStartup().memoryGuestPlan(...args),
        start: (...args) => requireStartup().start(...args),
        retireAfterNativeStop: (...args) =>
          requireStartup().retireAfterNativeStop(...args),
        readiness: (binding, signal) =>
          own(() =>
            currentWork(signal, (active) =>
              requireRuntime().readiness(binding, active),
            ),
          ),
        activity: (binding, signal) =>
          own(() =>
            currentWork(signal, (active) =>
              requireRuntime().activity(binding, active),
            ),
          ),
      };
      const vm = new PersonVmService({
        store,
        authority: current.authority,
        native: providers.native,
        disk: providers.disk,
        nativeWeb: personNativeWebRoster,
        runtime,
        egress,
        ...providers.configuration.lifecycle,
      });
      startup = createAssignedNativeWebStartup({
        vm,
        memoryGuestPlan: providers.memoryGuestPlan,
        configuration: {
          ...providers.configuration.web,
          publicUrl: sources.publicUrl,
        },
        lifetime,
        cleanupTimeoutMs: providers.configuration.lifecycle.cleanupTimeoutMs,
      });
      const admission = vm.createAdmissionHost({
        openSql,
        idleMs: providers.platform.idleMs,
        nativeActivity: {
          observe(binding, signal) {
            return own(() =>
              currentWork(signal, async (active) => {
                if (!bound?.nativeActivity)
                  throw new PersonVmError('ACTIVITY_UNKNOWN');
                return bound.nativeActivity.observe(binding, active);
              }),
            );
          },
          subscribe(binding, signal) {
            return own(async () => {
              const active = AbortSignal.any([signal, lifetime]);
              active.throwIfAborted();
              if (!bound?.nativeActivity)
                throw new PersonVmError('ACTIVITY_UNKNOWN');
              const subscription = await bound.nativeActivity.subscribe(
                binding,
                active,
              );
              nativeSubscriptions.add(subscription);
              if (active.aborted) {
                try {
                  await subscription.close();
                } catch (cleanup) {
                  throw new AggregateError(
                    [active.reason, cleanup],
                    'PERSON_VM_HOST_SUBSCRIPTION_CLOSE_FAILED',
                  );
                }
                nativeSubscriptions.delete(subscription);
                active.throwIfAborted();
              }
              return subscription;
            });
          },
        },
      });
      bound = await sources.bind({
        vm,
        admission,
        startup,
        current,
        providers,
        lifetime,
      });
      lifetime.throwIfAborted();
      // The same shared boundary owns all egress calls. Sources may never
      // replace it or supply a different VM/store/connection factory.
      gateway = createEgressGateway({
        vm,
        admission,
        authority: bound.egress.authority,
        policy: bound.egress.policy,
        transport: bound.egress.transport,
        revokeModel: bound.egress.revokeModel,
        services: bound.egress.services,
        provisioner: providers.egressInstallation.provisioner,
      });
      lifetime.throwIfAborted();
      installed = installAssignedDEntryNativeRuntime({
        vm,
        startup,
        lifetime,
        prewarmCurrent: createProductionCurrentPrewarm({ vm, current }),
      });
      lifetime.throwIfAborted();
      return Object.freeze({ close });
    } finally {
      finishConstruction();
    }
  })();
  return construction.catch(async (primary: unknown) => {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [primary, cleanup],
        'PERSON_VM_HOST_CONSTRUCTION_FAILED',
      );
    }
    throw primary;
  });
}
