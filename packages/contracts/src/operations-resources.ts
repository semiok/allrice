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

export const QuestionForegroundSnapshotSchema = z.object({
  version: z.literal(1),
  sampledAt: z.string().datetime(),
  rootSessionId: z.string().min(1),
  runId: z.string().min(1).nullable(),
  complete: z.boolean(),
  questions: z.array(
    z.object({
      questionId: z.string().min(1),
      runId: z.string().min(1),
      rootSessionId: z.string().min(1),
      nativeSessionId: z.string().min(1),
    }),
  ),
});
const OnlineQuestionExecutionSchema = z.object({
  runtimeId: z.string().uuid(),
  rootSessionId: z.string().min(1),
  runId: z.string().min(1),
  jobId: z.string().min(1),
  attempt: count,
  generation: count,
  foreground: QuestionForegroundSnapshotSchema.nullable(),
});
export type OnlineQuestionExecution = z.infer<
  typeof OnlineQuestionExecutionSchema
>;

export const WorkerOperationsSchema = z.object({
  onlineQuestions: z
    .object({
      version: z.literal(1),
      workerBootId: z.string().uuid(),
      scope: z.literal('default_harness_router'),
      executions: z.array(OnlineQuestionExecutionSchema),
    })
    .optional(),
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
