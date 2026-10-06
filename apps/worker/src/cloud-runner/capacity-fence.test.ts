import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  CloudCommandInputSchema,
  type CloudCommandInput,
} from '@allrice/contracts';
import {
  CloudRunnerBackend,
  CloudRunnerError,
  type CloudRunResult,
} from './backend.js';

const ownerLabel = 'xyz.bplabs.allrice.cloud.slot-owner';
const deadlineLabel = 'xyz.bplabs.allrice.cloud.slot-deadline';
const attemptLabel = 'xyz.bplabs.allrice.cloud.attempt';
const fenceLabel = 'xyz.bplabs.allrice.cloud.slot-fence';
type Physical = NonNullable<Awaited<ReturnType<CloudRunnerBackend['inspect']>>>;
const args = CloudCommandInputSchema.parse({ script: 'synthetic' });

/** Name uniqueness, immutable IDs and non-forced start/delete serialization. */
class FenceDaemon extends CloudRunnerBackend {
  containers = new Map<string, Physical>();
  admitted = 0;
  override async capacity() {
    return { slots: 1, backendId: 'synthetic', availableBytes: 1024 ** 3 };
  }
  override async json<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (method === 'POST' && path.startsWith('/containers/create?name=')) {
      const name = path.split('name=')[1]!;
      if (this.containers.has(name))
        throw new CloudRunnerError('CLOUD_DAEMON_409');
      const config = body as {
        Labels: Record<string, string>;
        HostConfig: Physical['HostConfig'];
      };
      const c: Physical = {
        Id: randomUUID().replaceAll('-', '').repeat(2),
        Config: { Labels: config.Labels },
        HostConfig: config.HostConfig,
        State: {
          Running: false,
          Status: 'created',
          ExitCode: 0,
          OOMKilled: false,
        },
      };
      this.containers.set(name, c);
      return c as T;
    }
    if (method === 'GET') {
      const key = path.split('/')[2]!;
      const c =
        this.containers.get(key) ??
        [...this.containers.values()].find((c) => c.Id === key);
      if (!c) throw new CloudRunnerError('CLOUD_DAEMON_404');
      return c as T;
    }
    throw Error('unexpected synthetic request');
  }
  override async call(method: string, path: string): Promise<Buffer> {
    const key = path.split('/')[2]!.split('?')[0]!;
    const found = [...this.containers.entries()].find(([, c]) => c.Id === key);
    if (!found) throw new CloudRunnerError('CLOUD_DAEMON_404');
    const [name, c] = found;
    if (method === 'DELETE') {
      if (c.State.Running) throw new CloudRunnerError('CLOUD_DAEMON_409');
      this.containers.delete(name);
      return Buffer.alloc(0);
    }
    if (method === 'POST' && path.endsWith('/start')) {
      c.State.Running = true;
      c.State.Status = 'running';
      return Buffer.alloc(0);
    }
    throw Error('unexpected synthetic mutation');
  }
  async stale(owner: string) {
    return this.json<Physical>(
      'POST',
      '/containers/create?name=allrice-cloud-slot-0',
      {
        Labels: { [ownerLabel]: owner, [deadlineLabel]: '1' },
        HostConfig: {},
      },
    );
  }
  async attempt(owner: string) {
    return this.json<Physical>(
      'POST',
      `/containers/create?name=allrice-cloud-${owner}`,
      {
        Labels: { [attemptLabel]: owner },
        HostConfig: { Runtime: 'runsc' },
      },
    );
  }
  run() {
    return this.executeOffice(args, [], {
      attemptId: randomUUID(),
      deadlineAt: new Date(Date.now() + 5000).toISOString(),
      maintainLease: async () => true,
    });
  }
  protected override async executeAdmittedScript(
    _args: CloudCommandInput,
    _files: { path: string; contentBase64: string }[],
    options: Parameters<CloudRunnerBackend['execute']>[2],
  ): Promise<CloudRunResult> {
    expect(await options.maintainLease()).toBe(true);
    this.admitted++;
    return {
      containerId: 'a'.repeat(64),
      exitCode: 0,
      stopped: true,
      reason: 'completed',
      output: '',
      artifacts: [],
      elapsedMs: 1,
    };
  }
}

it('an old attempt created after the absence check cannot start after its slot is reassigned', async () => {
  const backend = new FenceDaemon(),
    owner = randomUUID(),
    stale = await backend.stale(owner);
  let late: Physical | undefined;
  const inspect = backend.inspect.bind(backend);
  vi.spyOn(backend, 'inspect').mockImplementation(async (id) => {
    const snapshot = await inspect(id);
    if (id === owner && !late) {
      expect(snapshot).toBeNull();
      late = await backend.attempt(owner); // Barrier: late create wins before the reclaimer's fence.
      expect(
        (
          await backend.json<Physical>(
            'GET',
            '/containers/allrice-cloud-slot-0/json',
          )
        ).Id,
      ).toBe(stale.Id);
      // The old Worker has already passed its final reservation check here.
    }
    return snapshot;
  });
  await backend.run();
  await expect(
    backend.call('POST', `/containers/${late!.Id}/start`),
  ).rejects.toThrow('CLOUD_DAEMON_404');
  expect(backend.admitted).toBe(1);
  expect(backend.containers.size).toBe(0);
});

