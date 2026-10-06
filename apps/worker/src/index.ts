import { startCloudProjectPreviewTransport } from './cloud-runner/project-preview-transport.js';
import { runtimeFeatureEnabled } from '@allrice/contracts';
import { startExecutionPressureLog } from './execution-pressure.js';
import { detectWorkerCapacity } from './worker-capacity.js';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';

import { UuidSchema, makeHealthResponse } from '@allrice/contracts';
import {
  claimDueAutomations,
  processFolderTriggerEvents,
  claimNextJob,
  closeDatabase,
  maintainQueue,
  pingDatabase,
  queueSummary,
  recoverCodexAuthorizationFlows,
  recordCodexProviderStatus,
  markWorkerDshRuntimesOffline,
  replaceWorkerDshRuntimeInventory,
  syncAutomationRuns,
  recordWorkerCapabilities,
  removeWorkerCapabilities,
  readServiceBuildIdentity,
} from '@allrice/database';

import {
  CodexAuthorizationBroker,
  probeDshCodexProvider,
} from './codex-auth-broker.js';
import { executeClaimedJob } from './runtime.js';
import { closeHarnessAdapters, getHarnessRouter } from './harness/router.js';
import { executeNextPlatformEmployeeTest } from './platform-employee-tests.js';
import { executeNextMcpDiscovery } from './mcp/lifecycle.js';
import { recoverMcpRuntimeOperations } from './mcp/executor.js';
import {
  recoverCloudCommandOperations,
  stopCloudProjectServices,
} from './cloud-runner/executor.js';
import { readWorkerCapabilities } from './harness/runtime-capabilities.js';
import { refreshManagedCloudEnvironments } from './managed-cloud-environments.js';

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
const codexProviderStatusIntervalMs = 30_000;
const dshRuntimeInventoryIntervalMs = 5_000;
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
process.env.ALLRICE_SERVICE_ROLE = 'worker';
const capacity = detectWorkerCapacity();
const concurrency = capacity.concurrency;
const workerId = UuidSchema.parse(
  process.env.ALLRICE_WORKER_ID ?? randomUUID(),
);
const executionRoot = process.env.ALLRICE_EXECUTION_ROOT ?? '.local/executions';
const codexAuthorizationBroker = new CodexAuthorizationBroker(
  workerId,
  executionRoot,
);
const serviceBuildIdentity = await readServiceBuildIdentity('worker');

const stopPressureLog = startExecutionPressureLog(
  executionRoot,
  workerId,
  capacity,
);
let databaseReady = false;
let lastDatabaseError: string | undefined;
let stopping = false;
let tickRunning = false;
let automationTickRunning = false;
let platformEmployeeTestTickRunning = false;
const activeExecutions = new Set<Promise<void>>();
const activeAborters = new Set<() => void>();
let platformEmployeeTestAborter: AbortController | null = null;
const mcpDiscoveryAborter = new AbortController();
let mcpDiscoveryTask: Promise<void> | null = null;
let cloudRecoveryTask: Promise<void> | null = null;
let managedCloudTask: Promise<unknown> | null = null;
function managedCloudTick() {
  if (
    managedCloudTask ||
    stopping ||
    !databaseReady ||
    !runtimeFeatureEnabled('ALLRICE_RUNTIME_POLICY_ENABLED')
  )
    return;
  managedCloudTask = refreshManagedCloudEnvironments(workerId)
    .catch(() => console.error('[MET-159] managed cloud preparation failed'))
    .finally(() => {
      managedCloudTask = null;
    });
}
let mcpRecoveryTask: Promise<void> | null = null;
function mcpRecoveryTick() {
  if (mcpRecoveryTask || stopping || !databaseReady) return;
  mcpRecoveryTask = recoverMcpRuntimeOperations()
    .then(() => undefined)
    .catch(() => {
      console.error('[P16] MCP recovery failed');
    })
    .finally(() => {
      mcpRecoveryTask = null;
    });
}
function cloudRecoveryTick() {
  if (cloudRecoveryTask || stopping || !databaseReady) return;
  cloudRecoveryTask = recoverCloudCommandOperations()
    .then(() => undefined)
    .catch(() => {
      console.error('[P15] cloud recovery failed');
    })
    .finally(() => {
      cloudRecoveryTask = null;
    });
}
function mcpDiscoveryTick() {
  if (
    mcpDiscoveryTask ||
    stopping ||
    !databaseReady ||
    !runtimeFeatureEnabled('ALLRICE_CLOUD_MCP_ENABLED')
  )
    return;
  mcpDiscoveryTask = executeNextMcpDiscovery({
    workerId,
    signal: mcpDiscoveryAborter.signal,
  })
    .then(() => undefined)
    .catch(() => {
      console.error('[P16] MCP discovery failed');
    })
    .finally(() => {
      mcpDiscoveryTask = null;
    });
}

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

