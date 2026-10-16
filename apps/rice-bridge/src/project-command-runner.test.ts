import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  managedPythonPayloadForPlatform,
  localCommandToolchainImageV1,
  resolveSandboxExecutionPolicy,
  sandboxExecutionBudgetSpec,
  startSandboxExecutionBudget,
  renewSandboxExecutionBudget,
} from '@allrice/contracts';
import { SandboxExecutionBudgetController } from '@allrice/project-runtime';
import { ProjectCommandRunner } from './project-command-runner.js';
import { LocalDockerApi } from './local-docker-api.js';
import { ProjectPreparation } from './project-preparation.js';
import { projectFixture } from '../test/project-fixture.js';
import { LocalCommandNotStartedError } from './local-command-inputs.js';

const roots: string[] = [];
type TestContainer = {
  Id: string;
  Config: { Image: string; Labels: Record<string, string> };
  Mounts: { Type: string; Name: string; Destination: string }[];
  State: {
    Running: boolean;
    Status: string;
    ExitCode: number;
    OOMKilled: boolean;
  };
};
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'allrice-project-runner-test-'));
  roots.push(root);
  const source = projectFixture('pnpm');
  for (const [name, bytes] of Object.entries(source.files))
    await writeFile(join(root, name), bytes);
  const api = new LocalDockerApi('/synthetic/docker.sock');
  const preparation = new ProjectPreparation(join(root, 'cache'));
  const runner = new ProjectCommandRunner({
    api,
    preparation,
    architecture: 'amd64',
    nodeImage: localCommandToolchainImageV1,
    pythonImage: managedPythonPayloadForPlatform('macos-x64')!.imageId,
  });
  const tool = vi.spyOn(preparation, 'tool').mockResolvedValue({
    path: '.allrice/manager.tar.gz',
    bytes: Buffer.alloc(1),
    asset: {
      fileName: 'manager',
      url: 'https://example.test/manager',
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
    },
  });
  const archives = vi.spyOn(preparation, 'archives').mockResolvedValue({
    files: [],
    archiveHits: 0,
    downloadedArchives: 0,
    downloadedBytes: 0,
  });
  const attemptId = randomUUID(),
    id = 'a'.repeat(64);
  const volumes = new Map<string, Record<string, unknown>>();
  let container: TestContainer | undefined;
  let hold = false,
    finish: (() => void) | undefined;
  const json = vi
    .spyOn(api, 'json')
    .mockImplementation(async (method, path, body) => {
      if (method === 'GET' && path === '/system/df')
        return {
          Volumes: [...volumes.values()].map((v) => ({
            ...v,
            UsageData: { Size: 0, RefCount: 0 },
          })),
        };
      if (method === 'POST' && path === '/volumes/create') {
        const b = body as Record<string, unknown>,
          volume = { ...b, Options: b.DriverOpts ?? null };
        volumes.set(b.Name as string, volume);
        return volume;
      }
      if (method === 'GET' && path.startsWith('/volumes/'))
        return volumes.get(path.slice('/volumes/'.length));
      if (method === 'POST' && path.startsWith('/containers/create')) {
        const b = body as {
          Image: string;
          Labels: Record<string, string>;
          HostConfig: {
            Mounts: { Type: string; Source: string; Target: string }[];
          };
        };
        container = {
          Id: id,
          Config: { Image: b.Image, Labels: b.Labels },
          Mounts: b.HostConfig.Mounts.map((m) => ({
            Type: m.Type,
            Name: m.Source,
            Destination: m.Target,
          })),
          State: {
            Running: false,
            Status: 'created',
            ExitCode: 0,
            OOMKilled: false,
          },
        };
        return { Id: id };
      }
      if (method === 'GET' && path.startsWith('/containers/')) return container;
      if (method === 'POST' && path.endsWith('/start')) {
        container!.State.Running = hold;
        container!.State.Status = hold ? 'running' : 'exited';
        return undefined;
      }
      if (method === 'POST' && path.includes('/kill')) {
        container!.State = {
          ...container!.State,
          Running: false,
          Status: 'exited',
          ExitCode: 137,
        };
        finish?.();
        return undefined;
      }
      if (method === 'DELETE') {
        if (path.startsWith('/volumes/'))
          volumes.delete(path.slice('/volumes/'.length));
        return undefined;
      }
      throw Error(`unexpected fake endpoint ${method} ${path}`);
    });
  const staged: Buffer[] = [];
  vi.spyOn(api, 'putArchive').mockImplementation(async (_id, _path, bytes) => {
    staged.push(Buffer.from(bytes));
  });
  vi.spyOn(api, 'logs').mockImplementation(async (_id, output) => {
    if (hold)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    else
      output(
        Buffer.from(
          JSON.stringify({
            type: 'exit',
            reason: 'exited',
            code: 0,
            installation: 'succeeded',
          }) + '\n',
        ),
      );
  });
  const options = {
    attemptId,
    scope: {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      ownerId: randomUUID(),
    },
    maintainLease: async () => true,
  };
  return {
    root,
    source,
    runner,
    api,
    tool,
    archives,
    json,
    options,
    staged,
    volumes,
    container: () => container!,
    hold: () => {
      hold = true;
    },
  };
}

