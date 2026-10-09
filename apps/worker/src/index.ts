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
  readDevMaintenance,
  installDevProducerLifecycle,
  readDevProducerLifecycle,
  type DevProducerContext,
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
import { workerProducerRunner } from './dev-producer.js';
import { runMaintenanceReportingProducer } from './maintenance-reporting.js';
import {
  captureMaintenanceDiagnosticRuntime,
  runMaintenanceDiagnosisTick,
} from './maintenance-diagnosis.js';

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
const producerLifecycle = await installDevProducerLifecycle('worker');
const maintenanceDiagnosticRuntime =
  process.env.ALLRICE_MAINTENANCE_CENTRAL_ENABLED === '1'
    ? await captureMaintenanceDiagnosticRuntime(serviceBuildIdentity)
    : null;

const stopPressureLog = startExecutionPressureLog(
  executionRoot,
  workerId,
  capacity,
);
let databaseReady = false;
let lastDatabaseError: string | undefined;
let stopping = false;
const runProducer = workerProducerRunner(producerLifecycle, () => stopping);
const maintenanceReportingAborter = new AbortController();
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
  managedCloudTask = runProducer('managed_cloud', () =>
    refreshManagedCloudEnvironments(workerId),
  )
    .catch(() => console.error('[MET-159] managed cloud preparation failed'))
    .finally(() => {
      managedCloudTask = null;
    });
}
let mcpRecoveryTask: Promise<void> | null = null;
function mcpRecoveryTick() {
  if (mcpRecoveryTask || stopping || !databaseReady) return;
  mcpRecoveryTask = runProducer('mcp_recovery', () =>
    recoverMcpRuntimeOperations(),
  )
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
  cloudRecoveryTask = runProducer('cloud_recovery', () =>
    recoverCloudCommandOperations(),
  )
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
  mcpDiscoveryTask = runProducer('mcp_discovery', () =>
    executeNextMcpDiscovery({
      workerId,
      signal: mcpDiscoveryAborter.signal,
    }),
  )
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

let codexProbeTask: Promise<void> | null = null;
function refreshCodexProviderStatus() {
  if (codexProbeTask || stopping) return codexProbeTask;
  codexProbeTask = runProducer('provider_probe', async () => {
    await mkdir(executionRoot, { recursive: true, mode: 0o700 });
    for (const slot of [1, 2] as const) {
      const codex = await probeDshCodexProvider(executionRoot, slot);
      await recordCodexProviderStatus(codex, slot);
    }
  })
    .catch((error) => {
      console.error('[M5] Codex provider probe failed', {
        message: error instanceof Error ? error.message : 'codex_probe_failed',
      });
    })
    .finally(() => {
      codexProbeTask = null;
    });
  return codexProbeTask;
}

let codexAuthorizationTask: Promise<void> | null = null;
function codexAuthorizationTick() {
  if (codexAuthorizationTask || stopping || !databaseReady) return;
  codexAuthorizationTask = runProducer('provider_authorization', async () => {
    await codexAuthorizationBroker.tick();
  })
    .catch(() => console.error('[MET-167] authorization lifecycle failed'))
    .finally(() => {
      codexAuthorizationTask = null;
    });
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

const server = createServer(async (request, response) => {
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
    let maintenance;
    try {
      maintenance = await readDevMaintenance();
    } catch {
      response.writeHead(503);
      response.end(
        JSON.stringify(
          makeHealthResponse(
            'worker',
            'not_ready',
            'dev_maintenance_unavailable',
          ),
        ),
      );
      return;
    }
    response.statusCode = databaseReady ? 200 : 503;
    response.end(
      JSON.stringify({
        ...makeHealthResponse(
          'worker',
          databaseReady ? 'ready' : 'not_ready',
          lastDatabaseError,
        ),
        ...(serviceBuildIdentity ? { identity: serviceBuildIdentity } : {}),
        ...(maintenance ? { maintenance } : {}),
        ...(maintenance
          ? { producerLifecycle: readDevProducerLifecycle('worker') }
          : {}),
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
    await runProducer(
      'ordinary_consumer',
      async (scope: DevProducerContext) => {
        await maintainQueue();
        while (!stopping && activeExecutions.size < concurrency) {
          if ((process.availableMemory?.() ?? Infinity) < 256 * 1024 ** 2)
            break;
          const job = await claimNextJob(workerId, leaseMs);
          const leaseToken = job?.lease?.token;
          if (!job || !leaseToken) break;
          const execution = scope
            .child(async () => runClaimed(job.id, leaseToken))
            .catch((error: unknown) => {
              console.error('[M5] Worker execution failed', {
                jobId: job.id,
                message:
                  error instanceof Error ? error.message : 'unknown error',
              });
            })
            .finally(() => activeExecutions.delete(execution));
          activeExecutions.add(execution);
        }
      },
    );
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
    await runProducer('automation', async () => {
      await syncAutomationRuns();
      await processFolderTriggerEvents(Math.max(1, concurrency));
      const claimed = await claimDueAutomations(Math.max(1, concurrency));
      if (claimed > 0) {
        console.info('[M6] queued automation runs', { count: claimed });
      }
    });
  } catch (error) {
    console.error('[M6] automation scheduler failed', {
      message: error instanceof Error ? error.message : 'unknown error',
    });
  } finally {
    automationTickRunning = false;
  }
}

let maintenanceReportingTask: Promise<void> | null = null;
let maintenanceDiagnosisNextAt = 0;
function maintenanceReportingTick() {
  if (
    maintenanceReportingTask ||
    stopping ||
    !databaseReady ||
    (!process.env.ALLRICE_MAINTENANCE_CONNECTION_FILE &&
      !maintenanceDiagnosticRuntime)
  )
    return;
  maintenanceReportingTask = runProducer('automation', async () => {
    await runMaintenanceReportingProducer({
      signal: maintenanceReportingAborter.signal,
    });
    if (Date.now() >= maintenanceDiagnosisNextAt) {
      maintenanceDiagnosisNextAt = Date.now() + 60000;
      await runMaintenanceDiagnosisTick(
        maintenanceDiagnosticRuntime,
        maintenanceReportingAborter.signal,
      );
    }
  })
    .catch(() =>
      console.error('[MET-167] maintenance report database outcome unknown'),
    )
    .finally(() => {
      maintenanceReportingTask = null;
    });
}

async function platformEmployeeTestTick() {
  if (platformEmployeeTestTickRunning || stopping || !databaseReady) return;
  platformEmployeeTestTickRunning = true;
  const aborter = new AbortController();
  platformEmployeeTestAborter = aborter;
  try {
    await runProducer('employee_test', () =>
      executeNextPlatformEmployeeTest({
        workerId,
        executionRoot,
        signal: aborter.signal,
      }),
    );
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
await runProducer('provider_authorization', () =>
  recoverCodexAuthorizationFlows(),
);
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
const automationTimer = setInterval(() => {
  void automationTick();
  maintenanceReportingTick();
}, pollIntervalMs);
const platformEmployeeTestTimer = setInterval(
  () => void platformEmployeeTestTick(),
  pollIntervalMs,
);
const codexAuthorizationTimer = setInterval(
  codexAuthorizationTick,
  pollIntervalMs,
);
void tick();
void automationTick();
maintenanceReportingTick();
void platformEmployeeTestTick();
codexAuthorizationTick();
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

let shutdownTask: Promise<void> | undefined;
function shutdown(signal: string) {
  if (shutdownTask) return shutdownTask;
  stopping = true;
  // Fence preview admission before waiting for commands or service shutdown.
  const previewClosing = cloudPreviewTransport?.close();
  void previewClosing?.catch(() => undefined);
  shutdownTask = (async () => {
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
    maintenanceReportingAborter.abort();
    clearInterval(automationTimer);
    clearInterval(platformEmployeeTestTimer);
    clearInterval(codexAuthorizationTimer);
    for (const abort of activeAborters) abort();
    platformEmployeeTestAborter?.abort();
    server.close();
    await Promise.allSettled(activeExecutions);
    await stopCloudProjectServices();
    await previewClosing;
    if (mcpDiscoveryTask) await mcpDiscoveryTask;
    if (cloudRecoveryTask) await cloudRecoveryTask;
    if (managedCloudTask) await managedCloudTask;
    if (mcpRecoveryTask) await mcpRecoveryTask;
    await codexAuthorizationBroker.close();
    await codexAuthorizationTask;
    await codexProbeTask;
    await maintenanceReportingTask;
    await producerLifecycle.waitForCurrentRoots();
    await closeHarnessAdapters();
    await dshInventoryTask;
    await markWorkerDshRuntimesOffline(workerId).catch(() => undefined);
    await removeWorkerCapabilities(workerId).catch(() => undefined);
    await closeDatabase();
    process.exit(0);
  })();
  return shutdownTask;
}

const stopWorker = (signal: string) => {
  void shutdown(signal).catch(() => {
    console.error('[M5] shutdown incomplete; resource closure unconfirmed');
    process.exitCode = 1;
  });
};
process.on('SIGINT', () => stopWorker('SIGINT'));
process.on('SIGTERM', () => stopWorker('SIGTERM'));