let codexProbeRunning = false;
async function refreshCodexProviderStatus() {
  if (codexProbeRunning) return;
  codexProbeRunning = true;
  try {
    await mkdir(executionRoot, { recursive: true, mode: 0o700 });
    for (const slot of [1, 2] as const) {
      const codex = await probeDshCodexProvider(executionRoot, slot);
      await recordCodexProviderStatus(codex, slot);
    }
  } catch (error) {
    console.error('[M5] Codex provider probe failed', {
      message: error instanceof Error ? error.message : 'codex_probe_failed',
    });
  } finally {
    codexProbeRunning = false;
  }
}

let dshInventoryTask: Promise<void> | null = null;
function refreshDshRuntimeInventory() {
  if (stopping || dshInventoryTask) return;
  dshInventoryTask = Promise.allSettled([
    Promise.resolve().then(() =>
      recordWorkerCapabilities(readWorkerCapabilities(workerId)),
    ),
    replaceWorkerDshRuntimeInventory({
      workerId,
      runtimes: getHarnessRouter().runtimeInventory(),
    }),
  ])
    .then((results) => {
      if (results.some((result) => result.status === 'rejected'))
        console.error('[MET-90] DSH runtime inventory sync failed');
    })
    .finally(() => {
      dshInventoryTask = null;
    });
}

