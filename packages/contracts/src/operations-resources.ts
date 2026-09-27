import { z } from 'zod';

const count = z.number().int().nonnegative();
const bytes = z.number().finite().nonnegative();

/** Physical facts from the existing trusted watchdog, not tenant quotas. */
export const SandboxResourcesSchema = z.object({
  backendId: z.string().min(1).max(160),
  cpus: z.number().positive(),
  memoryBytes: bytes,
  availableBytes: bytes,
  reservedBytes: bytes,
  servicesBytes: bytes,
  slots: count.max(32),
  running: count,
});

export const ExecutionPressureSchema = z.object({
  jobs: z.object({ queued: count, active: count, longest_wait_ms: bytes }),
  resources: z.object({ waiting: count, executing: count }),
  blocked: z.array(
    z.object({
      pid: count,
      wait_event_type: z.string().nullable(),
      wait_event: z.string().nullable(),
      blocking_pids: z.array(count),
      wait_ms: bytes.nullable(),
    }),
  ),
});

export const WorkerOperationsSchema = z.object({
  workerId: z.string().uuid(),
  hostname: z.string().min(1).max(253),
  platform: z.string().max(32),
  capacity: z.object({
    mode: z.enum(['auto', 'configured']),
    concurrency: count.min(1).max(32),
    cpus: z.number().positive(),
    memoryBytes: bytes,
  }),
  availableMemoryBytes: bytes,
  rssBytes: bytes,
  sandbox: SandboxResourcesSchema.nullable(),
  sandboxStatus: z.enum(['ready', 'unavailable', 'disabled']),
  pressure: ExecutionPressureSchema.nullable(),
});

export type WorkerOperations = z.infer<typeof WorkerOperationsSchema>;
export type SandboxResources = z.infer<typeof SandboxResourcesSchema>;
export type OperationsInventory = {
  checkedAt: string;
  workers: (WorkerOperations & { observedAt: string; online: boolean })[];
};
