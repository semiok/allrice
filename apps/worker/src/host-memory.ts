import { execFile, execFileSync } from 'node:child_process';
import { freemem, totalmem } from 'node:os';
import { promisify } from 'node:util';

/** How much memory the host can still give new jobs, plus the kernel's own
 * verdict where the OS has one (MET-219).
 *
 * On macOS libuv's availableMemory() and os.freemem() count only free pages.
 * They routinely sit below 256 MB on a healthy machine whose file cache is
 * reclaimable, which held due reminders back for up to 52 s. There we read the
 * kernel memorystatus figures instead: the pressure level (1 normal, 2 warn,
 * 4 critical; the signal behind DISPATCH_SOURCE_TYPE_MEMORYPRESSURE) and the
 * system-wide free percentage that `memory_pressure` prints. Both are plain
 * sysctl reads and need no privilege. Elsewhere libuv already reports
 * MemAvailable or the cgroup headroom, which stays the figure we use. */
export type MemoryPressure = 'normal' | 'warn' | 'critical';
export type HostMemory = {
  source: 'memorystatus' | 'available_memory';
  availableBytes: number;
  /** Null where the OS gives no level (Linux). */
  pressure: MemoryPressure | null;
  /** Why memorystatus could not be read; the libuv figure is used instead. */
  error?: string;
};
export type HostMemoryProbe = {
  platform: NodeJS.Platform;
  totalBytes: number;
  availableMemory: () => number;
  memorystatus: () => Promise<string>;
  memorystatusSync: () => string;
};

const sysctl = '/usr/sbin/sysctl';
const sysctlArgs = [
  '-n',
  'kern.memorystatus_vm_pressure_level',
  'kern.memorystatus_level',
];
const sysctlTimeoutMs = 2_000;
const pressureLevels: Record<string, MemoryPressure> = {
  '1': 'normal',
  '2': 'warn',
  '4': 'critical',
};

export const systemMemoryProbe: HostMemoryProbe = {
  platform: process.platform,
  totalBytes: totalmem(),
  availableMemory: () => process.availableMemory?.() ?? freemem(),
  memorystatus: async () =>
    (
      await promisify(execFile)(sysctl, sysctlArgs, {
        encoding: 'utf8',
        timeout: sysctlTimeoutMs,
      })
    ).stdout,
  memorystatusSync: () =>
    execFileSync(sysctl, sysctlArgs, {
      encoding: 'utf8',
      timeout: sysctlTimeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
};

export function parseMemorystatus(
  output: string,
  totalBytes: number,
): HostMemory {
  const fields = output.trim().split(/\s+/);
  const pressure = pressureLevels[fields[0] ?? ''];
  const freePercent = Number(fields[1]);
  if (
    fields.length !== 2 ||
    !pressure ||
    !Number.isInteger(freePercent) ||
    freePercent < 0 ||
    freePercent > 100
  )
    throw Error(`MEMORYSTATUS_UNREADABLE: ${JSON.stringify(output)}`);
  return {
    source: 'memorystatus',
    availableBytes: Math.floor((totalBytes * freePercent) / 100),
    pressure,
  };
}

function libuvMemory(probe: HostMemoryProbe, error?: unknown): HostMemory {
  return {
    source: 'available_memory',
    availableBytes: probe.availableMemory(),
    pressure: null,
    ...(error === undefined
      ? {}
      : { error: error instanceof Error ? error.message : String(error) }),
  };
}

/** Never rejects: an unreadable memorystatus falls back to the libuv figure. */
export async function readHostMemory(
  probe: HostMemoryProbe = systemMemoryProbe,
): Promise<HostMemory> {
  if (probe.platform !== 'darwin') return libuvMemory(probe);
  try {
    return parseMemorystatus(await probe.memorystatus(), probe.totalBytes);
  } catch (error) {
    return libuvMemory(probe, error);
  }
}

/** Startup only (capacity); the claim gate uses the asynchronous read. */
export function readHostMemorySync(
  probe: HostMemoryProbe = systemMemoryProbe,
): HostMemory {
  if (probe.platform !== 'darwin') return libuvMemory(probe);
  try {
    return parseMemorystatus(probe.memorystatusSync(), probe.totalBytes);
  } catch (error) {
    return libuvMemory(probe, error);
  }
}
