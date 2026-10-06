import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it, expect, vi } from 'vitest';
import {
  CloudCommandInputSchema,
  type CloudCommandInput,
} from '@allrice/contracts';
import {
  CloudRunnerBackend,
  CloudRunnerError,
  type CloudRunResult,
} from './backend.js';

type Slot = {
  Id: string;
  Config: { Labels: Record<string, string> };
  State: { Running: boolean };
};
class Daemon extends CloudRunnerBackend {
  slots = new Map<string, Slot>();
  active = 0;
  peak = 0;
  completed = 0;
  availableBytes = 2 * 1024 ** 3;
  override async capacity() {
    return {
      slots: 2,
      backendId: 'synthetic',
      availableBytes: this.availableBytes,
    };
  }
  override async json<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (
      method === 'POST' &&
      path.startsWith('/containers/create?name=allrice-cloud-slot-')
    ) {
      const name = path.split('name=')[1]!;
      if (this.slots.has(name)) throw new CloudRunnerError('CLOUD_DAEMON_409');
      const slot = {
        Id: randomUUID().replaceAll('-', '').repeat(2),
        Config: { Labels: (body as { Labels: Record<string, string> }).Labels },
        State: { Running: false },
      };
      this.slots.set(name, slot);
      return slot as T;
    }
    if (method === 'GET') {
      const name = path.split('/')[2]!;
      const slot = this.slots.get(name);
      if (!slot) throw new CloudRunnerError('CLOUD_DAEMON_404');
      return slot as T;
    }
    throw Error('unexpected synthetic Docker request');
  }
  override async call(method: string, path: string) {
    if (method !== 'DELETE')
      throw Error('unexpected synthetic Docker mutation');
    for (const [name, slot] of this.slots)
      if (path.includes(slot.Id)) {
        this.slots.delete(name);
        return Buffer.alloc(0);
      }
    throw new CloudRunnerError('CLOUD_DAEMON_404');
  }
  override async inspect(
    attemptId: string,
  ): ReturnType<CloudRunnerBackend['inspect']> {
    expect(attemptId).toMatch(/^[a-f0-9-]{36}$/);
    return null;
  }
  protected override async executeAdmittedScript(
    _args: CloudCommandInput,
    _files: { path: string; contentBase64: string }[],
    options: Parameters<CloudRunnerBackend['execute']>[2],
  ): Promise<CloudRunResult> {
    expect(await options.maintainLease()).toBe(true);
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    await delay(50);
    this.active--;
    this.completed++;
    return {
      containerId: 'a'.repeat(64),
      exitCode: 0,
      stopped: true,
      reason: 'completed',
      output: '',
      artifacts: [],
      elapsedMs: 50,
    };
  }
}
const args = CloudCommandInputSchema.parse({ script: 'synthetic' });
describe('shared physical sandbox capacity', () => {
  it('a heavier compiler reserves two units before starting and leaves no partial reservations', async () => {
    const backend = new Daemon();
    let entered!: () => void, unblock!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      unblock = r;
    });
    const execute = Reflect.get(backend, 'executeWithSlot').bind(backend);
    const heavy = execute(
      { memoryMiB: 768 },
      'synthetic-image',
      {
        attemptId: randomUUID(),
        deadlineAt: new Date(Date.now() + 5000).toISOString(),
        maintainLease: async () => true,
      },
      async (options: { maintainLease: () => Promise<boolean> }) => {
        expect(backend.slots.size).toBe(2);
        expect(await options.maintainLease()).toBe(true);
        entered();
        await gate;
        return { reason: 'completed', elapsedMs: 1 };
      },
    );
    await ready;
    const ordinary = backend.executeOffice(args, [], {
      attemptId: randomUUID(),
      deadlineAt: new Date(Date.now() + 5000).toISOString(),
      maintainLease: async () => true,
    });
    await delay(20);
    expect(backend.completed).toBe(0);
    unblock();
    await Promise.all([heavy, ordinary]);
    expect(backend.completed).toBe(1);
    expect(backend.slots.size).toBe(0);
  });
  it('does not hold one reservation while waiting for the second, or remove another owner on cancel', async () => {
    const backend = new Daemon(),
      foreign = randomUUID(),
      abort = new AbortController();
    backend.slots.set('allrice-cloud-slot-1', {
      Id: 'f'.repeat(64),
      State: { Running: false },
      Config: {
        Labels: {
          'xyz.bplabs.allrice.cloud.slot-owner': foreign,
          'xyz.bplabs.allrice.cloud.slot-deadline': String(Date.now() + 60000),
        },
      },
    });
    const execute = Reflect.get(backend, 'executeWithSlot').bind(backend);
    const task = execute(
      { memoryMiB: 768 },
      'synthetic-image',
      {
        attemptId: randomUUID(),
        deadlineAt: new Date(Date.now() + 5000).toISOString(),
        signal: abort.signal,
        maintainLease: async () => true,
      },
      async () => {
        throw Error('must not start with one unit');
      },
    );
    const rejected = expect(task).rejects.toThrow('CLOUD_EXECUTION_REVOKED');
    await delay(100);
    expect(backend.slots.size).toBe(1);
    abort.abort();
    await rejected;
    expect(
      [...backend.slots.values()].map(
        (s) => s.Config.Labels['xyz.bplabs.allrice.cloud.slot-owner'],
      ),
    ).toEqual([foreign]);
  });
  it('twenty simultaneous requests drain through two atomic Docker reservations', async () => {
    const backend = new Daemon();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        backend.executeOffice(args, [], {
          attemptId: randomUUID(),
          deadlineAt: new Date(Date.now() + 30_000).toISOString(),
          maintainLease: async () => true,
        }),
      ),
    );
    expect(results.every((r) => r.reason === 'completed')).toBe(true);
    expect(backend.peak).toBe(2);
    expect(backend.completed).toBe(20);
    expect(backend.slots.size).toBe(0);
  }, 20000);
  it('cancels memory-pressure waiting before creating a reservation or starting work', async () => {
    const backend = new Daemon();
    backend.availableBytes = 100 * 1024 ** 2;
    const controller = new AbortController();
    const run = backend.executeOffice(args, [], {
      attemptId: randomUUID(),
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      maintainLease: async () => true,
      signal: controller.signal,
    });
    controller.abort();
    await expect(run).rejects.toThrow('CLOUD_EXECUTION_REVOKED');
    expect(backend.completed).toBe(0);
    expect(backend.slots.size).toBe(0);
  });
  it('retires an expired never-started attempt before allowing its slot to be reused', async () => {
    const backend = new Daemon();
    vi.spyOn(backend, 'capacity').mockResolvedValue({
      slots: 1,
      backendId: 'synthetic',
      availableBytes: 1024 ** 3,
    });
    const owner = randomUUID(),
      staleId = 'b'.repeat(64),
      placeholderId = 'c'.repeat(64);
    backend.slots.set('allrice-cloud-slot-0', {
      Id: placeholderId,
      Config: {
        Labels: {
          'xyz.bplabs.allrice.cloud.slot-owner': owner,
          'xyz.bplabs.allrice.cloud.slot-deadline': '1',
        },
      },
      State: { Running: false },
    });
    let retired = false;
    vi.spyOn(backend, 'inspect').mockImplementation(async (id) =>
      id === owner && !retired
        ? {
            Id: staleId,
            Config: { Labels: {} },
            HostConfig: { Runtime: 'runsc' },
            State: {
              Running: false,
              Status: 'created',
              ExitCode: 0,
              OOMKilled: false,
            },
          }
        : null,
    );
    const original = backend.call.bind(backend);
    vi.spyOn(backend, 'call').mockImplementation(async (method, path) => {
      if (path.includes(staleId)) {
        expect(method).toBe('DELETE');
        retired = true;
        return Buffer.alloc(0);
      }
      if (path.includes(placeholderId)) expect(retired).toBe(true);
      return original(method, path);
    });
    await backend.executeOffice(args, [], {
      attemptId: randomUUID(),
      deadlineAt: new Date(Date.now() + 5000).toISOString(),
      maintainLease: async () => true,
    });
    expect(retired).toBe(true);
    expect(backend.completed).toBe(1);
    vi.restoreAllMocks();
  });
  it('calculates VM capacity from effective memory and CPUs, including zero-slot nodes', () => {
    const source = fileURLToPath(new URL('./watchdog.py', import.meta.url));
    const result = JSON.parse(
      execFileSync(
        'python3',
        [
          '-B',
          '-c',
          "import importlib.util,json,sys; s=importlib.util.spec_from_file_location('guard',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps([m.calculate_capacity(mem,cpu,services) for mem,cpu,services in [(512*1024**2,2,0),(2*1024**3,2,0),(8*1024**3,8,0),(32*1024**3,16,0),(8*1024**3,1,0),(2*1024**3,2,768*1024**2)]]))",
          source,
        ],
        { encoding: 'utf8' },
      ),
    );
    expect(result.map((r: { slots: number }) => r.slots)).toEqual([
      0, 2, 10, 32, 2, 1,
    ]);
  });
});
