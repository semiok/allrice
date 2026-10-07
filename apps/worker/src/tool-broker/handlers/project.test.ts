import { beforeEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import type { RiceToolExecutionInput } from '../types.js';
import { cloudToolchainImageV1 } from '@allrice/contracts';

const ports = vi.hoisted(() => ({
  select: vi.fn(),
  preflight: vi.fn(),
  create: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  selectProjectExecution: ports.select,
  cloudExecutionEnabled: () => true,
  createCloudProjectOperation: ports.create,
  executionResourceObserver: () => ({ observe: vi.fn() }),
}));
vi.mock('../../cloud-runner/backend.js', () => ({
  CloudRunnerBackend: class {
    preflight = ports.preflight;
  },
}));
import { runProjectWorkspace } from './project.js';

beforeEach(() => {
  vi.clearAllMocks();
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
    });
  },
);