it('an absence fence blocks late creation until its original immutable slot is withdrawn', async () => {
  const backend = new FenceDaemon(),
    owner = randomUUID(),
    stale = await backend.stale(owner);
  const call = backend.call.bind(backend);
  let fenced = false;
  vi.spyOn(backend, 'call').mockImplementation(async (method, path) => {
    if (method === 'DELETE' && path.includes(stale.Id)) {
      const fence = await backend.inspect(owner);
      expect(fence?.Config.Labels[fenceLabel]).toBe(stale.Id);
      fenced = true;
      await expect(backend.attempt(owner)).rejects.toThrow('CLOUD_DAEMON_409');
    }
    return call(method, path);
  });
  await backend.run();
  expect(fenced).toBe(true);
  expect(backend.containers.size).toBe(0);
});

it.each(['create', 'withdraw'] as const)(
  'keeps the original reservation and fence after an unknown %s acknowledgement',
  async (failure) => {
    const backend = new FenceDaemon(),
      owner = randomUUID(),
      stale = await backend.stale(owner);
    const json = backend.json.bind(backend),
      call = backend.call.bind(backend);
    vi.spyOn(backend, 'json').mockImplementation(async (method, path, body) => {
      const result = await json(method, path, body);
      if (failure === 'create' && method === 'POST' && path.endsWith(owner))
        throw new CloudRunnerError('CLOUD_DAEMON_TIMEOUT');
      return result;
    });
    vi.spyOn(backend, 'call').mockImplementation(async (method, path) => {
      if (failure === 'withdraw' && path.includes(stale.Id))
        throw new CloudRunnerError('CLOUD_DAEMON_TIMEOUT');
      return call(method, path);
    });
    await expect(backend.run()).rejects.toThrow('CLOUD_DAEMON_TIMEOUT');
    expect(backend.admitted).toBe(0);
    expect(backend.containers.get('allrice-cloud-slot-0')?.Id).toBe(stale.Id);
    expect((await backend.inspect(owner))?.Config.Labels[fenceLabel]).toBe(
      stale.Id,
    );
  },
);

it('attempt cleanup cannot remove an orphan fence before withdrawing the bound reservation', async () => {
  const backend = new FenceDaemon(),
    owner = randomUUID(),
    stale = await backend.stale(owner);
  const fence = await backend.attempt(owner);
  fence.Config.Labels[fenceLabel] = stale.Id;
  const call = backend.call.bind(backend);
  const deleted: string[] = [];
  vi.spyOn(backend, 'call').mockImplementation(async (method, path) => {
    deleted.push(path);
    return call(method, path);
  });
  await backend.cleanup(owner);
  expect(deleted.map((p) => p.split('/')[2]!.split('?')[0])).toEqual([
    stale.Id,
    fence.Id,
  ]);
  expect(backend.containers.size).toBe(0);
});

it('reconciles a successful reservation deletion whose acknowledgement was lost without starting work', async () => {
  const backend = new FenceDaemon(),
    owner = randomUUID(),
    stale = await backend.stale(owner);
  const call = backend.call.bind(backend);
  let lost = false;
  vi.spyOn(backend, 'call').mockImplementation(async (method, path) => {
    const result = await call(method, path);
    if (!lost && path.includes(stale.Id)) {
      lost = true;
      throw new CloudRunnerError('CLOUD_DAEMON_TIMEOUT');
    }
    return result;
  });
  await expect(backend.run()).rejects.toThrow('CLOUD_DAEMON_TIMEOUT');
  expect(backend.admitted).toBe(0);
  expect(backend.containers.has('allrice-cloud-slot-0')).toBe(false);
  expect((await backend.inspect(owner))?.Config.Labels[fenceLabel]).toBe(
    stale.Id,
  );
  await backend.cleanup(owner); // Readback confirms the original ID is already gone.
  expect(backend.containers.size).toBe(0);
});

it('two concurrent reclaimers cannot remove the fence while its bound reservation remains', async () => {
  const backend = new FenceDaemon(),
    owner = randomUUID(),
    stale = await backend.stale(owner);
  const call = backend.call.bind(backend);
  let second: Promise<CloudRunResult> | undefined, fenceId: string | undefined;
  vi.spyOn(backend, 'call').mockImplementation(async (method, path) => {
    if (method === 'DELETE' && path.includes(stale.Id) && !second) {
      fenceId = (await backend.inspect(owner))!.Id;
      // Barrier: a second reclaimer sees the fence before the first withdraws it.
      second = backend.run();
      await second;
    }
    if (method === 'DELETE' && fenceId && path.includes(fenceId))
      expect(
        [...backend.containers.values()].some((c) => c.Id === stale.Id),
      ).toBe(false);
    return call(method, path);
  });
  await backend.run();
  await second;
  expect(backend.admitted).toBe(2);
  expect(backend.containers.size).toBe(0);
});

it('a never-started fence is not a completed tool result', async () => {
  const backend = new FenceDaemon(),
    owner = randomUUID();
  const fence = await backend.attempt(owner);
  fence.Config.Labels[fenceLabel] = 'b'.repeat(64);
  await expect(
    backend.collect(owner, { arguments: args }, Date.now()),
  ).rejects.toThrow('CLOUD_RESULT_UNKNOWN');
  expect(fence.State.Running).toBe(false);
});
