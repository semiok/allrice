import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeInstanceLock } from './instance-lock.js';
import {
  monitorBridgeUpdate,
  type UpdateMonitorInput,
  type UpdateOwnedChild,
} from './update-monitor.js';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  BridgeUpdateInstaller,
  inspectUpdateZip,
  verifyAppleUpdateBundle,
  type UpdateInstallPorts,
} from './update-installer.js';
import {
  updateMetadataSigningBytes,
  updatePackageSigningBytes,
  verifyUpdateMetadata,
  type UpdateEnvironment,
  type UpdateRelease,
  type UpdateTrust,
} from './trusted-update.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const pair = generateKeyPairSync('ed25519');
const trust: UpdateTrust = {
  teamId: 'SYNTHETIC1',
  channel: 'dev',
  origin: 'https://updates.example.test',
  keys: {
    synthetic: pair.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString(),
  },
};
const environment: UpdateEnvironment = {
  version: '0.5.0-dev.1',
  sequence: 1,
  arch: 'x64',
  macOS: '15.7.0',
  protocol: 1,
  credentials: 2,
  journal: 1,
  now: Date.parse('2026-09-14T00:00:00.000Z'),
};
const entries = [
  'Rice Bridge.app/Contents/Info.plist',
  'Rice Bridge.app/Contents/Resources/RiceBridgeCore',
];
// Minimal stored ZIP structure, not a real signed App. Extractor seam writes
// synthetic app bytes; signature verification is cryptographically real.
function zip(names = entries, symbolic = false, localName?: string) {
  const locals: Buffer[] = [],
    centrals: Buffer[] = [];
  let position = 0;
  for (const name of names) {
    const path = Buffer.from(name),
      localPath = Buffer.from(localName ?? name),
      data = Buffer.from('synthetic');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(localPath.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(path.length, 28);
    central.writeUInt32LE((symbolic ? 0xa000 : 0x8000) * 65536, 38);
    central.writeUInt32LE(position, 42);
    const block = Buffer.concat([local, localPath, data]);
    locals.push(block);
    centrals.push(Buffer.concat([central, path]));
    position += block.length;
  }
  const central = Buffer.concat(centrals),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(position, 16);
  return Buffer.concat([...locals, central, end]);
}
function metadata(archive: Buffer, sequence = 2) {
  const release: UpdateRelease = {
    v: 1,
    sequence,
    version: `0.${sequence + 4}.0-dev.1`,
    channel: 'dev',
    issuedAt: new Date(environment.now - 1000).toISOString(),
    expiresAt: new Date(environment.now + 86400000).toISOString(),
    bundleId: 'xyz.bplabs.rice-bridge',
    teamId: trust.teamId,
    minimumMacOS: '13.0.0',
    protocol: { min: 1, max: 1 },
    credentials: { min: 2, max: 2 },
    journal: { min: 1, max: 1 },
    writes: { credentials: 2, journal: 1 },
    packages: [],
  };
  release.packages = (['x64', 'arm64'] as const).map((arch) => {
    const p = {
      arch,
      url: `${trust.origin}/${sequence}-${arch}.zip`,
      bytes: archive.length,
      sha256: createHash('sha256').update(archive).digest('hex'),
      signature: '',
    };
    p.signature = sign(
      null,
      updatePackageSigningBytes(release, p),
      pair.privateKey,
    ).toString('base64');
    return p;
  });
  const payload = Buffer.from(JSON.stringify(release));
  return Buffer.from(
    JSON.stringify({
      keyId: 'synthetic',
      payload: payload.toString('base64'),
      signature: sign(
        null,
        updateMetadataSigningBytes(payload),
        pair.privateKey,
      ).toString('base64'),
    }),
  );
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'allrice-p14-')));
  roots.push(root);
  const managed = join(root, 'managed');
  await mkdir(managed, { mode: 0o700 });
  const credentials = join(root, 'synthetic-credentials.json');
  await writeFile(credentials, 'keep-device-and-source-record-unchanged', {
    mode: 0o600,
  });
  let next = 'new-app';
  const ports: UpdateInstallPorts = {
    assertQuiescent: vi.fn(async () => undefined),
    verifyBundle: vi.fn(async () => undefined),
    extract: vi.fn(async (_archive, destination) => {
      const resources = join(destination, 'Rice Bridge.app/Contents/Resources');
      await mkdir(resources, { recursive: true, mode: 0o700 });
      await writeFile(join(resources, 'RiceBridgeCore'), next, { mode: 0o700 });
      await writeFile(join(destination, entries[0]!), '<synthetic/>', {
        mode: 0o600,
      });
    }),
  };
  const installer = new BridgeUpdateInstaller(managed, trust, ports);
  return {
    root,
    managed,
    credentials,
    ports,
    installer,
    setNext: (value: string) => {
      next = value;
    },
    core: join(managed, entries[1]!),
  };
}
async function healthy(f: Awaited<ReturnType<typeof fixture>>) {
  await f.installer.install(metadata(zip()), zip(), environment);
  const state = (await f.installer.state())!;
  await f.installer.reportReady(state.version, state.id);
  await f.installer.confirmHealthy(state.version, state.id);
}

