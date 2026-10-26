import { availableParallelism, totalmem } from 'node:os';
import { readHostMemorySync, type HostMemory } from './host-memory.js';

/** Main jobs mostly wait on model/network I/O. This is independent of the
 * much smaller pool of CPU-bound Office containers. Explicit limits remain
 * supported for small deployments and deterministic fixtures. */
export function workerCapacity(input: {
  cpus: number;
  memoryBytes: number;
  availableBytes: number;
  configured?: string;
}) {
  const configured = input.configured?.trim();
  if (configured && configured !== 'auto') {
    const value = Number(configured);
    if (!Number.isInteger(value) || value < 1 || value > 32)
      throw Error('ALLRICE_WORKER_CONCURRENCY must be auto or 1..32');
    return { mode: 'configured', concurrency: value } as const;
  }
  const reserve = Math.max(512 * 1024 ** 2, input.memoryBytes * 0.2);
  const budget = Math.max(
    0,
    Math.min(input.availableBytes, input.memoryBytes - reserve),
  );
  return {
    mode: 'auto',
    concurrency: Math.max(
      1,
      Math.min(32, input.cpus * 4, Math.floor(budget / (256 * 1024 ** 2))),
    ),
  } as const;
}

/** Same memory estimate as the claim gate (MET-219): on macOS free pages
 * alone made auto concurrency swing with whatever was cached at startup. */
export function detectWorkerCapacity(
  memory: HostMemory = readHostMemorySync(),
) {
  const constrained = process.constrainedMemory?.() ?? 0;
  const memoryBytes = Math.min(totalmem(), constrained || Infinity);
  const availableBytes = Math.min(memory.availableBytes, memoryBytes);
  return {
    ...workerCapacity({
      cpus: availableParallelism(),
      memoryBytes,
      availableBytes,
      configured: process.env.ALLRICE_WORKER_CONCURRENCY,
    }),
    cpus: availableParallelism(),
    memoryBytes,
    availableBytes,
    memorySource: memory.source,
  };
}
