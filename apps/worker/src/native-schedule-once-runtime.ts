import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type {
  NativeOnceClosedProof,
  NativeOnceSqlOptions,
} from '@allrice/database';
import {
  createNativeScheduleOnceController,
  NativeScheduleOnceError,
  openPublicNativeScheduleOnceHost,
  type NativeScheduleControlReference,
  type NativeScheduleControlSource,
  type NativeScheduleHostFactory,
  type NativeScheduleHostModule,
  type NativeScheduleOnceStore,
  type NativeScheduleWriter,
} from './native-schedule-once.js';

export const NATIVE_ONCE_CONSUMER_LIMIT = 8;
const CONSUMER_BUDGET_MS = 1_000;

export interface NativeOnceWorkerRuntimeOptions {
  workerId: string;
  /** Deployment must approve this exact artifact/profile/storage tuple. */
  reference: NativeScheduleControlReference;
  /** No current-package, environment URL or probe-module fallback. */
  loadModules: NativeScheduleControlSource['loadModules'];
  /** Private exact-artifact AllRice adapter; never an environment URL. */
  loadHostFactory: NativeScheduleControlSource['loadHostFactory'];
  enabled: boolean;
}

export interface NativeOncePartitionActivation {
  partitionId: string;
  reference: NativeScheduleControlReference;
  /** Read back from the exact persisted partition; not inferred from its ID. */
  activation: {
    enabled: boolean;
    storageReady: boolean;
    legacyClockExcluded: boolean;
    controlArtifactApproved: boolean;
  };
}

export interface NativeOnceWorkerDatabasePorts {
  getDatabase(): NativeOnceSqlOptions['db'];
  createNativeOnceSqlStore(
    options: NativeOnceSqlOptions,
  ): NativeScheduleOnceStore;
  nativeOnceDigest(value: unknown): string;
  lockNativeOnceAdmissions: NativeOnceSqlOptions['lockAdmission'];
  /** Must verify the exact reference and persisted activation, including the
   * product's legacy-clock exclusion. It must not close an old writer. */
  initializeNativeOncePartition(
    reference: NativeScheduleControlReference,
  ): Promise<NativeOncePartitionActivation>;
  /** Consumes an existing native receipt, never scans SQL schedule due times. */
  dispatchNextNativeOnceOccurrence(workerId: string): Promise<boolean>;
}

/** Explicit unit-test seams; these are never read from deployment settings. */
export interface NativeOnceWorkerRuntimeTestPorts {
  loadDatabase?: () => Promise<NativeOnceWorkerDatabasePorts>;
  hostFactory?: NativeScheduleHostFactory;
  verifyStorageRoot?: (path: string) => Promise<void>;
  now?: () => number;
}

type Phase = 'initialization' | 'controller' | 'consumer' | 'shutdown';
export interface NativeOnceWorkerRuntimeFault {
  phase: Phase;
  code: string;
  at: string;
}
export class NativeOnceWorkerRuntimeError extends Error {
  constructor(readonly fault: NativeOnceWorkerRuntimeFault) {
    super('NATIVE_ONCE_WORKER_' + fault.phase + '_' + fault.code);
  }
}

async function productionDatabase(
  profileId: string,
): Promise<NativeOnceWorkerDatabasePorts> {
  if (profileId === 'allrice-recurring-control-v1') {
    const db = await import('@allrice/database');
    assertDatabaseApis(db, [
      'getDatabase',
      'nativeOnceDigest',
      'lockNativeOnceAdmissions',
      'initializeNativeRecurringPartition',
      'dispatchNextNativeRecurringOccurrence',
      'createNativeRecurringSqlStore',
      'lockNativeRecurringAdmissions',
    ]);
    // Keep the lifecycle independent of the document/receipt format. The exact
    // profile selects a fixed in-repository adapter, never a fallback backend.
    return {
      getDatabase: db.getDatabase,
      nativeOnceDigest: db.nativeOnceDigest,
      lockNativeOnceAdmissions: db.lockNativeOnceAdmissions,
      initializeNativeOncePartition: db.initializeNativeRecurringPartition,
      dispatchNextNativeOnceOccurrence:
        db.dispatchNextNativeRecurringOccurrence,
      createNativeOnceSqlStore(options) {
        const store = db.createNativeRecurringSqlStore({
          ...options,
          lockAdmission: db.lockNativeRecurringAdmissions,
        });
        return {
          ...store,
          commitMutation(writer, write) {
            if (write.mutation.kind === 'reject_command')
              return Promise.resolve('rejected');
            return store.commitMutation(writer, {
              ...write,
              mutation: write.mutation,
            });
          },
          readExactCommit(writer, write) {
            if (write.mutation.kind === 'reject_command')
              return Promise.resolve('unknown');
            return store.readExactCommit(writer, {
              ...write,
              mutation: write.mutation,
            });
          },
        };
      },
    };
  }
  if (profileId !== 'allrice-once-control-v1')
    throw new Error('binding_invalid');
  const module: unknown = await import('@allrice/database');
  const required = [
    'getDatabase',
    'createNativeOnceSqlStore',
    'nativeOnceDigest',
    'lockNativeOnceAdmissions',
    'initializeNativeOncePartition',
    'dispatchNextNativeOnceOccurrence',
  ];
  assertDatabaseApis(module, required);
  return module as NativeOnceWorkerDatabasePorts;
}

