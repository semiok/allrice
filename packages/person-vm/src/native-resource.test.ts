import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { PersonVmBinding } from './contract.ts';
import {
  createPersonVmGuestMemoryReader,
  PERSON_VM_GUEST_CONTROL_READER,
  type PersonVmGuestControlTarget,
} from './native-resource.ts';
import { hostEnvironment, runCommand } from './process.ts';

const binding: PersonVmBinding = {
  vmId: 'synthetic-vm',
  personId: 'synthetic-person',
  organizationId: 'synthetic-org',
  instanceId: 'synthetic-instance',
  leaseEpoch: 1,
};
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'met267-controls-'));
  directories.push(root);
  const targets: PersonVmGuestControlTarget[] = [
    {
      target: 'commands',
      path: join(root, 'allrice-commands'),
      high: 768 * 1024 ** 2,
      max: 1280 * 1024 ** 2,
      swapMax: 2 * 1024 ** 3,
    },
    {
      target: 'dsh',
      path: join(root, 'allrice-dsh'),
      high: 'max',
      max: 'max',
      swapMax: 512 * 1024 ** 2,
    },
  ];
  for (const target of targets) {
    await mkdir(target.path);
    for (const [name, value] of [
      ['memory.high', target.high],
      ['memory.max', target.max],
      ['memory.swap.max', target.swapMax],
    ] as const)
      await writeFile(join(target.path, name), String(value) + '\n');
  }
  const command = vi.fn(async (args: string[], signal: AbortSignal) => {
    expect(args.slice(0, 7)).toEqual([
      'exec',
      'allrice-test',
      '--no-stdin',
      '--no-tty',
      '--',
      'node',
      '-e',
    ]);
    expect(args[7]).toBe(PERSON_VM_GUEST_CONTROL_READER);
    // Execute the actual fixed read-only probe on regular fixture files. Only
    // the public msb transport is replaced; this is not a real VM/cgroup test.
    return runCommand({
      executable: process.execPath,
      args: args.slice(6),
      env: hostEnvironment(root),
      signal,
    });
  });
  const input = {
    binding,
    name: 'allrice-test',
    command,
    cgroupRoot: root,
    targets,
  };
  return {
    root,
    targets,
    command,
    input,
    reader: createPersonVmGuestMemoryReader(input),
  };
}

