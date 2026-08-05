import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { UuidSchema, makeHealthResponse } from '@allrice/contracts';
import {
  claimNextJob,
  closeDatabase,
  maintainQueue,
  pingDatabase,
  queueSummary,
} from '@allrice/database';

import { executeClaimedJob } from './runtime.js';

const port = Number(process.env.ALLRICE_WORKER_PORT ?? 3101);
function integerSetting(
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

const readinessIntervalMs = 5000;
const pollIntervalMs = integerSetting(
  'ALLRICE_WORKER_POLL_INTERVAL_MS',
  1000,
  100,
  60_000,
);
const leaseMs = integerSetting(
  'ALLRICE_WORKER_LEASE_MS',
  30_000,
  1_000,
  300_000,
);
const heartbeatMs = integerSetting(
  'ALLRICE_WORKER_HEARTBEAT_MS',
  Math.max(500, Math.floor(leaseMs / 3)),
  250,
  Math.max(250, leaseMs - 100),
);
const concurrency = integerSetting('ALLRICE_WORKER_CONCURRENCY', 1, 1, 32);
const workerId = UuidSchema.parse(
  process.env.ALLRICE_WORKER_ID ?? randomUUID(),
);
const executionRoot = process.env.ALLRICE_EXECUTION_ROOT ?? '.local/executions';

let databaseReady = false;
let lastDatabaseError: string | undefined;
let stopping = false;
let tickRunning = false;
const activeExecutions = new Set<Promise<void>>();
const activeAborters = new Set<() => void>();

async function refreshReadiness() {
  try {
    await pingDatabase();
    await queueSummary();
    databaseReady = true;
    lastDatabaseError = undefined;
  } catch (error) {
    databaseReady = false;
    lastDatabaseError =
      error instanceof Error ? error.message : 'Unknown database error';
  }
}

const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json; charset=utf-8');

  if (request.url === '/health/live') {
    response.statusCode = 200;
    response.end(JSON.stringify(makeHealthResponse('worker', 'live')));
    return;
  }

  if (request.url === '/health/ready') {
    response.statusCode = databaseReady ? 200 : 503;
    response.end(
      JSON.stringify(
        makeHealthResponse(
          'worker',
          databaseReady ? 'ready' : 'not_ready',
          lastDatabaseError,
        ),
      ),
    );
    return;
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'not_found' }));
});

async function runClaimed(jobId: string, leaseToken: string) {
  let abort: () => void = () => undefined;
  activeAborters.add(abort);
  try {
    await executeClaimedJob({
      workerId,
      jobId,
      leaseToken,
      leaseMs,
      heartbeatMs,
      executionRoot,
      stopping: () => stopping,
      onAbortReady(nextAbort) {
        activeAborters.delete(abort);
        abort = nextAbort;
        activeAborters.add(abort);
      },
    });
  } finally {
    activeAborters.delete(abort);
  }
}

async function tick() {
  if (tickRunning || stopping || !databaseReady) return;
  tickRunning = true;
  try {
    await maintainQueue();
    while (!stopping && activeExecutions.size < concurrency) {
      const job = await claimNextJob(workerId, leaseMs);
      const leaseToken = job?.lease?.token;
      if (!job || !leaseToken) break;
      const execution = runClaimed(job.id, leaseToken)
        .catch((error: unknown) => {
          console.error('[M5] Worker execution failed', {
            jobId: job.id,
            message: error instanceof Error ? error.message : 'unknown error',
          });
        })
        .finally(() => activeExecutions.delete(execution));
      activeExecutions.add(execution);
    }
  } catch (error) {
    databaseReady = false;
    lastDatabaseError =
      error instanceof Error ? error.message : 'Unknown queue error';
  } finally {
    tickRunning = false;
  }
}

await refreshReadiness();
const readinessTimer = setInterval(
  () => void refreshReadiness(),
  readinessIntervalMs,
);
const queueTimer = setInterval(() => void tick(), pollIntervalMs);
void tick();

server.listen(port, '0.0.0.0', () => {
  console.info(`[M5] AllRice worker 0.1.0 listening on ${port}`, {
    workerId,
    concurrency,
    leaseMs,
  });
});

async function shutdown(signal: string) {
  console.info(`[M5] received ${signal}; stopping worker`);
  stopping = true;
  clearInterval(readinessTimer);
  clearInterval(queueTimer);
  for (const abort of activeAborters) abort();
  server.close();
  await Promise.allSettled(activeExecutions);
  await closeDatabase();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
