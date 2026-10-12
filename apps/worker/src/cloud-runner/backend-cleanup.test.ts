import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { CloudRunnerBackend, CloudRunnerError } from './backend.js';

const ownerLabel = 'xyz.bplabs.allrice.cloud.slot-owner';
const deadlineLabel = 'xyz.bplabs.allrice.cloud.slot-deadline';
const attemptLabel = 'xyz.bplabs.allrice.cloud.attempt';
type Physical = NonNullable<Awaited<ReturnType<CloudRunnerBackend['inspect']>>>;

/** Minimal daemon: list filters, immutable IDs, name reuse and delete/start conflicts. */
class CleanupDaemon extends CloudRunnerBackend {
  containers = new Map<string, Physical>();
  deleted: string[] = [];
  add(name: string, labels: Record<string, string>, status = 'created') {
    const container: Physical = {
      Id: randomUUID().replaceAll('-', '').repeat(2),
      Name: `/${name}`,
      Config: { Labels: labels },
      HostConfig: { Runtime: 'runsc' },
      State: {
        Running: status === 'running',
        Status: status,
        ExitCode: 0,
        OOMKilled: false,
      },
    };
    this.containers.set(name, container);
    return container;
  }
  attempt(owner: string, status = 'exited') {
    return this.add(
      `allrice-cloud-${owner}`,
      { [attemptLabel]: owner },
      status,
    );
  }
  slot(owner: string, slot = 0) {
    return this.add(`allrice-cloud-slot-${slot}`, {
      [ownerLabel]: owner,
      [deadlineLabel]: String(Date.now() + 90_000),
    });
  }
  override async json<T>(method: string, path: string): Promise<T> {
    expect(method).toBe('GET');
    if (path.startsWith('/containers/json?')) {
      const query = new URL(path, 'http://daemon').searchParams;
      expect(query.get('all')).toBe('true');
      const { label } = JSON.parse(query.get('filters')!);
      return [...this.containers.values()]
        .filter((c) =>
          label.every((l: string) => {
            const [key, value] = l.split('=');
            return c.Config.Labels[key!] === value;
          }),
        )
        .map(({ Id }) => ({ Id })) as T;
    }
    const id = path.split('/')[2]!;
    const container =
      this.containers.get(id) ??
      [...this.containers.values()].find((c) => c.Id === id);
    if (!container) throw new CloudRunnerError('CLOUD_DAEMON_404');
    return structuredClone(container) as T;
  }
  override async call(method: string, path: string): Promise<Buffer> {
    expect(method).toBe('DELETE');
    expect(path).not.toContain('force');
    const id = path.split('/')[2]!.split('?')[0]!;
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    const entry = [...this.containers.entries()].find(([, c]) => c.Id === id);
    if (!entry) throw new CloudRunnerError('CLOUD_DAEMON_404');
    if (entry[1].State.Running) throw new CloudRunnerError('CLOUD_DAEMON_409');
    this.deleted.push(id);
    this.containers.delete(entry[0]);
    return Buffer.alloc(0);
  }
}

it.each([1, 3])(
  'cold cleanup releases all %i unexpired owned slots before deleting the exited attempt',
  async (count) => {
    const backend = new CleanupDaemon(),
      owner = randomUUID();
    const attempt = backend.attempt(owner);
    const slots = Array.from({ length: count }, (_, i) =>
      backend.slot(owner, i),
    );
    const other = backend.slot(randomUUID(), count);
    const call = backend.call.bind(backend);
    vi.spyOn(backend, 'call').mockImplementation(async (method, path) => {
      if (slots.some((s) => path.includes(s.Id)))
        expect((await backend.inspect(owner))?.Id).toBe(attempt.Id);
      return call(method, path);
    });
    await backend.cleanup(owner);
    expect(backend.deleted).toEqual([...slots.map((s) => s.Id), attempt.Id]);
    expect([...backend.containers.values()]).toEqual([other]);
  },
);

it.each(['created', 'missing'])(
  'does not fast-release the ordinary slot of a %s attempt',
  async (state) => {
    const backend = new CleanupDaemon(),
      owner = randomUUID();
    if (state === 'created') backend.attempt(owner, state);
    const slot = backend.slot(owner);
    await backend.cleanup(owner);
    expect(backend.containers.get('allrice-cloud-slot-0')?.Id).toBe(slot.Id);
    expect(backend.deleted).not.toContain(slot.Id);
  },
);

it.each(['timeout-before-delete', 'lost-delete-ack', 'conflict'])(
  'retains the attempt on %s and reconciles before a later cleanup',
  async (failure) => {
    const backend = new CleanupDaemon(),
      owner = randomUUID();
    const attempt = backend.attempt(owner),
      slot = backend.slot(owner);
    const call = backend.call.bind(backend);
    let fail = true;
    vi.spyOn(backend, 'call').mockImplementation(async (method, path) => {
      if (fail && path.includes(slot.Id)) {
        fail = false;
        if (failure === 'lost-delete-ack') await call(method, path);
        throw new CloudRunnerError(
          failure === 'conflict' ? 'CLOUD_DAEMON_409' : 'CLOUD_DAEMON_TIMEOUT',
        );
      }
      return call(method, path);
    });
    await expect(backend.cleanup(owner)).rejects.toThrow(
      failure === 'conflict'
        ? 'CLOUD_RECOVERY_REQUIRED'
        : 'CLOUD_DAEMON_TIMEOUT',
    );
    expect((await backend.inspect(owner))?.Id).toBe(attempt.Id);
    expect(backend.deleted).not.toContain(attempt.Id);
    await backend.cleanup(owner);
    expect(backend.containers.size).toBe(0);
  },
);

