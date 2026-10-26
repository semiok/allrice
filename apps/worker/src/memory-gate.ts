import {
  readHostMemory,
  type HostMemory,
  type MemoryPressure,
} from './host-memory.js';

const MiB = 1024 ** 2;
/** macOS: sysctl runs at most this often however short the poll interval is.
 * libuv's figure costs no process, so elsewhere it is read before every
 * claim, as it always was: a job that just started may have used the room. */
const darwinSampleMs = 2_000;
const gateLogMs = 60_000;
const unreadableLogMs = 600_000;
const pressureRank = { normal: 0, warn: 1, critical: 2 } as const;

export type MemoryGateSettings = {
  minAvailableBytes: number;
  pausePressure: Exclude<MemoryPressure, 'normal'> | 'off';
};
export type MemoryAdmission = {
  /** reduced: warning pressure; background work waits and foreground work
   * may fill only half the slots. */
  claim: 'all' | 'reduced' | 'none';
  reason: 'available_below_minimum' | `pressure_${MemoryPressure}` | null;
  memory: HostMemory;
};

/** ALLRICE_WORKER_MIN_AVAILABLE_MEMORY_MB (default 256, 0 disables) and
 * ALLRICE_WORKER_MEMORY_PAUSE_PRESSURE (warn | critical | off, default
 * critical). Empty means default; invalid values stop startup. */
export function memoryGateSettings(
  env: NodeJS.ProcessEnv = process.env,
): MemoryGateSettings {
  const mb = Number(env.ALLRICE_WORKER_MIN_AVAILABLE_MEMORY_MB?.trim() || 256);
  if (!Number.isInteger(mb) || mb < 0 || mb > 1_048_576)
    throw Error(
      'ALLRICE_WORKER_MIN_AVAILABLE_MEMORY_MB must be an integer between 0 and 1048576',
    );
  const pausePressure =
    env.ALLRICE_WORKER_MEMORY_PAUSE_PRESSURE?.trim() || 'critical';
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
      return { claim: 'reduced', reason, memory };
  }
  return { claim: 'all', reason: null, memory };
}

const gateMessages = {
  none: ['paused claims', 'still pausing claims'],
  reduced: ['reduced claims', 'still reducing claims'],
} as const;

/** Claim admission by real memory pressure. Logs say when claims pause, are reduced or resume, with the figures that
 * caused it, at most once a minute; changes in between are counted into the
 * next line, so a reading that hovers at a threshold cannot flood the log. */
export function createMemoryGate(input: {
  settings: MemoryGateSettings;
  read?: () => Promise<HostMemory>;
  sampleMs?: number;
  now?: () => number;
  log?: (message: string, details: Record<string, unknown>) => void;
}) {
  const read = input.read ?? (() => readHostMemory());
  const sampleMs =
    input.sampleMs ?? (process.platform === 'darwin' ? darwinSampleMs : 0);
  const now = input.now ?? Date.now;
  const log =
    input.log ??
    ((message: string, details: Record<string, unknown>) =>
      console.warn(message, details));
  let cached: { at: number; memory: HostMemory } | null = null;
  let reading: Promise<HostMemory> | null = null;
  let state = { key: 'all', since: now() };
  let loggedKey = 'all';
  let loggedAt = -Infinity;
  let changes = 0;
  let restrictedSince: number | null = null;
  let unreadableLoggedAt = -Infinity;

  function observe(admission: MemoryAdmission) {
    const at = now();
    if (admission.memory.error && at - unreadableLoggedAt >= unreadableLogMs) {
      unreadableLoggedAt = at;
      log('[MET-219] memory pressure unreadable, using availableMemory()', {
        error: admission.memory.error,
      });
    }
    const key =
      admission.claim === 'all'
        ? 'all'
        : `${admission.claim}:${admission.reason}`;
    if (key !== state.key) {
      state = { key, since: at };
      changes += 1;
      if (key !== 'all') restrictedSince ??= at;
    }
    if (at - loggedAt < gateLogMs) return;
    if (key === loggedKey && key === 'all') return;
    const details = {
      claim: admission.claim,
      reason: admission.reason,
      source: admission.memory.source,
      pressure: admission.memory.pressure,
      availableMiB: Math.floor(admission.memory.availableBytes / MiB),
      minAvailableMiB: Math.floor(input.settings.minAvailableBytes / MiB),
      pausePressure: input.settings.pausePressure,
      stateMs: at - state.since,
      changes,
    };
    if (admission.claim === 'all') {
      log('[MET-219] memory gate resumed claims', {
        ...details,
        restrictedMs: state.since - (restrictedSince ?? state.since),
      });
      restrictedSince = null;
    } else {
      const [started, ongoing] = gateMessages[admission.claim];
      log(
        `[MET-219] memory gate ${key === loggedKey ? ongoing : started}`,
        details,
      );
    }
    loggedKey = key;
    loggedAt = at;
    changes = 0;
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
    if (input.stopping() || admission.claim === 'none') return;
    if (
      admission.claim === 'reduced' &&
      input.active() >= Math.max(1, Math.floor(input.concurrency / 2))
    )
      return;
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
