import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { managedPythonPayloadForPlatform } from '@allrice/contracts';
import { LocalPythonRunner } from './local-python-runner.js';
import { LocalCommandError } from './local-command-inputs.js';
import type { PreparationEvent } from './preparation-progress.js';

const release = managedPythonPayloadForPlatform('macos-x64')!;
const attemptLabel = 'xyz.bplabs.allrice.python.attempt';
const probeLabel = 'xyz.bplabs.allrice.python.probe';
const info = {
  OSType: 'linux',
  Architecture: 'x86_64',
  CgroupVersion: '2',
  MemoryLimit: true,
  SwapLimit: true,
  PidsLimit: true,
  CpuCfsQuota: true,
  SecurityOptions: ['name=seccomp'],
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface Probe {
  Id: string;
  Name: string;
  Config: { Image: string; Labels: Record<string, string> };
  Mounts: [];
  State: {
    Running: boolean;
    Status: string;
    ExitCode: number;
    OOMKilled: boolean;
  };
}
interface Call {
  method: string;
  path: string;
  body?: Probe['Config'];
}

async function engine() {
  const root = await mkdtemp(join(tmpdir(), 'rice-preflight-cancel-'));
  const socket = join(root, 'engine.sock');
  const containers = new Map<string, Probe>();
  const calls: Call[] = [];
  const controls: {
    intercept?: (call: Call, res: ServerResponse) => boolean | Promise<boolean>;
  } = {};
  let sequence = 0;
  const create = (call: Call) => {
    const Id = createHash('sha256').update(String(sequence++)).digest('hex');
    const probe: Probe = {
      Id,
      Name: `/${new URL(call.path, 'http://fixture').searchParams.get('name')}`,
      Config: call.body!,
      Mounts: [],
      State: {
        Running: false,
        Status: 'created',
        ExitCode: 0,
        OOMKilled: false,
      },
    };
    containers.set(Id, probe);
    return probe;
  };
  const json = (res: ServerResponse, value: unknown) =>
    res.end(JSON.stringify(value));
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const call: Call = {
      method: req.method!,
      path: req.url!,
      ...(bytes.length
        ? { body: JSON.parse(bytes.toString()) as Probe['Config'] }
        : {}),
    };
    calls.push(call);
    if (await controls.intercept?.(call, res)) return;
    if (call.path.endsWith('/info')) return json(res, info);
    if (call.path.includes('/images/'))
      return json(res, {
        Id: release.imageId,
        Os: 'linux',
        Architecture: release.architecture,
      });
    if (call.path.includes('/containers/create?'))
      return json(res, { Id: create(call).Id });
    const reference = /^\/v1.45\/containers\/([^/?]+)/.exec(call.path)?.[1];
    const probe =
      containers.get(reference ?? '') ??
      [...containers.values()].find((p) => p.Name === `/${reference}`);
    if (!probe) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (call.path.endsWith('/json')) return json(res, probe);
    if (call.path.endsWith('/start')) {
      probe.State.Running = true;
      probe.State.Status = 'running';
      res.end();
      return;
    }
    if (call.path.includes('/logs?')) {
      probe.State.Running = false;
      probe.State.Status = 'exited';
      const proof = Buffer.from(
        JSON.stringify({
          architecture: release.architecture,
          pythonVersion: release.pythonVersion,
          packagesChecksum: release.packagesChecksum,
          officeChecker: release.officeChecker,
          pngChecker: release.pngChecker,
          font: release.font,
          checks: { cjkAggPng: true, corruptPngRejected: true },
        }),
      );
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(proof.length, 4);
      res.end(Buffer.concat([header, proof]));
      return;
    }
    if (call.path.includes('/kill?')) {
      probe.State.Running = false;
      probe.State.Status = 'exited';
      probe.State.ExitCode = 137;
      res.end();
      return;
    }
    if (call.method === 'DELETE') {
      containers.delete(probe.Id);
      res.end();
      return;
    }
    res.statusCode = 500;
    res.end();
  });
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  server.listen(socket);
  await once(server, 'listening');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    runner: new LocalPythonRunner({ socketPath: socket, release }),
    calls,
    containers,
    controls,
    create,
    json,
  };
}

