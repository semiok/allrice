import { createHash } from 'node:crypto';
import type { PersonVmBinding } from '@allrice/person-vm';
import { VmMemoryError } from './contract.ts';

export type VmMemoryHostCapacity = 'parallel' | 'serial' | 'stop';
export type VmMemoryHostVmStat = Readonly<{
  pageBytes: number;
  freePages: number;
  activePages: number;
  inactivePages: number;
  speculativePages: number;
  wiredPages: number;
  compressorPages: number;
}>;
/** Host-wide pressure evidence, not a VM's physical cap or native identity.
 * Binding identifies this subscription; it does not attest a native VM. */
export type VmMemoryHostPressureSample = Readonly<{
  binding: PersonVmBinding;
  revision: string;
  evidenceRef: string;
  policyRef: string;
  state: 'available' | 'unavailable';
  capacity: VmMemoryHostCapacity | null;
  pressureLevel: 1 | 2 | 4 | null;
  freePercent: number | null;
  vmStat: VmMemoryHostVmStat | null;
}>;
export type VmMemoryHostPressureCommand = Readonly<{
  executable:
    '/usr/bin/memory_pressure' | '/usr/bin/vm_stat' | '/usr/sbin/sysctl';
  args: readonly string[];
  signal: AbortSignal;
}>;
/** Bind the existing host CommandRunner with its explicit safe environment.
 * Settlement MUST join the actual utility child, including on abort. */
export type VmMemoryHostPressureCommandRunner = (
  command: VmMemoryHostPressureCommand,
) => Promise<string>;
export interface VmMemoryHostPressureSampleWatch {
  read(): VmMemoryHostPressureSample | null;
  wait(): Promise<void>;
  close(): Promise<void>;
}

const commands = [
  { executable: '/usr/bin/memory_pressure', args: ['-Q'] },
  { executable: '/usr/bin/vm_stat', args: [] },
  {
    executable: '/usr/sbin/sysctl',
    args: ['-n', 'kern.memorystatus_vm_pressure_level'],
  },
] as const;
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

function freePercent(text: string): number {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('System-wide memory free percentage:'));
  if (lines.length !== 1) throw new Error('invalid memory_pressure output');
  const match =
    /^System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%\s*$/.exec(
      lines[0]!,
    );
  const value = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(value) || value < 0 || value > 100)
    throw new Error('invalid free percentage');
  return value;
}