it('validates a bounded canonical synthetic archive', () =>
  expect(() => inspectUpdateZip(zip())).not.toThrow());
it.each([
  '../escape',
  '/tmp/escape',
  'Rice Bridge.app/../../escape',
  'Rice Bridge.app/Contents/../escape',
  'Rice Bridge.app//escape',
  'Rice Bridge.app/Contents\\escape',
])('rejects traversal/noncanonical entry %s before extraction', (name) => {
  expect(() => inspectUpdateZip(zip([...entries, name]))).toThrow(
    'UPDATE_ARCHIVE_PATH_INVALID',
  );
});
it('rejects symlinks, central/local name confusion, duplicate entries and truncation', () => {
  expect(() => inspectUpdateZip(zip(entries, true))).toThrow(
    'UPDATE_ARCHIVE_INVALID',
  );
  expect(() => inspectUpdateZip(zip(entries, false, '../escape'))).toThrow(
    'UPDATE_ARCHIVE_PATH_INVALID',
  );
  expect(() => inspectUpdateZip(zip([...entries, entries[0]!]))).toThrow(
    'UPDATE_ARCHIVE_PATH_INVALID',
  );
  expect(() =>
    inspectUpdateZip(zip([...entries, 'Rice Bridge.app/Contents/info.plist'])),
  ).toThrow('UPDATE_ARCHIVE_PATH_INVALID');
  expect(() => inspectUpdateZip(zip([...entries, `${entries[0]!}/`]))).toThrow(
    'UPDATE_ARCHIVE_PATH_INVALID',
  );
  expect(() => inspectUpdateZip(zip().subarray(0, 80))).toThrow(
    'UPDATE_ARCHIVE_INVALID',
  );
});
it('installs into a new private managed directory and requires exact health ACK', async () => {
  const f = await fixture();
  expect(
    await f.installer.install(metadata(zip()), zip(), environment),
  ).toEqual({ version: '0.6.0-dev.1', phase: 'pending-health' });
  expect(await readFile(f.core, 'utf8')).toBe('new-app');
  await expect(
    f.installer.confirmHealthy('0.6.0-dev.1', 'wrong'),
  ).rejects.toThrow('UPDATE_HEALTH_MISMATCH');
  expect((await f.installer.state())?.phase).toBe('pending-health');
  const state = (await f.installer.state())!;
  await f.installer.reportReady(state.version, state.id);
  await f.installer.confirmHealthy(state.version, state.id);
  expect((await f.installer.state())?.phase).toBe('healthy');
  expect(f.ports.assertQuiescent).toHaveBeenCalledTimes(2);
  expect(await readFile(f.credentials, 'utf8')).toBe(
    'keep-device-and-source-record-unchanged',
  );
});
it('restores old actual directory bytes after failed health without touching credentials', async () => {
  const f = await fixture();
  await healthy(f);
  f.setNext('bad-startup-app');
  await f.installer.install(metadata(zip(), 3), zip(), environment);
  expect(await readFile(f.core, 'utf8')).toBe('bad-startup-app');
  expect((await f.installer.recover())?.phase).toBe('rolled-back');
  expect(await readFile(f.core, 'utf8')).toBe('new-app');
  expect((await f.installer.recover())?.phase).toBe('rolled-back');
  expect(await readFile(f.credentials, 'utf8')).toBe(
    'keep-device-and-source-record-unchanged',
  );
  await expect(
    f.installer.install(metadata(zip(), 3), zip(), environment),
  ).rejects.toThrow('UPDATE_DOWNGRADE_BLOCKED');
});
it('retains a failed first installation for diagnosis and requires a newer release', async () => {
  const f = await fixture();
  await f.installer.install(metadata(zip()), zip(), environment);
  const state = (await f.installer.state())!;
  await f.installer.recover();
  await expect(readFile(f.core)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(
    await readFile(
      join(
        f.managed,
        `failed-${state.id}.app/Contents/Resources/RiceBridgeCore`,
      ),
      'utf8',
    ),
  ).toBe('new-app');
});
it.each([
  'prepared-before-rename',
  'prepared-after-backup',
  'prepared-after-replacement',
  'recovering-after-restore',
])('recovers synthetic interruption boundary %s', async (phase) => {
  const f = await fixture();
  await healthy(f);
  f.setNext('candidate');
  await f.installer.install(metadata(zip(), 3), zip(), environment);
  const state = (await f.installer.state())!,
    app = join(f.managed, 'Rice Bridge.app'),
    backup = join(f.managed, `rollback-${state.id}.app`),
    candidate = join(f.managed, `stage-${state.id}/Rice Bridge.app`);
  if (phase === 'prepared-before-rename' || phase === 'prepared-after-backup') {
    await rename(app, candidate);
    if (phase === 'prepared-before-rename') await rename(backup, app);
  }
  if (phase === 'recovering-after-restore') {
    await rename(app, join(f.managed, `failed-${state.id}.app`));
    await rename(backup, app);
  }
  await writeFile(
    join(f.managed, 'update-state.json'),
    JSON.stringify({
      ...state,
      phase: phase === 'recovering-after-restore' ? 'recovering' : 'prepared',
    }),
    { mode: 0o600 },
  );
  expect((await f.installer.recover())?.phase).toBe('rolled-back');
  expect(await readFile(f.core, 'utf8')).toBe('new-app');
});
it('rejects invalid archive/hash, undrained work or Apple failure before replacing an app', async () => {
  const f = await fixture();
  await healthy(f);
  await expect(
    f.installer.install(
      metadata(zip(), 3),
      Buffer.alloc(zip().length),
      environment,
    ),
  ).rejects.toThrow('UPDATE_PACKAGE_INTEGRITY');
  vi.mocked(f.ports.assertQuiescent).mockRejectedValueOnce(
    Error('UPDATE_DRAIN_UNCONFIRMED'),
  );
  await expect(
    f.installer.install(metadata(zip(), 3), zip(), environment),
  ).rejects.toThrow('UPDATE_DRAIN_UNCONFIRMED');
  vi.mocked(f.ports.verifyBundle).mockRejectedValueOnce(
    Error('UPDATE_APPLE_VERIFICATION_FAILED'),
  );
  await expect(
    f.installer.install(metadata(zip(), 3), zip(), environment),
  ).rejects.toThrow('UPDATE_APPLE_VERIFICATION_FAILED');
  expect(await readFile(f.core, 'utf8')).toBe('new-app');
});
it('rejects unmanaged Apps and symlink destinations without modifying them', async () => {
  const f = await fixture();
  await mkdir(join(f.managed, 'Rice Bridge.app'));
  await expect(
    f.installer.install(metadata(zip()), zip(), environment),
  ).rejects.toThrow('UPDATE_UNMANAGED_INSTALL');
  const alias = join(f.root, 'alias');
  await symlink(f.managed, alias);
  await expect(
    new BridgeUpdateInstaller(alias, trust, f.ports).install(
      metadata(zip()),
      zip(),
      environment,
    ),
  ).rejects.toThrow('UPDATE_INSTALL_PATH_UNSAFE');
});
it('serializes two installer instances using the OS lock, not only in-memory flags', async () => {
  const f = await fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.mocked(f.ports.assertQuiescent).mockImplementationOnce(async () => {
    entered();
    await blocked;
  });
  const running = f.installer.install(metadata(zip()), zip(), environment);
  await ready;
  try {
    await expect(
      new BridgeUpdateInstaller(f.managed, trust, f.ports).install(
        metadata(zip()),
        zip(),
        environment,
      ),
    ).rejects.toThrow('BRIDGE_ALREADY_RUNNING');
  } finally {
    release();
    await running;
  }
});
it.runIf(process.platform === 'darwin')(
  'uses real Apple verification to reject unsigned synthetic App before executing it',
  async () => {
    const f = await fixture();
    await f.ports.extract('', f.managed);
    const update = verifyUpdateMetadata(metadata(zip()), trust, environment);
    await expect(
      verifyAppleUpdateBundle(join(f.managed, 'Rice Bridge.app'), update),
    ).rejects.toThrow('UPDATE_APPLE_VERIFICATION_FAILED');
  },
);

async function monitoredFixture() {
  const f = await fixture();
  await healthy(f);
  f.setNext('candidate');
  let engine = f.installer;
  const fake: UpdateOwnedChild = {
    exitCode: null,
    signalCode: null,
    unref: vi.fn(),
    kill: vi.fn((signal) => {
      fake.signalCode = signal;
      return true;
    }),
  };
  const input: UpdateMonitorInput = {
    createInstaller: (quiescent) =>
      (engine = new BridgeUpdateInstaller(f.managed, trust, {
        ...f.ports,
        assertQuiescent: quiescent,
      })),
    acquireOwner: () =>
      BridgeInstanceLock.acquire(join(f.root, 'synthetic-owner-config')),
    launch: vi.fn(async (_app, id) => {
      if (id) await engine.reportReady('0.7.0-dev.1', id);
      return fake;
    }),
    verifyRollback: vi.fn(async () => undefined),
    app: join(f.managed, 'Rice Bridge.app'),
    sourceApp: join(f.managed, 'Rice Bridge.app'),
    sourceVersion: '0.6.0-dev.1',
    update: verifyUpdateMetadata(metadata(zip(), 3), trust, environment),
    metadata: metadata(zip(), 3),
    archive: zip(),
    environment,
    recovery: false,
    healthAttempts: 2,
    stopAttempts: 2,
    sleep: async () => undefined,
  };
  return { ...f, input, fake, engine: () => engine };
}
it('monitor releases the old owner, observes exact readiness, commits health and does not stop a healthy candidate', async () => {
  const f = await monitoredFixture();
  expect(await monitorBridgeUpdate(f.input)).toEqual({
    status: 'healthy',
    failureCode: null,
  });
  expect((await f.engine().state())?.phase).toBe('healthy');
  expect(f.fake.kill).not.toHaveBeenCalled();
  expect(f.input.verifyRollback).not.toHaveBeenCalled();
  expect(await readFile(f.credentials, 'utf8')).toBe(
    'keep-device-and-source-record-unchanged',
  );
});
it('missing or misleading parent process hints cannot bypass a still-held config owner', async () => {
  const f = await monitoredFixture();
  const owner = await BridgeInstanceLock.acquire(
    join(f.root, 'synthetic-owner-config'),
  );
  try {
    // Even after the native adapter thinks both old PIDs are absent, the
    // monitor requires the actual OS-backed owner. No installer/launch runs.
    await expect(monitorBridgeUpdate(f.input)).rejects.toThrow(
      'BRIDGE_ALREADY_RUNNING',
    );
    expect(await readFile(f.core, 'utf8')).toBe('new-app');
    expect(f.input.launch).not.toHaveBeenCalled();
  } finally {
    owner.close();
  }
});
it('monitor uses real child initialization/credential read and no acquisition until persisted commit', async () => {
  const f = await monitoredFixture();
  const marker = join(f.root, 'acquired-after-commit');
  const installModule = fileURLToPath(
    new URL('./update-installer.ts', import.meta.url),
  );
  const lockModule = fileURLToPath(
    new URL('./instance-lock.ts', import.meta.url),
  );
  const children: ReturnType<typeof spawn>[] = [];
  const script = `
    const data = JSON.parse(process.argv[1]);
    const { BridgeUpdateInstaller } = await import(data.installModule);
    const { BridgeInstanceLock } = await import(data.lockModule);
    const { readFile, writeFile } = await import('node:fs/promises');
    const { setTimeout } = await import('node:timers/promises');
    const owner = await BridgeInstanceLock.acquire(data.owner);
    try {
      const bytes = await readFile(data.credentials, 'utf8');
      if (bytes !== 'keep-device-and-source-record-unchanged') process.exit(3);
      const engine = new BridgeUpdateInstaller(data.root, data.trust, { assertQuiescent: async () => {}, extract: async () => {}, verifyBundle: async () => {} });
      await engine.reportReady('0.7.0-dev.1', data.id);
      for (let n = 0; n < 200; n++) {
        if ((await engine.state()).phase === 'healthy') { await writeFile(data.marker, 'work-after-health', { mode: 0o600 }); break; }
        await setTimeout(25);
      }
    } finally { owner.close(); }
  `;
  f.input.launch = async (_app, id) => {
    expect(id).toBeTruthy();
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        script,
        JSON.stringify({
          installModule,
          lockModule,
          owner: join(f.root, 'synthetic-owner-config'),
          credentials: f.credentials,
          root: f.managed,
          trust,
          id,
          marker,
        }),
      ],
      { stdio: 'ignore' },
    );
    children.push(child);
    return child;
  };
  f.input.healthAttempts = 200;
  f.input.sleep = (ms) => delay(Math.min(ms, 25));
  try {
    expect((await monitorBridgeUpdate(f.input)).status).toBe('healthy');
    for (
      let n = 0;
      n < 100 &&
      !(await readFile(marker, 'utf8').then(
        (contents) => contents === 'work-after-health',
        () => false,
      ));
      n++
    )
      await delay(25);
    expect(await readFile(marker, 'utf8')).toBe('work-after-health');
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM');
    }
    for (
      let n = 0;
      n < 100 &&
      children.some(
        (child) => child.exitCode === null && child.signalCode === null,
      );
      n++
    )
      await delay(25);
  }
}, 15000);
it('failed candidate launch reacquires owner, restores actual previous bytes and relaunches verified rollback', async () => {
  const f = await monitoredFixture();
  f.input.launch = vi.fn(async (_app, id) => {
    if (id) throw Error('UPDATE_LAUNCH_FAILED');
    return f.fake;
  });
  expect(await monitorBridgeUpdate(f.input)).toEqual({
    status: 'rolled-back',
    failureCode: 'UPDATE_LAUNCH_FAILED',
  });
  expect(await readFile(f.core, 'utf8')).toBe('new-app');
  expect(f.input.verifyRollback).toHaveBeenCalledOnce();
  expect(f.input.launch).toHaveBeenCalledTimes(2);
});
it('health timeout stops only the owned candidate and preserves original credential files on rollback', async () => {
  const f = await monitoredFixture();
  f.input.launch = vi.fn(async () => f.fake);
  expect(await monitorBridgeUpdate(f.input)).toEqual({
    status: 'rolled-back',
    failureCode: 'UPDATE_HEALTH_TIMEOUT',
  });
  expect(f.fake.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  expect(await readFile(f.core, 'utf8')).toBe('new-app');
  expect(await readFile(f.credentials, 'utf8')).toBe(
    'keep-device-and-source-record-unchanged',
  );
});
it('unconfirmed child stop does not restore underneath a potentially running candidate', async () => {
  const f = await monitoredFixture();
  f.input.launch = async () => f.fake;
  f.fake.kill = vi.fn(() => false);
  await expect(monitorBridgeUpdate(f.input)).rejects.toThrow(
    'UPDATE_STOP_UNCONFIRMED',
  );
  expect((await f.engine().state())?.phase).toBe('pending-health');
  expect(await readFile(f.core, 'utf8')).toBe('candidate');
  expect(f.input.verifyRollback).not.toHaveBeenCalled();
});
it('a lost final health commit ACK never kills or rolls back a possibly active committed Core', async () => {
  const f = await monitoredFixture();
  const create = f.input.createInstaller;
  f.input.createInstaller = (quiescent) => {
    const engine = create(quiescent),
      confirm = engine.confirmHealthy.bind(engine);
    engine.confirmHealthy = async (version, id) => {
      await confirm(version, id);
      throw Error('synthetic-after-save-failure');
    };
    return engine;
  };
  await expect(monitorBridgeUpdate(f.input)).rejects.toThrow(
    'UPDATE_HEALTH_UNCONFIRMED',
  );
  expect((await f.engine().state())?.phase).toBe('healthy');
  expect(f.fake.kill).not.toHaveBeenCalled();
});
it.runIf(process.platform === 'darwin')(
  'accepts a real system ditto ZIP with resource forks excluded',
  async () => {
    const f = await fixture();
    await f.ports.extract('', f.managed);
    const archive = join(f.root, 'real-ditto.zip');
    await promisify(execFile)('/usr/bin/ditto', [
      '-c',
      '-k',
      '--keepParent',
      '--norsrc',
      join(f.managed, 'Rice Bridge.app'),
      archive,
    ]);
    const bytes = await readFile(archive);
    inspectUpdateZip(bytes);
  },
);