function assertDatabaseApis(module: unknown, required: readonly string[]) {
  if (
    !module ||
    typeof module !== 'object' ||
    required.some(
      (name) => typeof (module as Record<string, unknown>)[name] !== 'function',
    )
  )
    throw new Error('database_api_unavailable');
}

async function verifyStorageRoot(path: string) {
  if (!(await stat(path)).isDirectory()) throw new Error('storage_unavailable');
  await access(path, constants.R_OK | constants.W_OK);
}

function safeCode(error: unknown, fallback: string) {
  if (error instanceof NativeScheduleOnceError) return error.code;
  if (error instanceof NativeOnceWorkerRuntimeError) return error.fault.code;
  if (error instanceof Error) {
    if (
      [
        'database_api_unavailable',
        'binding_invalid',
        'storage_unavailable',
        'close_proof_unavailable',
        'controller_blocked',
      ].includes(error.message)
    )
      return error.message;
    // Report SQLSTATE, never a driver message/DSN or provider credential.
    if ('code' in error && /^[0-9A-Z]{5}$/.test(String(error.code)))
      return String(error.code);
  }
  return fallback;
}

/** The caller owns the polling loop and the existing database pool. tick() calls
 * coalesce, and stop() drains the current tick before closing the control Host.
 * An expired unclosed writer is left untouched for controlled recovery. */
