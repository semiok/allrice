import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  managedNodePayloadForPlatform,
  managedPythonPayloadForPlatform,
} from '@allrice/contracts';
import type * as Runtime from '@allrice/project-runtime';
const ports = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('@allrice/project-runtime', async (original) => ({
  ...(await original<typeof Runtime>()),
  downloadManagedRuntimeAsset: ports.download,
}));
import { ManagedPythonSandbox } from './managed-python-sandbox.js';
import { LocalCommandError } from './local-command-inputs.js';
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
function fixture() {
  const platform = `macos-${process.arch}`;
  const python = managedPythonPayloadForPlatform(platform)!,
    node = managedNodePayloadForPlatform(platform)!;
  const sandbox = new ManagedPythonSandbox(
    {
      server: 'https://synthetic.invalid',
      deviceId: randomUUID(),
      deviceName: 'Fixture',
      grants: [],
    },
    python,
  );
  const startup = vi.spyOn(
    sandbox as unknown as { startVM(signal: AbortSignal): Promise<void> },
    'startVM',
  );
  const stop = vi.spyOn(sandbox, 'stop').mockResolvedValue();
  const preflight = vi.spyOn(sandbox.runner, 'preflight');
  const inspect = vi.spyOn(sandbox.runner.api, 'json').mockResolvedValue({
    Id: node.imageId,
    Architecture: node.architecture,
    Os: 'linux',
  });
  return { sandbox, startup, stop, preflight, inspect };
}
it('Node becomes ready while Python is still downloading; Python failure cannot stop their shared VM', async () => {
  const f = fixture();
  let ready!: () => void, failDownload!: (e: Error) => void;
  const downloading = new Promise<void>((r) => (ready = r));
  f.startup.mockImplementation(async () => {
    Reflect.set(f.sandbox, 'started', true);
  });
  f.preflight.mockRejectedValue(new LocalCommandError('DAEMON_HTTP_404'));
  ports.download.mockImplementation(() => {
    ready();
    return new Promise<void>((_r, reject) => (failDownload = reject));
  });
  const signal = new AbortController().signal;
  const python = f.sandbox.prepareManaged(signal).catch((e) => e);
  const node = f.sandbox.prepareNodeImage(signal);
  await downloading;
  await node;
  expect(f.startup).toHaveBeenCalledOnce();
  expect(f.inspect).toHaveBeenCalledOnce();
  failDownload(new LocalCommandError('RUNTIME_DOWNLOAD_STALLED'));
  expect(await python).toMatchObject({ code: 'RUNTIME_DOWNLOAD_STALLED' });
  expect(f.sandbox.preparation.get('python')).toMatchObject({
    stage: 'failed',
    reason: 'RUNTIME_DOWNLOAD_STALLED',
  });
  expect(f.sandbox.preparation.get('node')).toMatchObject({ stage: 'ready' });
  await expect(f.sandbox.prepareManaged(signal)).rejects.toMatchObject({
    code: 'RUNTIME_DOWNLOAD_STALLED',
  });
  expect(ports.download).toHaveBeenCalledOnce();
  expect(f.stop).not.toHaveBeenCalled();
  expect(Reflect.get(f.sandbox, 'started')).toBe(true);
});
it('allows a new attempt after failed VM preparation instead of caching a rejected promise', async () => {
  const f = fixture();
  f.startup
    .mockRejectedValueOnce(
      new LocalCommandError('RUNTIME_DOWNLOAD_UNAVAILABLE'),
    )
    .mockImplementationOnce(async () => {
      Reflect.set(f.sandbox, 'started', true);
    });
  const signal = new AbortController().signal;
  await expect(f.sandbox.prepareNodeImage(signal)).rejects.toMatchObject({
    code: 'RUNTIME_DOWNLOAD_UNAVAILABLE',
  });
  await f.sandbox.prepareNodeImage(signal);
  expect(f.startup).toHaveBeenCalledTimes(2);
  expect(f.inspect).toHaveBeenCalledOnce();
});
it('does not start image preparation after pause during shared VM startup', async () => {
  const f = fixture(),
    abort = new AbortController();
  let release!: () => void;
  f.startup.mockImplementation(() => new Promise<void>((r) => (release = r)));
  const result = f.sandbox.prepareNodeImage(abort.signal);
  abort.abort();
  release();
  await expect(result).rejects.toThrow();
  expect(f.inspect).not.toHaveBeenCalled();
  expect(ports.download).not.toHaveBeenCalled();
});