it('stages the original absolute operation and lease deadline without adding preparation time', async () => {
  const f = await fixture();
  const deadline = Date.now() + 5000,
    lease = Date.now() + 3000;
  const result = await f.runner.execute(f.root, f.source.command, {
    ...f.options,
    deadlineUnixMs: deadline,
    leaseExpiresAt: new Date(lease).toISOString(),
  });
  const tar = f.staged[0]!,
    size = parseInt(tar.subarray(124, 136).toString().replace(/\0/g, ''), 8);
  const config = JSON.parse(tar.subarray(512, 512 + size).toString());
  expect(config.deadlineUnixMs).toBe(lease - 250);
  expect(config.deadlineReason).toBe('lease_lost');
  expect(result.reason).toBe('exited');
});

it.each(['tool', 'archives'] as const)(
  'renews slow %s preparation from measured bytes without restarting the execution clock',
  async (phase) => {
    const f = await fixture();
    vi.useFakeTimers();
    const startedAt = Date.now();
    const spec = sandboxExecutionBudgetSpec(
      { version: 1, kind: 'install' },
      resolveSandboxExecutionPolicy([]),
    );
    let authority = startSandboxExecutionBudget(
      spec,
      startedAt,
      startedAt + 600000,
    );
    const exchange = vi.fn(
      async (request) =>
        (authority = renewSandboxExecutionBudget(
          authority,
          request,
          Date.now(),
          startedAt + 600000,
        )),
    );
    const budget = new SandboxExecutionBudgetController(
      authority,
      spec,
      exchange,
    );
    f.source.command.executionBudget = spec;
    f.source.command.arguments.execution = { version: 1, kind: 'install' };
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (phase === 'tool') {
      f.tool.mockImplementation(
        async (_manager, _arch, signal, _offline, onBytes) => {
          onBytes?.(4096);
          enter();
          await pending;
          signal.throwIfAborted();
          return {
            path: '.allrice/manager.tar.gz',
            bytes: Buffer.alloc(1),
            asset: {
              fileName: 'manager',
              url: 'https://example.test/manager',
              sizeBytes: 1,
              sha256: 'a'.repeat(64),
            },
          };
        },
      );
    } else {
      f.archives.mockImplementation(async (input) => {
        input.onBytes?.(4096);
        enter();
        await pending;
        input.signal.throwIfAborted();
        return {
          files: [],
          archiveHits: 0,
          downloadedArchives: 1,
          downloadedBytes: 4096,
        };
      });
    }
    const operation = f.runner.execute(f.root, f.source.command, {
      ...f.options,
      executionBudget: budget,
    });
    void operation.catch(() => undefined);
    try {
      await entered;
      vi.setSystemTime(startedAt + 105000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(exchange).toHaveBeenCalledTimes(1);
      expect(exchange.mock.calls[0]![0].progress.readBytes).toBe(4096);
      expect(budget.state.startedAt).toBe(startedAt);
      expect(budget.state.hardDeadlineAt).toBe(startedAt + 600000);
      expect(budget.state.deadlineAt).toBe(startedAt + 180000);
      release();
      const result = await operation;
      expect(result.reason).toBe('exited');
      expect(result.execution?.renewalCount).toBe(1);
    } finally {
      release();
      await operation.catch(() => undefined);
    }
  },
);

it.each(['timeout', 'lease_lost'] as const)(
  'retains %s as the actual reason and confirms the physical container stopped',
  async (reason) => {
    const f = await fixture();
    f.hold();
    const result = await f.runner.execute(f.root, f.source.command, {
      ...f.options,
      ...(reason === 'timeout'
        ? { deadlineUnixMs: Date.now() + 80 }
        : { leaseExpiresAt: new Date(Date.now() + 330).toISOString() }),
    });
    expect(result.reason).toBe(reason);
    expect(result.stopped).toBe(true);
    expect(f.container().State.Running).toBe(false);
    expect(result.projectPreparation!.installation).toBe('interrupted');
  },
);

it.each(['no_progress', 'revoked', 'authority_timeout'] as const)(
  'stops preparation on %s and preserves the cause without creating a container',
  async (failure) => {
    const f = await fixture();
    vi.useFakeTimers();
    const startedAt = Date.now();
    const spec = sandboxExecutionBudgetSpec(
      { version: 1, kind: 'install' },
      resolveSandboxExecutionPolicy([]),
    );
    let authority = startSandboxExecutionBudget(
      spec,
      startedAt,
      startedAt + 600000,
    );
    const exchange = vi.fn(
      async (request) =>
        (authority = renewSandboxExecutionBudget(
          authority,
          request,
          Date.now(),
          startedAt + 600000,
        )),
    );
    const budget = new SandboxExecutionBudgetController(
      authority,
      spec,
      exchange,
    );
    f.source.command.executionBudget = spec;
    f.source.command.arguments.execution = { version: 1, kind: 'install' };
    const maintainLease = vi.fn(async () => true);
    const abort = new AbortController();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    f.archives.mockImplementation(async ({ signal }) => {
      enter();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(Error('EXECUTION_REVOKED')),
          { once: true },
        );
      });
      throw Error('unexpected preparation completion');
    });
    const operation = f.runner
      .execute(f.root, f.source.command, {
        ...f.options,
        maintainLease,
        signal: abort.signal,
        executionBudget: budget,
      })
      .catch((error: unknown) => error);
    try {
      await entered;
      if (failure === 'revoked') maintainLease.mockResolvedValue(false);
      if (failure === 'authority_timeout')
        maintainLease.mockImplementation(() => new Promise(() => {}));
      vi.setSystemTime(startedAt + 105000);
      await vi.advanceTimersByTimeAsync(4000);
      if (failure === 'no_progress') {
        expect(exchange).toHaveBeenCalledTimes(1);
        vi.setSystemTime(startedAt + 165000);
        await vi.advanceTimersByTimeAsync(1000);
      }
      const error = await operation;
      expect(error).toBeInstanceOf(LocalCommandNotStartedError);
      expect((error as Error).message).toBe(
        {
          no_progress: 'SANDBOX_EXECUTION_NO_PROGRESS',
          revoked: 'EXECUTION_REVOKED',
          authority_timeout: 'EXECUTION_CONTROL_TIMEOUT',
        }[failure],
      );
      if (failure !== 'no_progress') expect(exchange).not.toHaveBeenCalled();
      expect(f.json).not.toHaveBeenCalled();
    } finally {
      abort.abort();
      await operation;
    }
  },
);

