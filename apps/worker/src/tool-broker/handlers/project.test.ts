import { beforeEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import type * as Executor from '../../cloud-runner/executor.js';
import type { RiceToolExecutionInput } from '../types.js';
import { cloudToolchainImageV1 } from '@allrice/contracts';

const ports = vi.hoisted(() => ({
  select: vi.fn(),
  preflight: vi.fn(),
  create: vi.fn(),
  budget: vi.fn(),
  start: vi.fn(),
}));
vi.mock('../../cloud-runner/executor.js', async (original) => ({
  ...(await original<typeof Executor>()),
  startCloudProjectService: ports.start,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  selectProjectExecution: ports.select,
  cloudExecutionEnabled: () => true,
  createCloudProjectOperation: ports.create,
  readProjectWorkflowBudget: ports.budget,
  executionResourceObserver: () => ({ observe: vi.fn() }),
}));
vi.mock('../../cloud-runner/backend.js', () => ({
  CloudRunnerBackend: class {
    preflight = ports.preflight;
  },
}));
import { runProjectWorkspace } from './project.js';
import { CloudProjectServiceStartError } from '../../cloud-runner/executor.js';
import { isConfirmedToolFailure } from '../../errors.js';

beforeEach(() => {
  vi.clearAllMocks();
  ports.budget.mockResolvedValue({
    executions: 8,
    edits: 3,
    used: { executions: 1, edits: 0 },
    remaining: { executions: 7, edits: 3 },
  });
  ports.select.mockResolvedValue({
    choice: {
      location: 'none',
      status: 'unavailable',
      reason: 'cloud_unavailable',
    },
  });
  ports.preflight.mockRejectedValue(new Error('LIVE_GUARD_NOT_READY'));
});

it.each([
  ['standard', 'execute', false, false],
  ['web-development', 'execute', false, true],
  ['web-development', 'service_start', true, true],
] as const)(
  'checks the live guard before admitting %s %s and preserves an unavailable choice',
  async (resourceProfile, action, service, web) => {
    const a = {
      executable: '/usr/local/bin/node',
      args: ['main.cjs'],
      imageDigest: cloudToolchainImageV1,
      limits: {
        timeoutMs: 60000,
        outputBytes: 16384,
        memoryMiB: 512,
        cpuMillis: 1000,
        pids: 64,
      },
      projectPreparation: {
        version: 1,
        projectId: '713d721f-f0bf-40dd-aa0b-65f6aa79e49a',
        sourceDigest: `sha256:${'a'.repeat(64)}`,
        lockChecksum: `sha256:${'a'.repeat(64)}`,
        offline: true,
        manager: 'pnpm',
        managerVersion: '10.33.3',
        lockPath: 'pnpm-lock.yaml',
        scripts: 'disabled',
        packages: [],
      },
    };
    const input = {
      sessionId: '713d721f-f0bf-40dd-aa0b-65f6aa79e49b',
      managedBrowserJobAttempt: 1,
      managedBrowserJobLeaseToken: 'owned-test-lease',
      context: {},
      call: { id: 'synthetic', name: 'workspace.project', arguments: {} },
      storageRoot: '/tmp/unused-project-guard-test',
    } as RiceToolExecutionInput;
    const result = await runProjectWorkspace({
      input,
      arguments: {
        action,
        project: {
          projectId: a.projectPreparation!.projectId,
          snapshot: {
            kind: 'artifact',
            id: '713d721f-f0bf-40dd-aa0b-65f6aa79e49c',
            checksum: `sha256:${'a'.repeat(64)}`,
          },
        },
        executable: a.executable,
        args: a.args,
        path: '.',
        limits: a.limits,
        projectPreparation: { ...a.projectPreparation, resourceProfile },
        ...(service ? { service: { port: 4173 } } : {}),
      },
    });
    expect(ports.preflight).toHaveBeenCalledExactlyOnceWith(
      a.imageDigest,
      service,
      web,
    );
    expect(ports.select).toHaveBeenCalledTimes(1);
    expect(ports.create).not.toHaveBeenCalled();
    expect(JSON.parse(result.modelContent)).toMatchObject({
      executed: false,
      status: 'environment_unavailable',
      workflowBudget: { used: { executions: 1 }, remaining: { executions: 7 } },
    });
  },
);

const startFixture = () => {
  const operationId = '713d721f-f0bf-40dd-aa0b-65f6aa79e49c',
    runId = '713d721f-f0bf-40dd-aa0b-65f6aa79e49b',
    created = {
      context: { runId },
      callId: 'owned-start',
      snapshot: { binding: { attempt: { operationId } } },
    },
    input = {
      sessionId: runId,
      managedBrowserJobAttempt: 1,
      managedBrowserJobLeaseToken: 'owned-test-lease',
      context: { runId },
      call: { id: created.callId, name: 'workspace.project', arguments: {} },
      storageRoot: '/tmp/unused-project-service-receipt-test',
    } as RiceToolExecutionInput,
    command = {
      action: 'service_start',
      project: {
        projectId: operationId,
        snapshot: {
          kind: 'artifact',
          id: operationId,
          checksum: `sha256:${'a'.repeat(64)}`,
        },
      },
      service: { port: 3000 },
      executable: '/usr/local/bin/node',
      args: ['server.cjs'],
      path: '.',
      limits: {
        timeoutMs: 60000,
        outputBytes: 8000,
        memoryMiB: 512,
        cpuMillis: 1000,
        pids: 64,
      },
      projectPreparation: {
        version: 1,
        projectId: operationId,
        sourceDigest: `sha256:${'b'.repeat(64)}`,
        lockChecksum: `sha256:${'c'.repeat(64)}`,
        offline: true,
        manager: 'pnpm',
        managerVersion: '10.33.3',
        lockPath: 'pnpm-lock.yaml',
        scripts: 'disabled',
        packages: [],
      },
    },
    result = {
      operationId,
      status: 'failed',
      reason: 'failed',
      stopped: true,
      cleanupConfirmed: true,
      exitCode: 137,
      output: '',
      artifacts: [],
    };
  ports.select.mockResolvedValue({
    choice: { location: 'cloud', status: 'execute', reason: 'cloud_ready' },
  });
  ports.create.mockResolvedValue(created);
  return { input, command, created, result };
};

it('settles the exact failed startup after the executor confirms physical stop and cleanup', async () => {
  const f = startFixture();
  ports.start.mockRejectedValue(
    new CloudProjectServiceStartError(f.created as never, f.result as never),
  );
  const error = await runProjectWorkspace({
    input: f.input,
    arguments: f.command,
  }).catch((e) => e);
  expect(error.code).toBe('CLOUD_EXECUTION_FAILED');
  expect(error.message).toContain('137');
  expect(
    isConfirmedToolFailure(error, {
      runId: f.input.context.runId,
      callId: f.input.call.id,
      toolName: 'workspace.project',
    }),
  ).toBe(true);
  expect(
    isConfirmedToolFailure(error, {
      runId: f.input.context.runId,
      callId: 'another-call',
      toolName: 'workspace.project',
    }),
  ).toBe(false);
});

it.each([
  'running',
  'unknown',
  'missing-stop',
  'missing-cleanup',
  'wrong-operation',
  'wrong-call',
  'wrong-run',
  'external-outcome-unknown',
  'ordinary-error',
])(
  'keeps %s startup unconfirmed without manufacturing a failure receipt',
  async (kind) => {
    const f = startFixture();
    if (kind === 'running' || kind === 'unknown') f.result.status = kind;
    if (kind === 'missing-stop') f.result.stopped = false;
    if (kind === 'missing-cleanup') f.result.cleanupConfirmed = false;
    if (kind === 'wrong-operation') f.result.operationId = 'another-operation';
    if (kind === 'external-outcome-unknown')
      Object.assign(f.result, { externalOutcomeUnknown: true });
    const created = {
      ...f.created,
      ...(kind === 'wrong-call' ? { callId: 'another-call' } : {}),
      ...(kind === 'wrong-run' ? { context: { runId: 'another-run' } } : {}),
    };
    ports.start.mockRejectedValue(
      kind === 'ordinary-error'
        ? Error('CLOUD_SERVICE_NOT_READY')
        : new CloudProjectServiceStartError(
            created as never,
            f.result as never,
          ),
    );
    const error = await runProjectWorkspace({
      input: f.input,
      arguments: f.command,
    }).catch((e) => e);
    expect(
      isConfirmedToolFailure(error, {
        runId: f.input.context.runId,
        callId: f.input.call.id,
        toolName: 'workspace.project',
      }),
    ).toBe(false);
  },
);