function vmStat(text: string): VmMemoryHostVmStat {
  const lines = text.split(/\r?\n/);
  const headers = lines.filter((line) =>
    line.startsWith('Mach Virtual Memory'),
  );
  const header =
    headers.length === 1 &&
    /^Mach Virtual Memory Statistics: \(page size of ([1-9]\d*) bytes\)\s*$/.exec(
      headers[0]!,
    );
  const pageBytes = header ? Number(header[1]) : NaN;
  if (!Number.isSafeInteger(pageBytes) || pageBytes <= 0)
    throw new Error('invalid vm_stat header');
  const pages = (name: string) => {
    const matches = lines.filter((line) => line.startsWith(`${name}:`));
    const parsed =
      matches.length === 1 &&
      /^\s*(0|[1-9]\d*)\.\s*$/.exec(matches[0]!.slice(name.length + 1));
    const value = parsed ? Number(parsed[1]) : NaN;
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('invalid vm_stat count');
    return value;
  };
  return Object.freeze({
    pageBytes,
    freePages: pages('Pages free'),
    activePages: pages('Pages active'),
    inactivePages: pages('Pages inactive'),
    speculativePages: pages('Pages speculative'),
    wiredPages: pages('Pages wired down'),
    compressorPages: pages('Pages occupied by compressor'),
  });
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Fixed read-only public host probes. No source failure becomes level 1.
 * Cadence is an explicit caller policy, with no implicit retry or TTL. This
 * three-capacity producer is intentionally not the existing two-state port. */
export function createVmMemoryHostPressureProducer(input: {
  command: VmMemoryHostPressureCommandRunner;
  policyRef: string;
  cadence: Readonly<{ intervalMs: number; policyRef: string }>;
}) {
  if (
    typeof input?.command !== 'function' ||
    !nonempty(input.policyRef) ||
    !nonempty(input.cadence?.policyRef) ||
    !Number.isSafeInteger(input.cadence.intervalMs) ||
    input.cadence.intervalMs <= 0 ||
    input.cadence.intervalMs > 2_147_483_647
  )
    throw new VmMemoryError('MEMORY_OBSERVATION_UNAVAILABLE');
  const command = input.command;
  const policyRef = input.policyRef;
  const cadence = Object.freeze({ ...input.cadence });

  async function read(
    bindingInput: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<VmMemoryHostPressureSample> {
    signal.throwIfAborted();
    const binding = Object.freeze({ ...bindingInput });
    const owned = new AbortController();
    const reading = AbortSignal.any([signal, owned.signal]);
    // A failed source cancels siblings, but every returned child promise joins.
    const results = await Promise.allSettled(
      commands.map(async (probe) => {
        try {
          return await command({ ...probe, signal: reading });
        } catch (cause) {
          owned.abort(cause);
          throw cause;
        }
      }),
    );
    signal.throwIfAborted();
    let facts: Pick<
      VmMemoryHostPressureSample,
      'state' | 'capacity' | 'pressureLevel' | 'freePercent' | 'vmStat'
    > = {
      state: 'unavailable',
      capacity: null,
      pressureLevel: null,
      freePercent: null,
      vmStat: null,
    };
    try {
      if (!results.every((result) => result.status === 'fulfilled'))
        throw new Error('source unavailable');
      const outputs = results.map((result) =>
        result.status === 'fulfilled' ? result.value : '',
      );
      const percentage = freePercent(outputs[0]!);
      const memory = vmStat(outputs[1]!);
      const levelText = outputs[2]!.trim();
      if (!/^(1|2|4)$/.test(levelText))
        throw new Error('invalid pressure level');
      const level = Number(levelText) as 1 | 2 | 4;
      facts = {
        state: 'available',
        capacity:
          level === 4 ? 'stop' : percentage >= 40 ? 'parallel' : 'serial',
        pressureLevel: level,
        freePercent: percentage,
        vmStat: memory,
      };
    } catch {
      // Missing, malformed or inconsistent evidence stays unavailable.
    }
    const revision = digest([binding, policyRef, cadence, facts]);
    return Object.freeze({
      binding,
      revision,
      evidenceRef: `host-public-memory-pressure:${revision}`,
      policyRef,
      ...facts,
    });
  }

  async function watch(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<VmMemoryHostPressureSampleWatch> {
    signal.throwIfAborted();
    const bound = Object.freeze({ ...binding });
    const owned = new AbortController();
    const watching = AbortSignal.any([signal, owned.signal]);
    let value: VmMemoryHostPressureSample | null = null;
    let closed = false;
    let closing: Promise<void> | undefined;
    let pending = false;
    let loop = Promise.resolve();
    let setupFinished!: () => void;
    const setup = new Promise<void>((resolve) => {
      setupFinished = resolve;
    });
    const waiters = new Set<() => void>();
    const publish = (next: VmMemoryHostPressureSample | null) => {
      value = next;
      pending = waiters.size === 0;
      for (const resolve of waiters) resolve();
      waiters.clear();
    };
    const close = () => {
      if (closing) return closing;
      let resolve!: () => void, reject!: (cause: unknown) => void;
      closing = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      closed = true;
      publish(null);
      signal.removeEventListener('abort', onAbort);
      owned.abort();
      void (async () => {
        await setup;
        await loop;
      })().then(resolve, reject);
      return closing;
    };
    const onAbort = () => {
      void close().catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    let setupFailed = false;
    let setupError: unknown;
    try {
      const initial = await read(bound, watching);
      watching.throwIfAborted();
      publish(initial);
      loop = (async () => {
        try {
          while (!closed) {
            await delay(cadence.intervalMs, watching);
            if (closed) break;
            publish(null);
            const next = await read(bound, watching);
            if (!closed) publish(next);
          }
        } catch {
          // Do not await close from the work close must join.
          void close().catch(() => {});
        }
      })();
    } catch (cause) {
      setupFailed = true;
      setupError = cause;
    } finally {
      setupFinished();
    }
    if (setupFailed || closed || watching.aborted) {
      await close();
      signal.throwIfAborted();
      if (setupFailed) throw setupError;
      throw new VmMemoryError('MEMORY_OBSERVATION_UNAVAILABLE');
    }
    return {
      read: () => (closed || watching.aborted ? null : value),
      async wait() {
        signal.throwIfAborted();
        if (closed) throw new VmMemoryError('MEMORY_OBSERVATION_UNAVAILABLE');
        if (pending) pending = false;
        else await new Promise<void>((resolve) => waiters.add(resolve));
        signal.throwIfAborted();
        if (closed) throw new VmMemoryError('MEMORY_OBSERVATION_UNAVAILABLE');
      },
      close,
    };
  }
  return { read, watch };
}