it('rejects an expired lease before touching managers, caches or containers', async () => {
  const f = await fixture();
  await expect(
    f.runner.execute(f.root, f.source.command, {
      ...f.options,
      leaseExpiresAt: new Date(Date.now() - 1).toISOString(),
    }),
  ).rejects.toThrow('EXECUTION_REVOKED');
  expect(f.tool).not.toHaveBeenCalled();
  expect(f.json).not.toHaveBeenCalled();
});

it('recovers OOM plus exit 0 as memory_limit and rejects an unconfirmed stopped state', async () => {
  const f = await fixture();
  await f.runner.execute(f.root, f.source.command, f.options);
  f.container().State.OOMKilled = true;
  expect(
    (await f.runner.recover(f.options.attemptId, f.source.command))!.reason,
  ).toBe('memory_limit');
  f.container().State.Status = 'dead';
  await expect(
    f.runner.recover(f.options.attemptId, f.source.command),
  ).rejects.toThrow('STOP_NOT_CONFIRMED');
});

it('removes the owned work volume if container creation fails, and preserves the reusable dependency cache', async () => {
  const f = await fixture(),
    original = f.json.getMockImplementation()!;
  f.json.mockImplementation(async (...args) => {
    if (args[0] === 'POST' && args[1].startsWith('/containers/create'))
      throw Error('daemon rejected create');
    return original(...args);
  });
  await expect(
    f.runner.execute(f.root, f.source.command, f.options),
  ).rejects.toThrow('daemon rejected create');
  expect([...f.volumes.keys()]).toHaveLength(1);
  expect([...f.volumes.keys()][0]).toContain('allrice-project-cache-');
});

it('starts the web tmpfs staging gate before upload and releases it only after the final marker', async () => {
  const f = await fixture();
  Object.assign(f.source.command.arguments.projectPreparation!, {
    resourceProfile: 'web-development',
  });
  const result = await f.runner.execute(f.root, f.source.command, f.options);
  expect(result.exitCode).toBe(0);
  const started =
    f.json.mock.invocationCallOrder[
      f.json.mock.calls.findIndex(
        (c) => c[0] === 'POST' && c[1].endsWith('/start'),
      )
    ]!;
  const uploads = vi.mocked(f.api.putArchive);
  expect(uploads.mock.invocationCallOrder.every((n) => n > started)).toBe(true);
  expect(f.staged.at(-1)!.includes(Buffer.from('.allrice/staging-ready'))).toBe(
    true,
  );
  expect(
    [...f.volumes.values()].find((v) =>
      (v.Name as string).startsWith('allrice-project-work-'),
    )!.Options,
  ).toEqual({
    type: 'tmpfs',
    device: 'tmpfs',
    o: 'size=1024m,nosuid,nodev,mode=0755',
  });
});