it('never deletes a new slot owner after its name is reassigned', async () => {
  const backend = new CleanupDaemon(),
    owner = randomUUID();
  const attempt = backend.attempt(owner),
    slot = backend.slot(owner);
  const json = backend.json.bind(backend);
  let replacement: Physical | undefined;
  vi.spyOn(backend, 'json').mockImplementation(async (method, path) => {
    const result = await json(method, path);
    if (path === `/containers/${slot.Id}/json` && !replacement) {
      backend.containers.delete('allrice-cloud-slot-0');
      replacement = backend.slot(randomUUID());
    }
    return result;
  });
  await backend.cleanup(owner);
  expect([...backend.containers.values()]).toEqual([replacement]);
  expect(backend.deleted).toEqual([attempt.Id]);
});

it.each(['owner', 'name', 'running', 'status', 'id'])(
  'fails closed when a listed reservation changes %s',
  async (change) => {
    const backend = new CleanupDaemon(),
      owner = randomUUID();
    const attempt = backend.attempt(owner),
      slot = backend.slot(owner);
    const json = backend.json.bind(backend);
    vi.spyOn(backend, 'json').mockImplementation(async (method, path) => {
      const result = await json(method, path);
      if (path === `/containers/${slot.Id}/json`) {
        const c = result as Physical;
        if (change === 'owner') c.Config.Labels[ownerLabel] = randomUUID();
        if (change === 'name') c.Name = '/unrelated-container';
        if (change === 'running') c.State.Running = true;
        if (change === 'status') c.State.Status = 'exited';
        if (change === 'id') c.Id = 'f'.repeat(64);
      }
      return result;
    });
    await expect(backend.cleanup(owner)).rejects.toThrow(
      'CLOUD_SLOT_FENCE_CHANGED',
    );
    expect((await backend.inspect(owner))?.Id).toBe(attempt.Id);
    expect(backend.deleted).toEqual([]);
  },
);

it('does not confirm cleanup when a successful delete still reads back the old reservation', async () => {
  const backend = new CleanupDaemon(),
    owner = randomUUID();
  const attempt = backend.attempt(owner),
    slot = backend.slot(owner);
  vi.spyOn(backend, 'call').mockResolvedValue(Buffer.alloc(0));
  await expect(backend.cleanup(owner)).rejects.toThrow(
    'CLOUD_CLEANUP_UNCONFIRMED',
  );
  expect((await backend.inspect(owner))?.Id).toBe(attempt.Id);
  expect(backend.containers.get('allrice-cloud-slot-0')?.Id).toBe(slot.Id);
});

it.each(['lost-ack', 'conflict'])(
  'reconciles a partially withdrawn multi-slot group after %s without deleting its new owner',
  async (failure) => {
    const backend = new CleanupDaemon(),
      owner = randomUUID();
    const attempt = backend.attempt(owner);
    const first = backend.slot(owner),
      second = backend.slot(owner, 1);
    const call = backend.call.bind(backend);
    let fail = true;
    vi.spyOn(backend, 'call').mockImplementation(async (method, path) => {
      if (fail && path.includes(second.Id)) {
        fail = false;
        if (failure === 'lost-ack') await call(method, path);
        throw new CloudRunnerError(
          failure === 'lost-ack' ? 'CLOUD_DAEMON_TIMEOUT' : 'CLOUD_DAEMON_409',
        );
      }
      return call(method, path);
    });
    await expect(backend.cleanup(owner)).rejects.toThrow();
    expect(backend.deleted).toContain(first.Id);
    expect((await backend.inspect(owner))?.Id).toBe(attempt.Id);
    const replacement = backend.slot(randomUUID());
    await backend.cleanup(owner);
    expect([...backend.containers.values()]).toEqual([replacement]);
    expect(backend.deleted).not.toContain(replacement.Id);
  },
);

it.each(['missing', 'id', 'state'])(
  'does not delete a replacement attempt when final identity readback changes %s',
  async (change) => {
    const backend = new CleanupDaemon(),
      owner = randomUUID();
    const attempt = backend.attempt(owner),
      slot = backend.slot(owner);
    const call = backend.call.bind(backend);
    let replacement: Physical | undefined;
    vi.spyOn(backend, 'call').mockImplementation(async (method, path) => {
      const result = await call(method, path);
      if (path.includes(slot.Id)) {
        backend.containers.delete(`allrice-cloud-${owner}`);
        if (change !== 'missing')
          replacement = backend.attempt(
            owner,
            change === 'state' ? 'created' : 'exited',
          );
        if (change === 'state') replacement!.Id = attempt.Id;
      }
      return result;
    });
    await expect(backend.cleanup(owner)).rejects.toThrow(
      'CLOUD_CLEANUP_UNCONFIRMED',
    );
    expect(backend.deleted).toEqual([slot.Id]);
    if (replacement)
      expect((await backend.inspect(owner))?.Id).toBe(replacement.Id);
  },
);
