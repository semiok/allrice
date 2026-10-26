import { execFile, execFileSync } from 'node:child_process';
import { freemem } from 'node:os';
import { promisify } from 'node:util';

/** How much memory the host can still give new jobs, plus the kernel's own
 * verdict where the OS has one (MET-219).
 *
 * On macOS libuv's availableMemory() and os.freemem() count only free pages.
 * They routinely sit below 256 MB on a healthy machine whose file cache is
 * reclaimable, which held due reminders back for up to 52 s. There we read,
 * with one unprivileged sysctl, the kernel pressure level (1 normal, 2 warn,
 * 4 critical; the signal behind DISPATCH_SOURCE_TYPE_MEMORYPRESSURE) and the
 * pages jetsam counts as available: free, speculative, pageable file-backed
 * and purgeable. That is the closest match to Linux MemAvailable; the
 * `memory_pressure` free percentage would also count app memory as free.
 * Elsewhere libuv already reports MemAvailable or the cgroup headroom, which
 * stays the figure we use. */
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
  availableMemory: () => number;
  memorystatus: () => Promise<string>;
  memorystatusSync: () => string;
};

const sysctl = '/usr/sbin/sysctl';
const sysctlArgs = [
  '-n',
  'kern.memorystatus_vm_pressure_level',
  'vm.page_free_count',
  'vm.page_speculative_count',
  'vm.page_pageable_external_count',
  'vm.page_purgeable_count',
  'hw.pagesize',
];
const sysctlTimeoutMs = 2_000;
const pressureLevels: Record<string, MemoryPressure> = {
  '1': 'normal',
  '2': 'warn',
  '4': 'critical',
};

export const systemMemoryProbe: HostMemoryProbe = {
  platform: process.platform,
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

export function parseMemorystatus(output: string): HostMemory {
  const fields = output.trim().split(/\s+/);
  const [level, ...counts] = fields;
  const pressure = pressureLevels[level ?? ''];
  const numbers = counts.map(Number);
  if (
    fields.length !== sysctlArgs.length - 1 ||
    !pressure ||
    !numbers.every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    throw Error(`MEMORYSTATUS_UNREADABLE: ${JSON.stringify(output)}`);
  const [free, speculative, fileBacked, purgeable, pageSize] = numbers as [
    number,
    number,
    number,
    number,
    number,
  ];
  return {
    source: 'memorystatus',
    availableBytes: (free + speculative + fileBacked + purgeable) * pageSize,
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
    return parseMemorystatus(await probe.memorystatus());
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
    return parseMemorystatus(probe.memorystatusSync());
  } catch (error) {
    return libuvMemory(probe, error);
  }
}