export function createNativeOnceWorkerRuntime(
  options: NativeOnceWorkerRuntimeOptions,
  testPorts: NativeOnceWorkerRuntimeTestPorts = {},
) {
  const enabled = options.enabled === true;
  const workerId = options.workerId;
  const reference = Object.freeze(structuredClone(options.reference));
  const loadModules = options.loadModules;
  const loadHostFactory = options.loadHostFactory;
  const now = testPorts.now ?? (() => performance.now());
  let modules:
    ReturnType<NativeScheduleControlSource['loadModules']> | undefined;
  let hostFactoryModule: Promise<NativeScheduleHostModule> | undefined;
  const source: NativeScheduleControlSource = {
    reference,
    loadHostFactory() {
      hostFactoryModule ??= Promise.resolve().then(loadHostFactory);
      return hostFactoryModule;
    },
    loadModules() {
      modules ??= Promise.resolve().then(loadModules);
      return modules;
    },
  };
  let database: NativeOnceWorkerDatabasePorts | undefined;
  let controller:
    ReturnType<typeof createNativeScheduleOnceController> | undefined;
  let stopRequested = false,
    closed = false,
    shutdownFailed = false,
    initializing = false,
    tickCount = 0,
    faultCount = 0,
    processedCount = 0;
  let lastFault: NativeOnceWorkerRuntimeFault | undefined;
  type TickResult = { processed: number; limitReached: boolean };
  let inFlight: Promise<TickResult> | undefined;
  let stopping: Promise<void> | undefined;
  const empty = (): TickResult => ({ processed: 0, limitReached: false });
  function fault(phase: Phase, error: unknown): never {
    lastFault = {
      phase,
      code: safeCode(error, phase + '_failed'),
      at: new Date().toISOString(),
    };
    faultCount++;
    throw new NativeOnceWorkerRuntimeError({ ...lastFault });
  }

  async function initialize() {
    if (controller || stopRequested) return;
    initializing = true;
    try {
      if (
        typeof loadModules !== 'function' ||
        typeof loadHostFactory !== 'function' ||
        typeof workerId !== 'string' ||
        !workerId.trim() ||
        workerId.length > 256 ||
        Object.keys(reference).length !== 4 ||
        !Object.values(reference).every(
          (value) => typeof value === 'string' && value.length > 0,
        ) ||
        !isAbsolute(reference.stateRoot)
      )
        throw new Error('binding_invalid');
      const loaded = await source.loadModules();
      await (testPorts.verifyStorageRoot ?? verifyStorageRoot)(
        reference.stateRoot,
      );
      if (stopRequested) return;
      const db = testPorts.loadDatabase
        ? await testPorts.loadDatabase()
        : await productionDatabase(reference.profileId);
      if (stopRequested) return;
      const initialized = await db.initializeNativeOncePartition(reference);
      if (stopRequested) return;
      if (
        !initialized ||
        typeof initialized.partitionId !== 'string' ||
        !initialized.partitionId.length ||
        initialized.partitionId.length > 512 ||
        db.nativeOnceDigest(initialized.reference) !==
          db.nativeOnceDigest(reference) ||
        !initialized.activation ||
        Object.keys(initialized.activation).length !== 4 ||
        ![
          'enabled',
          'storageReady',
          'legacyClockExcluded',
          'controlArtifactApproved',
        ].every(
          (key) =>
            initialized.activation[
              key as keyof NativeOncePartitionActivation['activation']
            ] === true,
        )
      )
        throw new Error('binding_invalid');
      const { partitionId } = initialized;
      const activation = Object.freeze(structuredClone(initialized.activation));
      type Generation = {
        key: string;
        hostClosedAt?: string;
        scheduleBackendDrainedAt?: string;
        auxiliaryBackendDrainedAt?: string;
        backendDrainedAt?: string;
        releaseBoundaryAt?: string;
        proof?: NativeOnceClosedProof;
      };
      let generation: Generation | undefined;
      const writerKey = (writer: NativeScheduleWriter) =>
        db.nativeOnceDigest({
          partitionId: writer.partitionId,
          ownerId: writer.ownerId,
          epoch: writer.epoch,
          tokenDigest: db.nativeOnceDigest(writer.token),
        });
      const sqlStore = db.createNativeOnceSqlStore({
        db: db.getDatabase(),
        partitionId,
        ownerId: workerId,
        reference,
        // Preserve each verified persisted fact. SQL intersects this snapshot
        // with the current activation again on every writer admission.
        readiness: () => ({
          enabled: enabled && activation.enabled,
          storageReady: activation.storageReady,
          legacyClockExcluded: activation.legacyClockExcluded,
          controlArtifactApproved: activation.controlArtifactApproved,
        }),
        decodeTask: (value) =>
          loaded.schedule.scheduleDomain.tables.tasks.valueSchema.parse(value),
        lockAdmission: db.lockNativeOnceAdmissions,
        async proveClosed(writer) {
          const g = generation;
          if (
            !g ||
            g.key !== writerKey(writer) ||
            !g.hostClosedAt ||
            !g.scheduleBackendDrainedAt ||
            !g.auxiliaryBackendDrainedAt ||
            !g.backendDrainedAt ||
            !g.releaseBoundaryAt
          )
            return null;
          g.proof ??= {
            kind: 'public_host_backend_drained',
            proofId: randomUUID(),
            partitionId: writer.partitionId,
            ownerId: writer.ownerId,
            epoch: writer.epoch,
            tokenDigest: db.nativeOnceDigest(writer.token),
            evidence: {
              contract:
                'public_schedule_sdk_root_close_then_both_backends_and_writes',
              referenceDigest: db.nativeOnceDigest(reference),
              publicHostCloseCompletedAt: g.hostClosedAt,
              scheduleBackendDrainCompletedAt: g.scheduleBackendDrainedAt,
              auxiliaryBackendDrainCompletedAt: g.auxiliaryBackendDrainedAt,
              backendDrainCompletedAt: g.backendDrainedAt,
              controllerReleaseBoundaryAt: g.releaseBoundaryAt,
            },
          };
          return structuredClone(g.proof);
        },
      });
      if (
        typeof sqlStore.loadWorkspaceUnit !== 'function' ||
        typeof sqlStore.commitWorkspaceWrite !== 'function'
      )
        throw new Error('database_api_unavailable');
      const store: NativeScheduleOnceStore = {
        ...sqlStore,
        async acquireWriter() {
          const grant = await sqlStore.acquireWriter();
          if (grant) generation = { key: writerKey(grant.writer) };
          return grant;
        },
        async releaseClosedWriter(writer) {
          const g = generation;
          if (
            !g ||
            g.key !== writerKey(writer) ||
            !g.hostClosedAt ||
            !g.scheduleBackendDrainedAt ||
            !g.auxiliaryBackendDrainedAt ||
            !g.backendDrainedAt
          )
            throw new Error('close_proof_unavailable');
          // The controller invokes this ONLY after public Host.close(), backend
          // close, and its command/SQL write drain. This is not a TTL inference.
          g.releaseBoundaryAt ??= new Date().toISOString();
          await sqlStore.releaseClosedWriter(writer);
        },
      };
      const hostFactory: NativeScheduleHostFactory = async (input) => {
        const g = generation;
        if (!g) throw new Error('close_proof_unavailable');
        const trackBackend = (
          key: 'backend' | 'auxiliaryBackend',
          field: 'scheduleBackendDrainedAt' | 'auxiliaryBackendDrainedAt',
        ) => {
          const backend = input[key];
          const close = backend.close.bind(backend);
          backend.close = async () => {
            await close();
            g[field] ??= new Date().toISOString();
            if (g.scheduleBackendDrainedAt && g.auxiliaryBackendDrainedAt)
              g.backendDrainedAt ??= new Date().toISOString();
          };
        };
        trackBackend('backend', 'scheduleBackendDrainedAt');
        trackBackend('auxiliaryBackend', 'auxiliaryBackendDrainedAt');
        const host = await (
          testPorts.hostFactory ?? openPublicNativeScheduleOnceHost
        )(input);
        return {
          ...host,
          async close() {
            // The concrete public Host drains Schedule.dispose, SDK.shutdown,
            // then root.dispose in order; any failure rejects this completion.
            await host.close();
            g.hostClosedAt = new Date().toISOString();
          },
        };
      };
      controller = createNativeScheduleOnceController({
        enabled,
        store,
        source,
        hostFactory,
      });
      database = db;
    } finally {
      initializing = false;
    }
  }

  async function runTick(): Promise<TickResult> {
    tickCount++;
    try {
      await initialize();
    } catch (error) {
      fault('initialization', error);
    }
    if (stopRequested || !controller || !database) return empty();
    try {
      await controller.tick();
      if (controller.status().state === 'blocked')
        throw new Error('controller_blocked');
    } catch (error) {
      fault('controller', error);
    }
    const deadline = now() + CONSUMER_BUDGET_MS;
    let processed = 0;
    try {
      while (
        !stopRequested &&
        processed < NATIVE_ONCE_CONSUMER_LIMIT &&
        now() < deadline
      ) {
        if (!(await database.dispatchNextNativeOnceOccurrence(workerId))) break;
        processed++;
        processedCount++;
      }
    } catch (error) {
      fault('consumer', error);
    }
    return {
      processed,
      limitReached:
        processed === NATIVE_ONCE_CONSUMER_LIMIT ||
        (processed > 0 && now() >= deadline),
    };
  }

  return {
    tick(): Promise<TickResult> {
      if (!enabled || stopRequested) return Promise.resolve(empty());
      if (inFlight) return inFlight;
      const pending = runTick();
      inFlight = pending;
      void pending
        .finally(() => {
          if (inFlight === pending) inFlight = undefined;
        })
        .catch(() => undefined);
      return pending;
    },
    stop(): Promise<void> {
      stopRequested = true;
      stopping ??= (async () => {
        await inFlight?.catch(() => undefined);
        try {
          await controller?.stop();
          closed = true;
        } catch (error) {
          shutdownFailed = true;
          fault('shutdown', error);
        }
      })();
      return stopping;
    },
    status() {
      const host = controller?.status();
      return {
        state: !enabled
          ? 'disabled'
          : shutdownFailed || host?.state === 'blocked'
            ? 'blocked'
            : closed
              ? 'closed'
              : stopRequested
                ? 'stopping'
                : initializing
                  ? 'starting'
                  : (host?.state ?? 'cold'),
        inFlight: !!inFlight,
        tickCount,
        processedCount,
        faultCount,
        lastFault: lastFault ? { ...lastFault } : undefined,
        controller: host,
      };
    },
  };
}