const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json; charset=utf-8');
  if (/^[a-f0-9]{40}$/.test(process.env.ALLRICE_RELEASE_SHA ?? ''))
    response.setHeader(
      'x-allrice-release-sha',
      process.env.ALLRICE_RELEASE_SHA!,
    );

  if (request.url === '/health/live') {
    response.statusCode = 200;
    response.end(JSON.stringify(makeHealthResponse('worker', 'live')));
    return;
  }

  if (request.url === '/health/ready') {
    response.statusCode = databaseReady ? 200 : 503;
    response.end(
      JSON.stringify({
        ...makeHealthResponse(
          'worker',
          databaseReady ? 'ready' : 'not_ready',
          lastDatabaseError,
        ),
        ...(serviceBuildIdentity ? { identity: serviceBuildIdentity } : {}),
      }),
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
      if ((process.availableMemory?.() ?? Infinity) < 256 * 1024 ** 2) break;
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

async function automationTick() {
  if (automationTickRunning || stopping || !databaseReady) return;
  automationTickRunning = true;
  try {
    await syncAutomationRuns();
    await processFolderTriggerEvents(Math.max(1, concurrency));
    const claimed = await claimDueAutomations(Math.max(1, concurrency));
    if (claimed > 0) {
      console.info('[M6] queued automation runs', { count: claimed });
    }
  } catch (error) {
    console.error('[M6] automation scheduler failed', {
      message: error instanceof Error ? error.message : 'unknown error',
    });
  } finally {
    automationTickRunning = false;
  }
}

async function platformEmployeeTestTick() {
  if (platformEmployeeTestTickRunning || stopping || !databaseReady) return;
  platformEmployeeTestTickRunning = true;
  platformEmployeeTestAborter = new AbortController();
  try {
    await executeNextPlatformEmployeeTest({
      workerId,
      executionRoot,
      signal: platformEmployeeTestAborter.signal,
    });
  } catch (error) {
    console.error('[MET-93] platform employee test failed', {
      message: error instanceof Error ? error.message : 'unknown error',
    });
  } finally {
    platformEmployeeTestAborter = null;
    platformEmployeeTestTickRunning = false;
  }
}

await refreshReadiness();
await recoverCodexAuthorizationFlows();
await refreshCodexProviderStatus();
const readinessTimer = setInterval(
  () => void refreshReadiness(),
  readinessIntervalMs,
);
const codexProviderStatusTimer = setInterval(
  () => void refreshCodexProviderStatus(),
  codexProviderStatusIntervalMs,
);
const dshRuntimeInventoryTimer = setInterval(
  () => void refreshDshRuntimeInventory(),
  dshRuntimeInventoryIntervalMs,
);
const queueTimer = setInterval(() => void tick(), pollIntervalMs);
const mcpDiscoveryTimer = setInterval(mcpDiscoveryTick, pollIntervalMs);
const cloudRecoveryTimer = setInterval(cloudRecoveryTick, 10_000);
const managedCloudTimer = setInterval(managedCloudTick, 60_000);
const mcpRecoveryTimer = setInterval(mcpRecoveryTick, 10_000);
const automationTimer = setInterval(
  () => void automationTick(),
  pollIntervalMs,
);
const platformEmployeeTestTimer = setInterval(
  () => void platformEmployeeTestTick(),
  pollIntervalMs,
);
const codexAuthorizationTimer = setInterval(
  () => codexAuthorizationBroker.tick(),
  pollIntervalMs,
);
void tick();
void automationTick();
void platformEmployeeTestTick();
codexAuthorizationBroker.tick();
void refreshDshRuntimeInventory();
managedCloudTick();

const cloudPreviewTransport = process.env.ALLRICE_CLOUD_PREVIEW_SOCKET
  ? await startCloudProjectPreviewTransport(
      process.env.ALLRICE_CLOUD_PREVIEW_SOCKET,
    )
  : null;
server.listen(port, '0.0.0.0', () => {
  console.info(`[M5] AllRice worker 0.1.0 listening on ${port}`, {
    workerId,
    concurrency,
    capacity,
    leaseMs,
  });
});

async function shutdown(signal: string) {
  console.info(`[M5] received ${signal}; stopping worker`);
  stopping = true;
  stopPressureLog();
  clearInterval(readinessTimer);
  clearInterval(codexProviderStatusTimer);
  clearInterval(dshRuntimeInventoryTimer);
  clearInterval(queueTimer);
  clearInterval(mcpDiscoveryTimer);
  clearInterval(cloudRecoveryTimer);
  clearInterval(managedCloudTimer);
  clearInterval(mcpRecoveryTimer);
  mcpDiscoveryAborter.abort();
  clearInterval(automationTimer);
  clearInterval(platformEmployeeTestTimer);
  clearInterval(codexAuthorizationTimer);
  for (const abort of activeAborters) abort();
  platformEmployeeTestAborter?.abort();
  server.close();
  await Promise.allSettled(activeExecutions);
  await stopCloudProjectServices();
  await cloudPreviewTransport?.close();
  if (mcpDiscoveryTask) await mcpDiscoveryTask;
  if (cloudRecoveryTask) await cloudRecoveryTask;
  if (managedCloudTask) await managedCloudTask;
  if (mcpRecoveryTask) await mcpRecoveryTask;
  await codexAuthorizationBroker.close();
  await closeHarnessAdapters();
  await dshInventoryTask;
  await markWorkerDshRuntimesOffline(workerId).catch(() => undefined);
  await removeWorkerCapabilities(workerId).catch(() => undefined);
  await closeDatabase();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
