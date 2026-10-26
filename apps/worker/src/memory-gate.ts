import {
  readHostMemory,
  type HostMemory,
  type MemoryPressure,
} from './host-memory.js';

const MiB = 1024 ** 2;
/** sysctl runs at most this often however short the poll interval is. */
const sampleMs = 2_000;
const pausedLogMs = 60_000;
const unreadableLogMs = 600_000;
const pressureRank = { normal: 0, warn: 1, critical: 2 } as const;

export type MemoryGateSettings = {
  minAvailableBytes: number;
  pausePressure: Exclude<MemoryPressure, 'normal'> | 'off';
};
export type MemoryAdmission = {
  /** foreground: memory is under warning pressure, background work waits. */
  claim: 'all' | 'foreground' | 'none';
  reason: 'available_below_minimum' | `pressure_${MemoryPressure}` | null;
  memory: HostMemory;
};

/** ALLRICE_WORKER_MIN_AVAILABLE_MEMORY_MB (default 256, 0 disables) and
 * ALLRICE_WORKER_MEMORY_PAUSE_PRESSURE (warn | critical | off, default
 * critical). Invalid values stop startup, like the other Worker settings. */
export function memoryGateSettings(
  env: NodeJS.ProcessEnv = process.env,
): MemoryGateSettings {
  const mb = Number(env.ALLRICE_WORKER_MIN_AVAILABLE_MEMORY_MB ?? 256);
  if (!Number.isInteger(mb) || mb < 0 || mb > 1_048_576)
    throw Error(
      'ALLRICE_WORKER_MIN_AVAILABLE_MEMORY_MB must be an integer between 0 and 1048576',
    );
  const pausePressure = env.ALLRICE_WORKER_MEMORY_PAUSE_PRESSURE ?? 'critical';
  if (
    pausePressure !== 'warn' &&
    pausePressure !== 'critical' &&
    pausePressure !== 'off'
  )
    throw Error(
      'ALLRICE_WORKER_MEMORY_PAUSE_PRESSURE must be warn, critical or off',
    );
  return { minAvailableBytes: mb * MiB, pausePressure };
}

export function memoryAdmission(
  memory: HostMemory,
  settings: MemoryGateSettings,
): MemoryAdmission {
  if (memory.availableBytes < settings.minAvailableBytes)
    return { claim: 'none', reason: 'available_below_minimum', memory };
  if (memory.pressure && settings.pausePressure !== 'off') {
    const reason = `pressure_${memory.pressure}` as const;
    if (pressureRank[memory.pressure] >= pressureRank[settings.pausePressure])
      return { claim: 'none', reason, memory };
    if (memory.pressure !== 'normal')
      return { claim: 'foreground', reason, memory };
  }
  return { claim: 'all', reason: null, memory };
}

/** Claim admission by real memory pressure. Reads are cached for two seconds,
 * and a pause is logged when it starts, once a minute while it lasts, and when
 * it ends, with the figures that caused it. */
export function createMemoryGate(input: {
  settings: MemoryGateSettings;
  read?: () => Promise<HostMemory>;
  now?: () => number;
  log?: (message: string, details: Record<string, unknown>) => void;
}) {
  const read = input.read ?? (() => readHostMemory());
  const now = input.now ?? Date.now;
  const log =
    input.log ??
    ((message: string, details: Record<string, unknown>) =>
      console.warn(message, details));
  let cached: { at: number; memory: HostMemory } | null = null;
  let reading: Promise<HostMemory> | null = null;
  let paused: {
    since: number;
    loggedAt: number;
    key: string;
    checks: number;
  } | null = null;
  let unreadableLoggedAt = -Infinity;

  const details = (admission: MemoryAdmission) => ({
    claim: admission.claim,
    reason: admission.reason,
    source: admission.memory.source,
    pressure: admission.memory.pressure,
    availableMiB: Math.floor(admission.memory.availableBytes / MiB),
    minAvailableMiB: Math.floor(input.settings.minAvailableBytes / MiB),
    pausePressure: input.settings.pausePressure,
  });
  function observe(admission: MemoryAdmission) {
    const at = now();
    if (admission.memory.error && at - unreadableLoggedAt >= unreadableLogMs) {
      unreadableLoggedAt = at;
      log('[MET-219] memory pressure unreadable, using availableMemory()', {
        error: admission.memory.error,
      });
    }
    if (admission.claim === 'all') {
      if (paused)
        log('[MET-219] memory gate resumed claims', {
          ...details(admission),
          pausedMs: at - paused.since,
          checks: paused.checks,
        });
      paused = null;
      return;
    }
    const key = `${admission.claim}:${admission.reason}`;
    if (paused?.key === key) {
      paused.checks += 1;
      if (at - paused.loggedAt < pausedLogMs) return;
      paused.loggedAt = at;
      log('[MET-219] memory gate still pausing claims', {
        ...details(admission),
        pausedMs: at - paused.since,
        checks: paused.checks,
      });
      return;
    }
    paused = { since: paused?.since ?? at, loggedAt: at, key, checks: 1 };
    log('[MET-219] memory gate paused claims', details(admission));
  }

  return {
    async admission(): Promise<MemoryAdmission> {
      let memory = cached?.memory;
      if (!cached || now() - cached.at >= sampleMs) {
        reading ??= read().finally(() => {
          reading = null;
        });
        memory = await reading;
        cached = { at: now(), memory };
      }
      const admission = memoryAdmission(memory!, input.settings);
      observe(admission);
      return admission;
    },
  };
}
export type MemoryGate = ReturnType<typeof createMemoryGate>;

/** One queue tick: claim until the slots are full, the queue is empty or
 * memory says stop. Background work also keeps one slot for foreground. */
export async function claimUnderMemoryGate<
  J extends { lease?: { token: string } | null },
>(input: {
  gate: Pick<MemoryGate, 'admission'>;
  concurrency: number;
  active: () => number;
  stopping: () => boolean;
  claim: (options: { allowBackground: boolean }) => Promise<J | null>;
  start: (job: J, leaseToken: string) => void;
}) {
  while (!input.stopping() && input.active() < input.concurrency) {
    const admission = await input.gate.admission();
    if (admission.claim === 'none') return;
    const job = await input.claim({
      allowBackground:
        admission.claim === 'all' &&
        input.concurrency > 1 &&
        input.active() < input.concurrency - 1,
    });
    const leaseToken = job?.lease?.token;
    if (!job || !leaseToken) return;
    input.start(job, leaseToken);
  }
}
