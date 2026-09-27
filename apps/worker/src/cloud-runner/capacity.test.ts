import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it, expect } from 'vitest';
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
  override async inspect() {
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
