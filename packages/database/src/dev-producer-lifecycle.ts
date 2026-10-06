import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DevMaintenanceError,
  devProducerCatalog,
  startDevProducer,
  finishDevProducer,
  compactCompletedDevProducerPermits,
} from './dev-maintenance.ts';
import {
  readServiceBuildIdentity,
  type ServiceBuildIdentity,
  type ServiceBuildRole,
} from './service-build-identity.ts';

type Producer = (typeof devProducerCatalog)[number];
type Start = Parameters<typeof startDevProducer>[0];
type Permit = Awaited<ReturnType<typeof startDevProducer>>;
interface PermitStore {
  start(input: Start): Promise<Permit>;
  finish(permit: Permit): Promise<void>;
  compact?(): Promise<void>;
}
type Root = {
  id: string;
  producer: Producer;
  references: number;
  children: number;
  state: 'pending' | 'active' | 'closing' | 'unknown';
  permit?: Permit;
  settled: Promise<void>;
  settle: () => void;
};
export interface DevProducerContext {
  /** Retain before detaching. The child gets its own bounded ownership; a
   * callback cannot reuse its context after it has returned. */
  child<T>(body: (context: DevProducerContext) => Promise<T>): Promise<T>;
}
const identitySchema = z.object({
  service: z.enum(['web', 'worker']),
  mode: z.literal('production'),
  bootId: z.uuid(),
  manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  pid: z.number().int().positive(),
});

/** Tracks awaited roots only. It is deliberately not a resource-idle proof,
 * ACK, shutdown controller, or a source of host authority. */
export class DevProducerLifecycle {
  private readonly roots = new Map<string, Root>();
  private unresolved = 0;
  private completed = 0;
  private readonly unknown = new Set<string>();

  constructor(
    readonly enabled: boolean,
    readonly role: ServiceBuildRole,
    private readonly identity: ServiceBuildIdentity | null,
    private readonly store: PermitStore = {
      start: startDevProducer,
      finish: finishDevProducer,
      compact: compactCompletedDevProducerPermits,
    },
  ) {
    if (enabled) {
      const value = identitySchema.parse(identity);
      if (value.service !== role || value.pid !== process.pid)
        throw new DevMaintenanceError('dev_control_authority_denied');
    }
  }

  snapshot() {
    if (!this.enabled) return null;
    const roots = [...this.roots.values()];
    return {
      version: 1,
      role: this.role,
      instance: {
        bootId: this.identity!.bootId,
        manifestDigest: this.identity!.manifestDigest,
      },
      scopeCoverage: 'partial' as const,
      // None of the complete catalog families is claimed covered by a root
      // promise alone. Future frame/resource wiring must prove their closure.
      unknownProducers: [...devProducerCatalog],
      pendingRoots: roots.filter((r) => r.state === 'pending').length,
      activeRoots: roots.filter((r) => r.state !== 'pending').length,
      retainedChildren: roots.reduce((n, r) => n + r.children, 0),
      unresolvedRoots: this.unresolved,
      unknownOutcomes: [...this.unknown].sort(),
      releaseAdmission: 'disabled' as const,
    };
  }

  /** Wait for the current awaited roots, including pending admission and
   * retained children. This does not clear unknown outcomes or prove that
   * native clients, sockets, or detached resources have stopped. */
  async waitForCurrentRoots() {
    await Promise.all([...this.roots.values()].map((root) => root.settled));
  }

  async run<T>(
    producer: Producer,
    body: (context: DevProducerContext) => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) return body({ child: (fn) => this.run(producer, fn) });
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const root: Root = {
      id: randomUUID(),
      producer,
      references: 1,
      children: 0,
      state: 'pending',
      settled,
      settle,
    };
    // This happens synchronously before the first database await, and the
    // business thunk is not evaluated before the durable admission commits.
    this.roots.set(root.id, root);
    try {
      const permit = await this.store.start({
        id: root.id,
        instanceBootId: this.identity!.bootId,
        role: this.role,
        producer,
      });
      if (
        permit.id !== root.id ||
        permit.instanceBootId !== this.identity!.bootId ||
        !Number.isSafeInteger(permit.epoch) ||
        permit.epoch < 0
      )
        throw new DevMaintenanceError('dev_barrier_stale');
      root.permit = permit;
      root.state = 'active';
    } catch (error) {
      // Only this pre-insert rejection proves that no permit was written.
      // Other failures, including a lost commit response, never replay work.
      if ((error as { code?: string })?.code !== 'dev_maintenance_requested') {
        this.unknown.add('permit_start_result_unknown');
        this.unresolved++;
      }
      this.roots.delete(root.id);
      root.settle();
      throw error;
    }
    return this.invoke(root, body);
  }

  private async invoke<T>(
    root: Root,
    body: (context: DevProducerContext) => Promise<T>,
    child = false,
  ) {
    let owned = true;
    const context: DevProducerContext = {
      child: <U>(fn: (child: DevProducerContext) => Promise<U>) => {
        if (!owned || !['active', 'unknown'].includes(root.state))
          return Promise.reject(new DevMaintenanceError('dev_barrier_stale'));
        root.references++;
        root.children++;
        return this.invoke(root, fn, true);
      },
    };
    try {
      return await body(context);
    } catch (error) {
      root.state = 'unknown';
      this.unknown.add('business_lifetime_unknown');
      throw error;
    } finally {
      owned = false;
      root.references--;
      if (child) root.children--;
      if (root.references === 0) {
        if (root.state === 'unknown') {
          this.unresolved++;
        } else {
          root.state = 'closing';
          try {
            await this.store.finish(root.permit!);
            if (++this.completed % 256 === 0) {
              // The finish receipt is already known. Compaction failures must
              // neither replay business work nor turn that receipt unknown.
              await this.store.compact?.().catch(() => undefined);
            }
          } catch {
            this.unknown.add('permit_finish_result_unknown');
            this.unresolved++;
          }
        }
        this.roots.delete(root.id);
        root.settle();
      }
    }
  }
}

const registryKey = Symbol.for('allrice.dev.producer-lifecycle.v1');
type RegistryGlobal = typeof globalThis & {
  [registryKey]?: Map<ServiceBuildRole, DevProducerLifecycle>;
};
/** Trusted process startup only. HTTP/model callers cannot supply an identity,
 * coverage array, owner lease or a callback through any API. */
export async function installDevProducerLifecycle(
  role: ServiceBuildRole,
): Promise<DevProducerLifecycle> {
  const enabled = process.env.ALLRICE_DEV_MAINTENANCE_ENABLED === '1';
  if (!enabled) return new DevProducerLifecycle(false, role, null);
  const registry = ((globalThis as RegistryGlobal)[registryKey] ??= new Map<
    ServiceBuildRole,
    DevProducerLifecycle
  >());
  const identity = await readServiceBuildIdentity(role);
  const existing = registry.get(role);
  if (existing) {
    if (
      existing.snapshot()?.instance.bootId !== identity?.bootId ||
      existing.snapshot()?.instance.manifestDigest !== identity?.manifestDigest
    )
      throw new DevMaintenanceError('dev_control_authority_denied');
    return existing;
  }
  const value = new DevProducerLifecycle(true, role, identity);
  registry.set(role, value);
  return value;
}
/** Safe observer, shared by the custom server and the Next bundle. */
export function readDevProducerLifecycle(role: ServiceBuildRole) {
  if (process.env.ALLRICE_DEV_MAINTENANCE_ENABLED !== '1') return null;
  return (
    (globalThis as RegistryGlobal)[registryKey]?.get(role)?.snapshot() ?? null
  );
}