describe('public exec guest control reader (fixture files; not physical RAM proof)', () => {
  it('reads actual controls, keeps the command 1.25GiB and DSH unlimited scopes, and never supplies a physical cap', async () => {
    const h = await fixture();
    const result = await h.reader.read(binding, new AbortController().signal);
    expect(result).toMatchObject({
      scope: 'guest-cgroup',
      boundary: 'guest-root-cooperative',
      state: 'verified',
    });
    expect(result.groups[0]).toMatchObject({
      target: 'commands',
      observed: {
        high: 768 * 1024 ** 2,
        max: 1280 * 1024 ** 2,
        swapMax: 2 * 1024 ** 3,
      },
    });
    expect(result.groups[1]).toMatchObject({
      target: 'dsh',
      observed: { high: 'max', max: 'max' },
    });
    expect(result).not.toHaveProperty('physical');
    expect(JSON.parse(h.command.mock.calls[0]![0][8]!)).toEqual(
      h.targets.map(({ target, path }) => ({ target, path })),
    );
    // Expectations are never sent to the probe as a fallback readback.
    expect(h.command).toHaveBeenCalledOnce();
    expect(await readFile(join(h.targets[1]!.path, 'memory.max'), 'utf8')).toBe(
      'max\n',
    );
  });

  it('missing whole-VM 2GiB controls stays unknown even when the command group readback succeeds', async () => {
    const h = await fixture();
    const reader = createPersonVmGuestMemoryReader({
      ...h.input,
      targets: [
        {
          target: 'vm-controls',
          path: h.root,
          high: 2 * 1024 ** 3,
          max: 2 * 1024 ** 3,
          swapMax: 2 * 1024 ** 3,
        },
        ...h.targets,
      ],
    });
    const result = await reader.read(binding, new AbortController().signal);
    expect(result.state).toBe('unknown');
    expect(result.groups[0]).toMatchObject({
      target: 'vm-controls',
      state: 'unknown',
      observed: null,
    });
    expect(result.groups[1]).toMatchObject({
      target: 'commands',
      state: 'verified',
      observed: { max: 1280 * 1024 ** 2 },
    });
    expect(result).not.toHaveProperty('physical');
  });

  it.each(['memory.high', 'memory.max', 'memory.swap.max'] as const)(
    'an actual mismatching %s rejects the readback rather than echoing expectations',
    async (file) => {
      const h = await fixture();
      await writeFile(join(h.targets[0]!.path, file), '123\n');
      const result = await h.reader.read(binding, new AbortController().signal);
      expect(result.state).toBe('unknown');
      expect(result.groups[0]?.reason).toBe('control-readback-mismatch');
      const field = {
        'memory.high': 'high',
        'memory.max': 'max',
        'memory.swap.max': 'swapMax',
      } as const;
      expect(result.groups[0]?.observed?.[field[file]]).toBe(123);
      expect(await readFile(join(h.targets[0]!.path, file), 'utf8')).toBe(
        '123\n',
      );
    },
  );

  it.each(['memory.high', 'memory.max', 'memory.swap.max'] as const)(
    'unreadable %s produces no configured/RSS/guest-physical replacement',
    async (file) => {
      const h = await fixture();
      await rm(join(h.targets[0]!.path, file));
      const result = await h.reader.read(binding, new AbortController().signal);
      expect(result.state).toBe('unknown');
      expect(result.groups[0]).toMatchObject({
        state: 'unknown',
        observed: null,
      });
      expect(result.groups[1]?.state).toBe('verified');
    },
  );

  it('revision is derived from actual resource readback, independent of lifecycle/admission cursors', async () => {
    const h = await fixture();
    const first = await h.reader.read(binding, new AbortController().signal);
    expect(
      (await h.reader.read(binding, new AbortController().signal)).revision,
    ).toBe(first.revision);
    await writeFile(join(h.targets[0]!.path, 'memory.max'), '123\n');
    const changed = await h.reader.read(binding, new AbortController().signal);
    expect(changed.revision).not.toBe(first.revision);
    expect(changed.state).toBe('unknown');
    expect(changed.evidenceRef).toContain(changed.revision);
  });

  it.each([
    'vmId',
    'personId',
    'organizationId',
    'instanceId',
    'leaseEpoch',
  ] as const)('different %s is refused before exec', async (field) => {
    const h = await fixture();
    await expect(
      h.reader.read(
        { ...binding, [field]: field === 'leaseEpoch' ? 2 : 'other' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(h.command).not.toHaveBeenCalled();
  });

  it('failed or malformed public exec stays unknown; no configuration fallback', async () => {
    const h = await fixture();
    for (const output of [
      'not-json',
      JSON.stringify({ version: 1, scope: 'host-physical', groups: [] }),
      JSON.stringify({
        version: 1,
        scope: 'guest-cgroup',
        groups: [{ target: 'other' }, {}],
      }),
    ]) {
      h.command.mockResolvedValueOnce(output);
      const result = await h.reader.read(binding, new AbortController().signal);
      expect(result.state).toBe('unknown');
      expect(result.groups.every((group) => group.observed === null)).toBe(
        true,
      );
    }
    h.command.mockRejectedValueOnce(new Error('exec unavailable'));
    expect(
      (await h.reader.read(binding, new AbortController().signal)).state,
    ).toBe('unknown');
  });

  it('cancellation preserves the reason only after the actual public runner joins', async () => {
    const h = await fixture();
    const entered = gate(),
      joined = gate();
    const controller = new AbortController();
    const reason = new Error('cancel read');
    h.command.mockImplementationOnce(async () => {
      entered.resolve();
      await joined.promise;
      return '{}';
    });
    const reading = h.reader.read(binding, controller.signal);
    const rejected = expect(reading).rejects.toBe(reason);
    let settled = false;
    void reading.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await entered.promise;
      controller.abort(reason);
      await setImmediate();
      expect(settled).toBe(false);
      joined.resolve();
      await rejected;
    } finally {
      joined.resolve();
      await reading.catch(() => {});
    }
  });
});
