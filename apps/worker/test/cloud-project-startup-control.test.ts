import { cloudPlatform } from '@allrice/contracts';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { cloudProjectFixture } from './project-runtime.fixture.js';
import { CloudRunnerBackend } from '../src/cloud-runner/backend.js';
import * as project from '../src/cloud-runner/project.js';

vi.mock('../src/cloud-runner/project.js', async (original) => ({
  ...(await original<typeof project>()),
  prepareCloudProject: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

it('settles explicit project staging revocation before the asynchronous abort heartbeat', async () => {
  const f = cloudProjectFixture();
  const spec = f.command.arguments.projectPreparation;
  const proof = {
    version: 1,
    projectId: spec.projectId,
    sourceDigest: spec.sourceDigest,
    lockChecksum: spec.lockChecksum,
    cacheKey: f.command.arguments.projectSource.cacheKey,
    manager: spec.manager,
    managerVersion: spec.managerVersion,
    platform: cloudPlatform.linuxPlatform,
    runtimeImage: f.command.imageDigest,
    packageCount: spec.packages.length,
    archiveHits: 0,
    downloadedArchives: 0,
    downloadedBytes: 0,
    cacheVolume:
      'allrice-project-cache-' +
      f.command.arguments.projectSource.cacheKey.slice(7),
    sourceDirectoryModified: false,
    hostEnvironmentModified: false,
  };
  let created = false,
    running = false,
    valid = true;
  const container = () => ({
    Id: 'a'.repeat(64),
    Config: {
      Labels: { 'xyz.bplabs.allrice.project.evidence': JSON.stringify(proof) },
    },
    State: {
      Running: running,
      Status: running ? 'running' : 'exited',
      ExitCode: 137,
      OOMKilled: false,
    },
    HostConfig: { Runtime: 'runsc' },
  });
  const stops = vi.fn(async () => {
    running = false;
    return true;
  });
  class Daemon extends CloudRunnerBackend {
    override async preflight() {
      return {
        backend: 'cloud-gvisor-v1',
        runtime: 'runsc',
        architecture: cloudPlatform.architecture,
        imageDigest: f.command.imageDigest,
      } as const;
    }
    override async json<T>() {
      created = true;
      return { Id: 'a'.repeat(64) } as T;
    }
    override async call() {
      running = true;
      return Buffer.alloc(0);
    }
    override async inspect() {
      return created ? container() : null;
    }
    override stop = stops;
    override async collect(
      _attempt: string,
      command: Parameters<typeof project.collectCloudProject>[1],
      startedAt: number,
      reason: Parameters<typeof project.collectCloudProject>[4] = 'completed',
    ) {
      return project.collectCloudProject(
        container(),
        command,
        Buffer.alloc(0),
        startedAt,
        reason,
      );
    }
  }
  const backend = new Daemon();
  const staging = vi
    .spyOn(backend, 'putArchive')
    .mockImplementation(async () => {
      valid = false;
    });
  const release = vi.fn(async () => {});
  let revokedBeforeAbort = false;
  vi.mocked(project.prepareCloudProject).mockImplementation(
    async (_api, _preparation, input) => {
      return {
        command: input.command,
        // This fixture substitutes the Docker/preparation boundaries; the real
        // afterStart, revocation and project receipt paths remain under test.
        config: {} as Awaited<
          ReturnType<typeof project.prepareCloudProject>
        >['config'],
        archives: [Buffer.from('isolated fixture archive')],
        signal: input.signal,
        maintainLease: async () => {
          if (!valid) revokedBeforeAbort = !input.signal.aborted;
          return valid;
        },
        handoffHeartbeat() {},
        releaseServiceCacheFence: async () => {},
        release,
      };
    },
  );
  const result = await Reflect.get(backend, 'executeAdmittedProject').call(
    backend,
    f.command,
    {
      attemptId: randomUUID(),
      projectScope: f.scope,
      deadlineAt: new Date(Date.now() + 60000).toISOString(),
      maintainLease: async () => true,
    },
  );
  expect(result).toMatchObject({
    reason: 'canceled',
    stopped: true,
    errorCode: 'CLOUD_EXECUTION_REVOKED',
    projectPreparation: { installation: 'interrupted' },
  });
  expect(staging).toHaveBeenCalledTimes(1); // Never releases the tenant start marker.
  expect(stops).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
  // This test does not simulate an abort; it exercises the real afterStart
  // maintainLease=false branch before the heartbeat would have changed signal.
  expect(revokedBeforeAbort).toBe(true);
});

it.each(['unknown', 'deadline', 'canceled'] as const)(
  'does not promote an interrupted project %s result to success',
  (reason) => {
    const f = cloudProjectFixture();
    const spec = f.command.arguments.projectPreparation;
    const proof = {
      version: 1,
      projectId: spec.projectId,
      sourceDigest: spec.sourceDigest,
      lockChecksum: spec.lockChecksum,
      cacheKey: f.command.arguments.projectSource.cacheKey,
      manager: spec.manager,
      managerVersion: spec.managerVersion,
      platform: cloudPlatform.linuxPlatform,
      runtimeImage: f.command.imageDigest,
      packageCount: spec.packages.length,
      archiveHits: 0,
      downloadedArchives: 0,
      downloadedBytes: 0,
      cacheVolume:
        'allrice-project-cache-' +
        f.command.arguments.projectSource.cacheKey.slice(7),
      sourceDirectoryModified: false,
      hostEnvironmentModified: false,
    };
    const result = project.collectCloudProject(
      {
        Id: 'a'.repeat(64),
        Config: {
          Labels: {
            'xyz.bplabs.allrice.project.evidence': JSON.stringify(proof),
          },
        },
        State: {
          Running: false,
          Status: 'exited',
          ExitCode: 137,
          OOMKilled: false,
        },
      },
      f.command,
      Buffer.alloc(0),
      Date.now(),
      reason,
    );
    expect(result).toMatchObject({
      reason,
      artifacts: [],
      projectPreparation: { installation: 'interrupted' },
    });
  },
);
