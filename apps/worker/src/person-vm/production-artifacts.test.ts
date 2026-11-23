/** Real artifact I/O; only the already-tested service-seal boundary is doubled. */
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { setImmediate as turn } from 'node:timers/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deferred } from '../d-entry/native-entry.fixture.js';
import { productionInputsFixture } from './production-inputs.fixture.js';
const source = vi.hoisted<{
  read: ReturnType<typeof vi.fn>;
  opened?: (file: FileHandle) => void;
}>(() => ({ read: vi.fn() }));
vi.mock('./production-config.js', () => ({
  readProductionHostConfiguration: source.read,
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const file = await actual.open(...args);
      source.opened?.(file);
      return file;
    },
  };
});
import {
  ProductionPersonVmArtifactsUnavailable,
  readVerifiedProductionPersonVmInputs,
} from './production-artifacts.js';
let f: Awaited<ReturnType<typeof productionInputsFixture>>;
const signal = () => new AbortController().signal;
beforeEach(async () => {
  f = await productionInputsFixture();
  source.read.mockResolvedValue(f.loaded);
});
afterEach(async () => {
  source.opened = undefined;
  vi.restoreAllMocks();
  vi.resetAllMocks();
  await fs.rm(f.root, { recursive: true, force: true });
});

it('checks complete actual bytes for all three artifacts and returns the exact sealed snapshot', async () => {
  const opened: FileHandle[] = [];
  source.opened = (file) => opened.push(file);
  const current = signal();
  expect(await readVerifiedProductionPersonVmInputs(current)).toBe(f.loaded);
  expect(source.read).toHaveBeenCalledExactlyOnceWith(current);
  expect(opened).toHaveLength(3);
  for (const file of opened)
    await expect(file.stat()).rejects.toMatchObject({ code: 'EBADF' });
});

it.each(['binary', 'libkrunfw', 'agentd'] as const)(
  'rejects modified %s bytes without deriving expected hashes from them',
  async (name) => {
    await fs.appendFile(f.loaded.configuration.native[name], 'changed');
    await expect(
      readVerifiedProductionPersonVmInputs(signal()),
    ).rejects.toBeInstanceOf(ProductionPersonVmArtifactsUnavailable);
  },
);

it.each(['missing', 'directory', 'symlink'] as const)(
  'rejects a %s artifact instead of consuming another source',
  async (kind) => {
    const path = f.loaded.configuration.native.binary;
    const copy = join(f.root, 'same-artifact');
    await fs.copyFile(path, copy);
    await fs.unlink(path);
    if (kind === 'directory') await fs.mkdir(path);
    if (kind === 'symlink') await fs.symlink(copy, path);
    await expect(
      readVerifiedProductionPersonVmInputs(signal()),
    ).rejects.toBeInstanceOf(ProductionPersonVmArtifactsUnavailable);
  },
);

it('a rejected original seal does not touch any external artifact', async () => {
  const failure = new Error('original seal rejected'),
    opened = vi.fn();
  source.read.mockRejectedValueOnce(failure);
  source.opened = opened;
  await expect(readVerifiedProductionPersonVmInputs(signal())).rejects.toBe(
    failure,
  );
  expect(opened).not.toHaveBeenCalled();
});

it('an already cancelled read does not enter the original configuration source', async () => {
  const abort = new AbortController(),
    reason = new Error('cancelled');
  abort.abort(reason);
  await expect(readVerifiedProductionPersonVmInputs(abort.signal)).rejects.toBe(
    reason,
  );
  expect(source.read).not.toHaveBeenCalled();
});

it.each(['stat', 'close'] as const)(
  'cancellation during actual file %s joins its real I/O and rejects the original reason',
  async (method) => {
    const entered = deferred<void>(),
      release = deferred<void>();
    const abort = new AbortController(),
      reason = new Error('cancelled in file');
    let handle: FileHandle | undefined;
    source.opened = (file) => {
      if (handle) return;
      handle = file;
      if (method === 'stat') {
        const original = file.stat.bind(file);
        vi.spyOn(file, 'stat').mockImplementation(async () => {
          const result = await original();
          entered.resolve();
          await release.promise;
          return result;
        });
      } else {
        const original = file.close.bind(file);
        vi.spyOn(file, 'close').mockImplementation(async () => {
          entered.resolve();
          await release.promise;
          await original();
        });
      }
    };
    let settled = false;
    const outcome = readVerifiedProductionPersonVmInputs(abort.signal)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await entered.promise;
      abort.abort(reason);
      await turn();
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      await outcome;
    }
    expect(await outcome).toBe(reason);
    if (!handle) throw new Error('Expected actual opened file');
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
  },
);
