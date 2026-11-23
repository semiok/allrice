/** Actual private file/HTTP/public bootstrap consumer; synthetic identity, permit and native runner only. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setImmediate as turn } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEgressGateway, EgressError } from '@allrice/egress-gateway';
import { MicrosandboxPersonVm } from '@allrice/person-vm';
import { createVmMemoryGuestPlan } from '@allrice/vm-memory/guest-plan';
import { admissionFixture } from '../../../../packages/egress-gateway/src/admission.fixture.ts';
import { context } from '../../../../packages/person-vm/src/test-support.ts';
import { productionInputsFixture } from './production-inputs.fixture.js';

const io = vi.hoisted<{ opened?: (file: FileHandle, flags: unknown) => void }>(
  () => ({}),
);
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const file = await actual.open(...args);
      io.opened?.(file, args[1]);
      return file;
    },
  };
});
import { createProductionEgressInstallation } from './production-egress.js';

let f: Awaited<ReturnType<typeof productionInputsFixture>>, mount: string;
let installation: ReturnType<typeof createProductionEgressInstallation>;
let lifetime: AbortController;
const cleanup: (() => Promise<unknown>)[] = [];
const organizationId = randomUUID(),
  rc = context(organizationId);
const binding = {
  vmId: randomUUID(),
  personId: rc.actor.id,
  organizationId,
  instanceId: randomUUID(),
  leaseEpoch: 1,
};
const access = {
  origin: 'http://127.0.0.1:34567',
  capability: 'synthetic-local-capability',
};
const signal = () => new AbortController().signal;
beforeEach(async () => {
  f = await productionInputsFixture();
  mount = join(f.root, 'mount');
  await fs.mkdir(mount, { mode: 0o700 });
  lifetime = new AbortController();
  installation = createProductionEgressInstallation(f.loaded, lifetime.signal);
});
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanup.splice(0).map((close) => close()),
  );
  const closed = await Promise.allSettled([installation.close()]);
  io.opened = undefined;
  vi.restoreAllMocks();
  await fs.rm(f.root, { recursive: true, force: true });
  const errors = [...results, ...closed].flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (errors.length) throw new AggregateError(errors, 'fixture cleanup');
});
async function storedFiles() {
  const directory = join(await fs.realpath(mount), '.allrice-egress');
  return (await fs.readdir(directory)).map((name) => join(directory, name));
}
async function installedFile() {
  const [path] = await storedFiles();
  if (!path) throw Error('missing actual staging file');
  return path;
}
function gateway(owner = installation) {
  const value = createEgressGateway({
    provisioner: owner.provisioner,
    admission: admissionFixture(),
    vm: { assertAdmissionBinding: async () => {} },
    authority: { context: async () => rc, allow: async () => {} },
    revokeModel: async () => {},
    policy: {
      routes: [
        {
          id: 'test',
          path: '/read',
          target: () => new URL('https://example.test/read'),
          origins: ['https://example.test'],
          maxResponseBytes: 128,
          timeoutMs: 1000,
          validate: () => {},
        },
      ],
    },
    transport: {
      read: async () => ({
        status: 200,
        contentType: 'application/json',
        body: Buffer.from('{"ok":true}'),
      }),
    },
  });
  return value;
}
async function prepare(
  value = gateway(),
  b = binding,
  ports: readonly number[] = [],
) {
  const receipt = await value.prepare(
    b,
    { mount, gatewayPorts: ports },
    signal(),
  );
  cleanup.push(() => value.revoke(receipt, 'stop', signal()));
  return { value, receipt };
}
async function readHttp() {
  const stored = JSON.parse(await fs.readFile(await installedFile(), 'utf8'));
  const response = await fetch(stored.access.origin + '/read', {
    headers: { authorization: `Bearer ${stored.access.capability}` },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
}

it('uses actual bind0 origin in receipt, real private readback and public memory plan', async () => {
  const { receipt } = await prepare();
  expect(receipt.gatewayPorts[0]).toBeGreaterThan(0);
  const path = await installedFile(),
    stored = JSON.parse(await fs.readFile(path, 'utf8'));
  expect(stored.binding).toEqual(binding);
  expect(stored.release).toEqual(f.loaded.applicationBuild);
  expect(new URL(stored.access.origin).port).toBe(
    String(receipt.gatewayPorts[0]),
  );
  expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  expect(
    (await fs.stat(join(await fs.realpath(mount), '.allrice-egress'))).mode &
      0o777,
  ).toBe(0o700);
  const plan = await installation.memoryGuestPlan(binding, signal());
  const original = await createVmMemoryGuestPlan(f.loaded.configuration.memory);
  expect(plan.files.slice(0, original.files.length)).toEqual(original.files);
  expect(plan.initialize).toEqual(original.initialize);
  expect(plan.launcher).toBe(original.launcher);
  for (const [key, value] of Object.entries(original.env))
    expect(plan.env[key]).toBe(value);
  const files = plan.files.slice(original.files.length);
  expect(files).toHaveLength(3);
  expect(files.every((file) => file.mode === 0o600)).toBe(true);
  expect(
    files.find((file) => file.path === plan.env.npm_config_userconfig)
      ?.contents,
  ).toContain(`registry=${stored.access.origin}/npm/`);
  expect(files.find((file) => file.path === plan.env.NETRC)?.contents).toBe(
    `machine 127.0.0.1 login egress password ${stored.access.capability}\n`,
  );
  expect(
    files.find((file) => file.path === plan.env.PIP_CONFIG_FILE)?.contents,
  ).toContain(`index-url=${stored.access.origin}/python/simple/`);
  await readHttp();
});

it('reopens exactly the persisted port and rejects wrong active inputs without revoking valid HTTP', async () => {
  const first = await prepare();
  await first.value.revoke(first.receipt, 'stop', signal());
  const nextBinding = { ...binding, leaseEpoch: 2 };
  const second = await prepare(
    gateway(),
    nextBinding,
    first.receipt.gatewayPorts,
  );
  expect(second.receipt.gatewayPorts).toEqual(first.receipt.gatewayPorts);
  expect(
    await second.value.prepare(
      nextBinding,
      { mount, gatewayPorts: [] },
      signal(),
    ),
  ).toBe(second.receipt);
  const port = second.receipt.gatewayPorts[0];
  if (!port) throw Error('missing actual port');
  await expect(
    second.value.prepare(
      nextBinding,
      { mount, gatewayPorts: [port === 65535 ? 65534 : port + 1] },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'POLICY_INVALID' });
  await expect(
    second.value.prepare(
      nextBinding,
      { mount: mount + '-wrong', gatewayPorts: second.receipt.gatewayPorts },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'POLICY_INVALID' });
  await expect(
    second.value.prepare(
      binding,
      { mount, gatewayPorts: second.receipt.gatewayPorts },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'STALE_BINDING' });
  await readHttp();
});

it('rejects an occupied persisted port without selecting another or disturbing its current owner', async () => {
  const first = await prepare();
  const other = createProductionEgressInstallation(f.loaded, signal());
  cleanup.push(() => other.close());
  await expect(
    gateway(other).prepare(
      { ...binding, leaseEpoch: 2 },
      { mount, gatewayPorts: first.receipt.gatewayPorts },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'EADDRINUSE' });
  await expect(
    other.memoryGuestPlan({ ...binding, leaseEpoch: 2 }, signal()),
  ).rejects.toBeInstanceOf(EgressError);
  expect(await storedFiles()).toHaveLength(1);
  await readHttp();
});

it.each([[0], [65536], [1.5], [12345, 12346]])(
  'rejects malformed persisted port lists %s',
  async (...ports) => {
    await expect(
      installation.provisioner.endpoint(binding.vmId, ports, signal()),
    ).rejects.toMatchObject({ code: 'POLICY_INVALID' });
  },
);

it('requires explicit egress configuration without deriving guest destination from web ingress', () => {
  expect(() =>
    createProductionEgressInstallation(
      {
        ...f.loaded,
        configuration: { ...f.loaded.configuration, egress: undefined },
      },
      signal(),
    ),
  ).toThrow(EgressError);
});

it('exact binding readback and late old remove do not authorize or delete the new epoch', async () => {
  await installation.provisioner.install(binding, mount, access, signal());
  const next = { ...binding, leaseEpoch: 2 };
  await installation.provisioner.install(next, mount, access, signal());
  for (const wrong of [
    { ...binding, personId: randomUUID() },
    { ...binding, organizationId: randomUUID() },
    { ...binding, instanceId: randomUUID() },
    { ...binding, leaseEpoch: 3 },
  ]) {
    await expect(
      installation.memoryGuestPlan(wrong, signal()),
    ).rejects.toBeInstanceOf(EgressError);
  }
  await installation.provisioner.remove(binding, signal());
  await installation.provisioner.remove(binding, signal());
  expect(await storedFiles()).toHaveLength(1);
  await expect(
    installation.memoryGuestPlan(next, signal()),
  ).resolves.toHaveProperty('env.NETRC');
  await expect(
    installation.memoryGuestPlan(binding, signal()),
  ).rejects.toBeInstanceOf(EgressError);
});

it.each(['mount', 'directory'])(
  'does not follow an existing %s symlink or delete its target',
  async (kind) => {
    const target = join(f.root, 'unknown');
    await fs.mkdir(target, { mode: 0o700 });
    const sentinel = join(target, 'sentinel');
    await fs.writeFile(sentinel, 'untouched');
    const path = kind === 'mount' ? mount : join(mount, '.allrice-egress');
    if (kind === 'mount') await fs.rmdir(mount);
    await fs.symlink(target, path);
    await expect(
      installation.provisioner.install(binding, mount, access, signal()),
    ).rejects.toBeDefined();
    expect(await fs.readFile(sentinel, 'utf8')).toBe('untouched');
    expect((await fs.lstat(path)).isSymbolicLink()).toBe(true);
  },
);

it('does not adopt or delete a pre-existing same-name file after an exclusive-create collision', async () => {
  await installation.provisioner.install(binding, mount, access, signal());
  const path = await installedFile();
  await installation.provisioner.remove(binding, signal());
  await fs.writeFile(path, 'unknown owner', { mode: 0o600 });
  await expect(
    installation.provisioner.install(binding, mount, access, signal()),
  ).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await fs.readFile(path, 'utf8')).toBe('unknown owner');
  await expect(
    installation.memoryGuestPlan(binding, signal()),
  ).rejects.toBeInstanceOf(EgressError);
  await installation.close();
  expect(await fs.readFile(path, 'utf8')).toBe('unknown owner');
});

it.each(['bytes', 'mode', 'replacement'])(
  'rejects changed staging %s before plan delivery and preserves unknown bytes',
  async (kind) => {
    await installation.provisioner.install(binding, mount, access, signal());
    const path = await installedFile(),
      bytes = await fs.readFile(path),
      saved = path + '.saved';
    if (kind === 'bytes')
      await fs.writeFile(path, Buffer.alloc(bytes.length, 32));
    if (kind === 'mode') await fs.chmod(path, 0o644);
    if (kind === 'replacement') {
      await fs.rename(path, saved);
      await fs.writeFile(path, bytes, { mode: 0o600 });
    }
    try {
      await expect(
        installation.memoryGuestPlan(binding, signal()),
      ).rejects.toBeInstanceOf(EgressError);
      if (kind === 'replacement')
        expect(await fs.readFile(path)).toEqual(bytes);
    } finally {
      if (kind === 'replacement') {
        await fs.unlink(path);
        await fs.rename(saved, path);
      } else {
        await fs.writeFile(path, bytes);
        await fs.chmod(path, 0o600);
      }
    }
  },
);

function hold(point: 'writeFile' | 'readFile' | 'close', closeError?: Error) {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((done) => {
    enter = done;
  });
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let closed = false;
  io.opened = (file) => {
    io.opened = undefined;
    const close = file.close.bind(file);
    vi.spyOn(file, 'close').mockImplementation(async () => {
      if (point === 'close') {
        enter();
        await gate;
      }
      await close();
      closed = true;
      if (closeError) throw closeError;
    });
    if (point === 'writeFile') {
      const write = file.writeFile.bind(file);
      vi.spyOn(file, 'writeFile').mockImplementation(async (data, options) => {
        enter();
        await gate;
        return write(data, options);
      });
    }
    if (point === 'readFile') {
      const read = file.readFile.bind(file);
      vi.spyOn(file, 'readFile').mockImplementation(async () => {
        enter();
        await gate;
        return read();
      });
    }
  };
  return { entered, release, closed: () => closed };
}
it.each([
  ['install', 'writeFile'],
  ['install', 'close'],
  ['plan', 'readFile'],
  ['plan', 'close'],
] as const)(
  'joins real %s %s before returning original caller cancellation',
  async (operation, point) => {
    if (operation === 'plan')
      await installation.provisioner.install(binding, mount, access, signal());
    const held = hold(point),
      abort = new AbortController(),
      reason = Error('caller cancelled real file IO');
    let settled = false;
    const work =
      operation === 'install'
        ? installation.provisioner.install(binding, mount, access, abort.signal)
        : installation.memoryGuestPlan(binding, abort.signal);
    const outcome = work.then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await held.entered;
      abort.abort(reason);
      await turn();
      expect(settled).toBe(false);
      expect(held.closed()).toBe(false);
    } finally {
      held.release();
      await outcome;
    }
    expect(await outcome).toBe(reason);
    expect(held.closed()).toBe(true);
    if (operation === 'install') expect(await storedFiles()).toEqual([]);
    else
      await expect(
        installation.memoryGuestPlan(binding, signal()),
      ).resolves.toHaveProperty('launcher');
  },
);

it('close fences new operations and truly joins an install write before unlinking its file', async () => {
  const held = hold('writeFile');
  let settled = false,
    closeSettled = false;
  const outcome = installation.provisioner
    .install(binding, mount, access, signal())
    .then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
  let closing: Promise<void> | undefined;
  try {
    await held.entered;
    closing = installation.close().finally(() => {
      closeSettled = true;
    });
    await turn();
    expect(settled).toBe(false);
    expect(closeSettled).toBe(false);
    expect(held.closed()).toBe(false);
    await expect(
      installation.provisioner.endpoint(binding.vmId, [], signal()),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  } finally {
    held.release();
    await outcome;
    await closing;
  }
  expect(await outcome).toBeInstanceOf(EgressError);
  expect(held.closed()).toBe(true);
  expect(await storedFiles()).toEqual([]);
});

it('lifetime abort during actual plan file.close withholds the result until real close finishes', async () => {
  await installation.provisioner.install(binding, mount, access, signal());
  const held = hold('close'),
    reason = Error('Host lifetime ended');
  let settled = false;
  const outcome = installation.memoryGuestPlan(binding, signal()).then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await held.entered;
    lifetime.abort(reason);
    await turn();
    expect(settled).toBe(false);
    expect(held.closed()).toBe(false);
  } finally {
    held.release();
    await outcome;
  }
  expect(await outcome).toBe(reason);
  expect(held.closed()).toBe(true);
});

it('remove cancels and joins the exact in-progress read before unlinking, without affecting the new epoch', async () => {
  await installation.provisioner.install(binding, mount, access, signal());
  const next = { ...binding, leaseEpoch: 2 };
  await installation.provisioner.install(next, mount, access, signal());
  const held = hold('readFile');
  const outcome = installation
    .memoryGuestPlan(binding, signal())
    .catch((error: unknown) => error);
  let removing: Promise<void> | undefined,
    removed = false;
  try {
    await held.entered;
    removing = installation.provisioner
      .remove(binding, signal())
      .finally(() => {
        removed = true;
      });
    await turn();
    expect(removed).toBe(false);
    expect(await storedFiles()).toHaveLength(2);
  } finally {
    held.release();
    await outcome;
    await removing;
  }
  expect(await outcome).toBeInstanceOf(EgressError);
  expect(await storedFiles()).toHaveLength(1);
  await expect(
    installation.memoryGuestPlan(next, signal()),
  ).resolves.toHaveProperty('env.NETRC');
});

it.each([
  ['install', 'caller', false],
  ['plan', 'caller', false],
  ['install', 'lifetime', false],
  ['plan', 'lifetime', false],
  ['install', 'caller', true],
  ['plan', 'caller', true],
] as const)(
  'retains %s %s cancellation and close failure with prior work error=%s only after actual close joins',
  async (operation, cancellation, failWork) => {
    if (operation === 'plan')
      await installation.provisioner.install(binding, mount, access, signal());
    const reason = Error('cancel while actual close is held'),
      closeError = Error('failure after actual close'),
      workError = Error('failure after actual work');
    const held = hold('close', closeError),
      opened = io.opened;
    io.opened = (file, flags) => {
      opened?.(file, flags);
      if (!failWork) return;
      if (operation === 'install') {
        const write = file.writeFile.bind(file);
        vi.spyOn(file, 'writeFile').mockImplementation(
          async (data, options) => {
            await write(data, options);
            throw workError;
          },
        );
      } else {
        const read = file.readFile.bind(file);
        vi.spyOn(file, 'readFile').mockImplementation(async () => {
          await read();
          throw workError;
        });
      }
    };
    const caller = new AbortController();
    let settled = false;
    const work =
      operation === 'install'
        ? installation.provisioner.install(
            binding,
            mount,
            access,
            caller.signal,
          )
        : installation.memoryGuestPlan(binding, caller.signal);
    const outcome = work.then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await held.entered;
      (cancellation === 'caller' ? caller : lifetime).abort(reason);
      await turn();
      expect(settled).toBe(false);
      expect(held.closed()).toBe(false);
    } finally {
      held.release();
      await outcome;
    }
    expect(held.closed()).toBe(true);
    const failure = await outcome;
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw failure;
    const errors = [...(failWork ? [workError] : []), reason, closeError];
    expect(failure.errors).toHaveLength(errors.length);
    for (const [index, error] of errors.entries())
      expect(failure.errors[index]).toBe(error);
    if (operation === 'install') expect(await storedFiles()).toEqual([]);
    else if (cancellation === 'caller')
      await expect(
        installation.memoryGuestPlan(binding, signal()),
      ).resolves.toHaveProperty('launcher');
  },
);

it('retains a write failure and actual close failure together while cleaning only its own file', async () => {
  const primary = Error('synthetic write completion failure'),
    cleanupError = Error('synthetic close completion failure');
  let actuallyClosed = false;
  io.opened = (file) => {
    io.opened = undefined;
    const write = file.writeFile.bind(file),
      close = file.close.bind(file);
    vi.spyOn(file, 'writeFile').mockImplementation(async (data, options) => {
      await write(data, options);
      throw primary;
    });
    vi.spyOn(file, 'close').mockImplementation(async () => {
      await close();
      actuallyClosed = true;
      throw cleanupError;
    });
  };
  const outcome = installation.provisioner.install(
    binding,
    mount,
    access,
    signal(),
  );
  await expect(outcome).rejects.toBeInstanceOf(AggregateError);
  await expect(outcome).rejects.toMatchObject({
    errors: [primary, cleanupError],
  });
  expect(actuallyClosed).toBe(true);
  expect(await storedFiles()).toEqual([]);
});

it.each(['failure', 'cancel'] as const)(
  'actual gateway joins listener close after real install %s',
  async (kind) => {
    const install = vi.spyOn(installation.provisioner, 'install');
    const value = gateway(),
      abort = new AbortController(),
      reason = Error('cancel gateway install');
    const held = kind === 'cancel' ? hold('writeFile') : undefined;
    let settled = false;
    const outcome = value
      .prepare(
        binding,
        {
          mount: kind === 'failure' ? mount + '-missing' : mount,
          gatewayPorts: [],
        },
        abort.signal,
      )
      .then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
    try {
      if (held) {
        await held.entered;
        abort.abort(reason);
        await turn();
        expect(settled).toBe(false);
        expect(held.closed()).toBe(false);
      }
    } finally {
      held?.release();
      await outcome;
    }
    if (kind === 'cancel') expect(await outcome).toBe(reason);
    else expect(await outcome).toMatchObject({ code: 'ENOENT' });
    const origin = install.mock.calls[0]?.[2].origin;
    if (!origin) throw Error('actual gateway did not install');
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(Number(new URL(origin).port), '127.0.0.1', resolve);
      });
      expect(server.listening).toBe(true);
    } finally {
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    }
  },
);

it('the actual native bootstrap copies the readback plan files and launches with its protected env', async () => {
  await installation.provisioner.install(binding, mount, access, signal());
  const plan = await installation.memoryGuestPlan(binding, signal());
  const copied: { target: string; contents: string; mode: number }[] = [];
  const commands: string[][] = [];
  const native = new MicrosandboxPersonVm({
    binary: f.loaded.configuration.native.binary,
    libkrunfw: f.loaded.configuration.native.libkrunfw,
    agentd: f.loaded.configuration.native.agentd,
    image: f.loaded.configuration.native.image,
    rootDiskGiB: 8,
    socketRoot: f.loaded.configuration.native.socketRoot,
    memoryMiB: f.loaded.platform.memoryMiB,
    runner: async (command) => {
      const args = [...command.args];
      commands.push(args);
      if (args[0] === '--version') return 'microsandbox 0.7.16';
      if (args[0] === 'cp') {
        const source = args[1],
          target = args[2];
        if (!source || !target)
          throw Error('missing actual cp source or target');
        copied.push({
          target,
          contents: await fs.readFile(source, 'utf8'),
          mode: (await fs.stat(source)).mode & 0o777,
        });
        return '';
      }
      if (args[0] === 'exec') return randomUUID();
      if (args[0] === 'wait')
        return JSON.stringify({ code: 0, success: true, timed_out: false });
      throw Error('unexpected synthetic native command');
    },
  });
  await native.prepare(binding, mount, signal());
  const current = vi.fn(async () => {});
  const prepared = await native.bootstrap(
    { binding, signal: signal(), assertCurrent: current },
    plan,
  );
  expect(copied).toHaveLength(plan.files.length);
  for (const file of plan.files)
    expect(
      copied.find((copy) => copy.target.endsWith(':' + file.path)),
    ).toMatchObject({ contents: file.contents, mode: file.mode });
  const job = await prepared.launch({
    executable: 'node',
    args: ['synthetic-dsh'],
    env: { DSH_HOME: '/work/profile' },
  });
  expect(await job.wait(signal())).toEqual({ exitCode: 0, timedOut: false });
  const launch = commands.find((args) => args.includes('synthetic-dsh'));
  expect(launch).toBeDefined();
  if (!launch) throw Error('missing actual bootstrap launch');
  for (const [key, value] of Object.entries(plan.env))
    expect(launch).toContain(`${key}=${value}`);
  expect(launch.slice(launch.indexOf('--') + 1)).toEqual([
    plan.launcher,
    'node',
    'synthetic-dsh',
  ]);
  expect(current).toHaveBeenCalled();
});