describe('Python preparation cancellation owns and joins probe cleanup', () => {
  it.each(['info', 'image'])(
    'cancels the actual stalled %s read without a later preparation request',
    async (stage) => {
      const f = await engine(),
        reached = deferred(),
        closed = deferred();
      let lateReply!: () => void;
      f.controls.intercept = (call, res) => {
        if (
          stage === 'info'
            ? call.path.endsWith('/info')
            : call.path.includes('/images/')
        ) {
          res.once('close', closed.resolve);
          lateReply = () =>
            f.json(
              res,
              stage === 'info'
                ? info
                : {
                    Id: release.imageId,
                    Os: 'linux',
                    Architecture: release.architecture,
                  },
            );
          reached.resolve();
          return true;
        }
        return false;
      };
      const events: PreparationEvent[] = [];
      f.runner.onPreparationStep = (event) => events.push(event);
      const cancel = new AbortController(),
        reason = Error('quit');
      const pending = f.runner.preflight(cancel.signal, false);
      const rejected = expect(pending).rejects.toBe(reason);
      await reached.promise;
      cancel.abort(reason);
      await rejected;
      await closed.promise;
      lateReply();
      expect(f.calls).toHaveLength(stage === 'info' ? 1 : 2);
      expect(events.at(-1)).toEqual({
        component: 'python',
        step: stage === 'info' ? 'engine_info' : 'image_check',
        state: 'failed',
      });
    },
  );

  it('does not touch the socket for an already canceled preparation', async () => {
    const f = await engine();
    const verify = vi.spyOn(f.runner.api, 'verifySocket');
    const cancel = new AbortController();
    cancel.abort();
    await expect(f.runner.preflight(cancel.signal)).rejects.toThrow();
    expect(verify).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
  });

  it('reconciles a lost create response by unique name and awaits deletion', async () => {
    const f = await engine(),
      created = deferred(),
      deleteReached = deferred(),
      allowDelete = deferred();
    const cancel = new AbortController(),
      reason = Error('quit during create');
    f.controls.intercept = async (call) => {
      if (call.path.includes('/containers/create?')) {
        cancel.abort(reason);
        await delay(60);
        f.create(call);
        created.resolve();
        return true;
      }
      if (call.method === 'DELETE') {
        deleteReached.resolve();
        await allowDelete.promise;
      }
      return false;
    };
    let settled = false;
    const pending = f.runner.preflight(cancel.signal).finally(() => {
      settled = true;
    });
    const rejected = expect(pending).rejects.toBe(reason);
    await created.promise;
    await deleteReached.promise;
    expect(settled).toBe(false);
    expect(f.containers.size).toBe(1);
    allowDelete.resolve();
    await rejected;
    expect(f.containers.size).toBe(0);
    expect(
      f.calls.filter((c) => c.path.includes('/containers/create?')),
    ).toHaveLength(1);
    expect(
      f.calls.some(
        (c) => c.path.endsWith('/start') || c.path.includes('/logs?'),
      ),
    ).toBe(false);
    expect(
      f.calls.some((c) =>
        /\/containers\/allrice-python-probe-.*\/json/.test(c.path),
      ),
    ).toBe(true);
  });

  it.each(['start', 'logs', 'inspect'])(
    'cancels %s and waits for an independently authorized kill and deletion',
    async (stage) => {
      const f = await engine(),
        reached = deferred(),
        killReached = deferred(),
        allowKill = deferred();
      const cancel = new AbortController(),
        reason = Error(`quit during ${stage}`);
      let started = false;
      f.controls.intercept = async (call, res) => {
        const probe = [...f.containers.values()][0];
        if (call.path.endsWith('/start')) {
          started = true;
          if (stage === 'start') {
            probe!.State.Running = true;
            probe!.State.Status = 'running';
            reached.resolve();
            return true;
          }
        }
        if (
          (stage === 'logs' && call.path.includes('/logs?')) ||
          (stage === 'inspect' &&
            started &&
            call.path.endsWith('/json') &&
            !cancel.signal.aborted)
        ) {
          if (stage === 'inspect') probe!.State.Running = true;
          res.flushHeaders();
          reached.resolve();
          return true;
        }
        if (call.path.includes('/kill?')) {
          killReached.resolve();
          await allowKill.promise;
        }
        return false;
      };
      const events: PreparationEvent[] = [];
      f.runner.onPreparationStep = (event) => events.push(event);
      let settled = false;
      const pending = f.runner.preflight(cancel.signal).finally(() => {
        settled = true;
      });
      const rejected = expect(pending).rejects.toBe(reason);
      await reached.promise;
      cancel.abort(reason);
      await killReached.promise;
      expect(settled).toBe(false);
      expect(f.calls.some((c) => c.method === 'DELETE')).toBe(false);
      allowKill.resolve();
      await rejected;
      expect(f.containers.size).toBe(0);
      expect(f.calls.filter((c) => c.path.includes('/kill?'))).toHaveLength(1);
      expect(events.at(-1)).toEqual({
        component: 'python',
        step: 'probe_cleanup',
        state: 'completed',
      });
    },
  );

  it.each(['foreign_label', 'still_running', 'delete_unknown'])(
    'retains an unconfirmed %s without claiming availability',
    async (mode) => {
      const f = await engine(),
        reached = deferred();
      const cancel = new AbortController();
      f.controls.intercept = (call, res) => {
        const probe = [...f.containers.values()][0];
        if (call.path.includes('/logs?')) {
          if (mode === 'foreign_label')
            probe!.Config.Labels[attemptLabel] = 'someone-else';
          reached.resolve();
          return true;
        }
        if (
          (mode === 'still_running' && call.path.includes('/kill?')) ||
          (mode === 'delete_unknown' && call.method === 'DELETE')
        ) {
          res.statusCode = 500;
          res.end();
          return true;
        }
        return false;
      };
      const pending = f.runner.preflight(cancel.signal);
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'STOP_NOT_CONFIRMED',
      });
      await reached.promise;
      cancel.abort();
      await rejected;
      expect(f.containers.size).toBe(1);
      expect(f.calls.filter((c) => c.path.includes('/kill?'))).toHaveLength(
        mode === 'foreign_label' ? 0 : 1,
      );
      expect(f.calls.filter((c) => c.method === 'DELETE')).toHaveLength(
        mode === 'delete_unknown' ? 1 : 0,
      );
    },
  );

  it('confirms lost kill and delete responses by reading back, without write retries', async () => {
    const f = await engine(),
      reached = deferred();
    const cancel = new AbortController(),
      reason = Error('quit');
    f.controls.intercept = (call, res) => {
      const probe = [...f.containers.values()][0];
      if (call.path.includes('/logs?')) {
        reached.resolve();
        return true;
      }
      if (call.path.includes('/kill?')) {
        probe!.State.Running = false;
        probe!.State.Status = 'exited';
        res.destroy();
        return true;
      }
      if (call.method === 'DELETE') {
        f.containers.delete(probe!.Id);
        res.destroy();
        return true;
      }
      return false;
    };
    const pending = f.runner.preflight(cancel.signal);
    const rejected = expect(pending).rejects.toBe(reason);
    await reached.promise;
    cancel.abort(reason);
    await rejected;
    expect(f.containers.size).toBe(0);
    expect(f.calls.filter((c) => c.path.includes('/kill?'))).toHaveLength(1);
    expect(f.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('does not start a foreign container returned as the create ID', async () => {
    const f = await engine();
    const foreign = 'f'.repeat(64);
    f.controls.intercept = (call, res) => {
      if (call.path.includes('/containers/create?')) {
        f.create(call);
        f.json(res, { Id: foreign });
        return true;
      }
      if (call.path === `/v1.45/containers/${foreign}/json`) {
        f.json(res, {
          ...[...f.containers.values()][0],
          Id: foreign,
          Config: {
            Image: release.imageId,
            Labels: { [attemptLabel]: 'foreign', [probeLabel]: '1' },
          },
        });
        return true;
      }
      return false;
    };
    await expect(
      f.runner.preflight(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'CONTAINER_IDENTITY_CHANGED' });
    expect(
      f.calls.some(
        (c) => c.path.endsWith('/start') || c.path.includes('/kill?'),
      ),
    ).toBe(false);
    expect(
      f.calls.some((c) => c.method === 'DELETE' && c.path.includes(foreign)),
    ).toBe(false);
    expect(f.containers.size).toBe(0);
  });

  it('bounds absent unknown-create reconciliation instead of claiming an empty cleanup', async () => {
    vi.useFakeTimers();
    const runner = new LocalPythonRunner({
      socketPath: '/tmp/not-contacted.sock',
      release,
    });
    vi.spyOn(runner.api, 'verifySocket').mockResolvedValue();
    const cancel = new AbortController();
    const calls: string[] = [];
    vi.spyOn(runner.api, 'json').mockImplementation(async (_method, path) => {
      calls.push(path);
      if (path === '/info') return info as never;
      if (path.includes('/images/'))
        return {
          Id: release.imageId,
          Os: 'linux',
          Architecture: release.architecture,
        } as never;
      if (path.includes('/containers/create?')) {
        cancel.abort();
        throw cancel.signal.reason;
      }
      throw new LocalCommandError('DAEMON_HTTP_404');
    });
    const pending = runner.preflight(cancel.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'STOP_NOT_CONFIRMED',
    });
    await vi.advanceTimersByTimeAsync(10_001);
    await rejected;
    expect(
      calls.filter((path) => path.includes('/containers/create?')),
    ).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('advertises only after verified deletion, and diagnostics cannot interrupt cleanup', async () => {
    const f = await engine();
    const events: PreparationEvent[] = [];
    f.runner.onPreparationStep = (event) => {
      events.push(event);
      throw Error('diagnostic observer');
    };
    await expect(
      f.runner.preflight(new AbortController().signal),
    ).resolves.toMatchObject({ available: true, stopConfirmed: true });
    expect(f.containers.size).toBe(0);
    expect(
      events.filter((e) => e.state === 'started').map((e) => e.step),
    ).toEqual([
      'engine_socket',
      'engine_info',
      'image_check',
      'probe_create',
      'probe_inspect',
      'probe_start',
      'probe_logs',
      'probe_inspect',
      'probe_cleanup',
    ]);
    expect(events.every((e) => e.component === 'python')).toBe(true);
    await f.runner.preflight(new AbortController().signal, false);
    expect(
      f.calls.filter((c) => c.path.includes('/containers/create?')),
    ).toHaveLength(1);
  });
});
