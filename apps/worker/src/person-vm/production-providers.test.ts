/** Actual provider construction/config serialization; synthetic command runner only. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import type * as Process from '../../../../packages/person-vm/src/process.ts';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApfsPersonVmDisk, MicrosandboxPersonVm } from '@allrice/person-vm';
import { productionInputsFixture } from './production-inputs.fixture.js';
const source = vi.hoisted(() => ({ read: vi.fn(), run: vi.fn() }));
vi.mock('./production-config.js', () => ({
  readProductionHostConfiguration: source.read,
}));
vi.mock('../../../../packages/person-vm/src/process.ts', async (original) => ({
  ...(await original<typeof Process>()),
  runCommand: source.run,
}));
import { createProductionPersonVmProviders } from './production-providers.js';
let f: Awaited<ReturnType<typeof productionInputsFixture>>;
const signal = () => new AbortController().signal;
beforeEach(async () => {
  f = await productionInputsFixture();
  source.read.mockResolvedValue(f.loaded);
  source.run.mockResolvedValue('microsandbox 0.7.16');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  await rm(f.root, { recursive: true, force: true });
});

it('constructs actual providers without launching or creating a disk', async () => {
  const value = await createProductionPersonVmProviders(signal());
  expect(value.native).toBeInstanceOf(MicrosandboxPersonVm);
  expect(value.disk).toBeInstanceOf(ApfsPersonVmDisk);
  expect(value.platform).toBe(f.loaded.platform);
  expect(value.configuration).toBe(f.loaded.configuration);
  expect(source.run).not.toHaveBeenCalled();
  await expect(stat(f.loaded.configuration.disk.root)).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('the actual native configuration consumes the same loaded platform snapshot', async () => {
  // A source-boundary double varies the trusted platform snapshot, not a product override.
  const platform = Object.freeze({
    ...f.loaded.platform,
    memoryMiB: 3072,
    idleMs: 3333,
  });
  const first = {
    ...f.loaded,
    platform,
    configuration: {
      ...f.loaded.configuration,
      memory: {
        ...f.loaded.configuration.memory,
        policy: {
          ...f.loaded.configuration.memory.policy,
          physicalBytes: platform.memoryMiB * 1024 ** 2,
        },
      },
    },
  };
  source.read.mockResolvedValueOnce(first);
  const value = await createProductionPersonVmProviders(signal());
  expect(value.platform).toBe(platform);
  const vmId = randomUUID(),
    mount = join(f.root, 'mount');
  await mkdir(mount);
  await value.native.prepare(
    {
      vmId,
      personId: randomUUID(),
      organizationId: randomUUID(),
      instanceId: randomUUID(),
      leaseEpoch: 1,
    },
    mount,
    signal(),
  );
  const config = JSON.parse(
    await readFile(join(mount, 'msb-config.json'), 'utf8'),
  );
  expect(config.sandbox_defaults.memory_mib).toBe(platform.memoryMiB);
  expect(config.paths.msb).toBe(f.loaded.configuration.native.binary);
  expect(source.read).toHaveBeenCalledTimes(1);
  expect(source.run).toHaveBeenCalledTimes(1);
  expect(source.run.mock.calls[0]![0].args).toEqual(['--version']);
});

it('missing trusted artifacts prevent provider use and any native command', async () => {
  await rm(f.loaded.configuration.native.binary);
  await expect(createProductionPersonVmProviders(signal())).rejects.toThrow(
    'PERSON_VM_ARTIFACTS_UNAVAILABLE',
  );
  expect(source.run).not.toHaveBeenCalled();
});
