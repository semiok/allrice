import { randomUUID } from 'node:crypto';

export type StartupPhase =
  | 'service_identity'
  | 'native_primary'
  | 'native_launch_policy'
  | 'native_journal_contract'
  | 'producer_lifecycle'
  | 'maintenance_diagnostics'
  | 'database_readiness'
  | 'provider_authorization_recovery'
  | 'provider_probes'
  | 'http_listen';
type Milestone =
  | 'verification_checks_completed'
  | 'ordinary_consumer_entered'
  | 'http_listening'
  | 'health_ready'
  | 'shutdown_requested';
export type VerificationMetric =
  | { kind: 'read'; bytes: number }
  | { kind: 'package' }
  | { kind: 'cache'; hit: boolean };
type Counters = {
  releaseReadOperations: number | null;
  releaseReadBytes: number | null;
  packageInstances: number | null;
  cacheHits: number | null;
  cacheMisses: number | null;
};
export type StartupObservation = {
  schemaVersion: 1;
  bootId: string;
  pid: number;
  sequence: number;
  at: string;
  elapsedMs: number;
  phase: StartupPhase | Milestone | 'entrypoint';
  state: 'started' | 'completed' | 'failed' | 'skipped' | 'milestone';
  slot?: number;
  durationMs?: number;
  processWindowCpuMicros?: { user: number; system: number };
  counters?: Counters;
  failure?: 'operation_failed' | 'operation_aborted' | 'operation_timeout';
  skipped?: 'producer_not_admitted';
};

/** Observation only: no deadlines, retries, environment reads or authority.
 * File counters cover instrumented verifier reads, not OS/child-process I/O.
 * Unknown counters stay null. Error messages/paths/content are never copied. */
export function createWorkerStartupObservation(
  options: {
    bootId?: string;
    pid?: number;
    now?: () => number;
    wallNow?: () => string;
    cpu?: () => NodeJS.CpuUsage;
    emit?: (event: StartupObservation) => void;
  } = {},
) {
  const bootId = options.bootId ?? randomUUID();
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => performance.now());
  const wallNow = options.wallNow ?? (() => new Date().toISOString());
  const cpu = options.cpu ?? (() => process.cpuUsage());
  const emit =
    options.emit ??
    ((event) =>
      console.info('[MET-195] worker startup ' + JSON.stringify(event)));
  const began = now();
  let sequence = 0;
  const milestones = new Set<Milestone>();
  function publish(
    event: Omit<
      StartupObservation,
      'schemaVersion' | 'bootId' | 'pid' | 'sequence' | 'at' | 'elapsedMs'
    >,
  ) {
    try {
      emit({
        schemaVersion: 1,
        bootId,
        pid,
        sequence: ++sequence,
        at: wallNow(),
        elapsedMs: Math.max(0, now() - began),
        ...event,
      });
    } catch {
      // A diagnostic sink cannot turn failed verification into success, or
      // stop an otherwise valid boot. The original operation owns its result.
    }
  }
  publish({ phase: 'entrypoint', state: 'started' });
  function start(phase: StartupPhase, detail: { slot?: number } = {}) {
    const started = now();
    const startedCpu = cpu();
    const slot =
      Number.isInteger(detail.slot) && detail.slot! >= 1 && detail.slot! <= 6
        ? detail.slot
        : undefined;
    const identity = { phase, ...(slot === undefined ? {} : { slot }) };
    const counters: Counters = {
      releaseReadOperations: null,
      releaseReadBytes: null,
      packageInstances: null,
      cacheHits: null,
      cacheMisses: null,
    };
    let finished = false;
    publish({ ...identity, state: 'started' });
    function observe(metric: VerificationMetric) {
      if (finished) return;
      if (
        metric.kind === 'read' &&
        Number.isSafeInteger(metric.bytes) &&
        metric.bytes >= 0
      ) {
        counters.releaseReadOperations =
          (counters.releaseReadOperations ?? 0) + 1;
        counters.releaseReadBytes =
          (counters.releaseReadBytes ?? 0) + metric.bytes;
      } else if (metric.kind === 'package') {
        counters.packageInstances = (counters.packageInstances ?? 0) + 1;
      } else if (metric.kind === 'cache' && typeof metric.hit === 'boolean') {
        counters.cacheHits ??= 0;
        counters.cacheMisses ??= 0;
        if (metric.hit) counters.cacheHits++;
        else counters.cacheMisses++;
      }
    }
    function finish(
      state: 'completed' | 'failed' | 'skipped',
      error?: unknown,
    ) {
      if (finished) return;
      finished = true;
      const endedCpu = cpu();
      let failure: StartupObservation['failure'] = 'operation_failed';
      try {
        if (error instanceof Error && error.name === 'AbortError')
          failure = 'operation_aborted';
        else if (error instanceof Error && error.name === 'TimeoutError')
          failure = 'operation_timeout';
      } catch {
        /* unusual error accessors must not replace the original failure */
      }
      publish({
        ...identity,
        state,
        durationMs: Math.max(0, now() - started),
        processWindowCpuMicros: {
          user: Math.max(0, endedCpu.user - startedCpu.user),
          system: Math.max(0, endedCpu.system - startedCpu.system),
        },
        counters: { ...counters },
        ...(state === 'failed' ? { failure } : {}),
        ...(state === 'skipped'
          ? { skipped: 'producer_not_admitted' as const }
          : {}),
      });
    }
    return {
      observe,
      complete: () => finish('completed'),
      skip: () => finish('skipped'),
      fail: (error?: unknown) => finish('failed', error),
    };
  }
  return {
    bootId,
    start,
    async run<T>(
      phase: StartupPhase,
      body: (observe: (metric: VerificationMetric) => void) => T | Promise<T>,
    ): Promise<T> {
      const span = start(phase);
      try {
        const result = await body(span.observe);
        span.complete();
        return result;
      } catch (error) {
        span.fail(error);
        throw error;
      }
    },
    mark(phase: Milestone) {
      if (milestones.has(phase)) return;
      milestones.add(phase);
      publish({ phase, state: 'milestone' });
    },
  };
}
