import { execFile, spawn } from 'node:child_process';
import { BridgeProtocolVersion } from '@allrice/contracts';
import { monitorBridgeUpdate } from './update-monitor.js';
import { desktopSafeError } from './desktop-protocol.js';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { BridgeInstanceLock } from './instance-lock.js';
import { readConfig } from './config.js';
import { journalDirectory } from './core.js';
import { localBrowserOptIn } from './local-browser-settings.js';
import { localPreviewOptIn } from './local-preview-settings.js';
import { assertUpdateJournalQuiescent } from './update-quiescence.js';
import { bridgeVersion } from './version.js';
import {
  bridgeUpdateTrust,
  downloadUpdate,
  verifyUpdateMetadata,
  verifyUpdatePackage,
  type UpdateEnvironment,
  type VerifiedUpdate,
} from './trusted-update.js';
import {
  BridgeUpdateInstaller,
  nativeUpdateInstallPorts,
  verifyAppleUpdateBundle,
} from './update-installer.js';

const execute = promisify(execFile);
const idPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const managedBridgeDirectory = () =>
  join(homedir(), 'Applications', 'AllRice Bridge');
const managedApp = () => join(managedBridgeDirectory(), 'Rice Bridge.app');
const healthId = () => process.env.ALLRICE_BRIDGE_UPDATE_HEALTH_ID;
function fail(code: string): never {
  throw Error(code);
}
function trust() {
  return bridgeUpdateTrust ?? fail('UPDATE_TRUST_UNCONFIGURED');
}
const installer = (quiescent: () => Promise<void> = async () => undefined) =>
  new BridgeUpdateInstaller(
    managedBridgeDirectory(),
    trust(),
    nativeUpdateInstallPorts(async () => {
      await quiescent();
      const config = await readConfig().catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        },
      );
      if (!config) return;
      if (
        (await localBrowserOptIn(config)) ||
        (await localPreviewOptIn(config))
      )
        fail('UPDATE_DRAIN_BROWSER_ACTIVE');
      await assertUpdateJournalQuiescent({
        directory: journalDirectory(config),
        server: config.server,
        deviceId: config.deviceId,
      });
    }),
  );
function nativeEnvironment() {
  return Object.fromEntries(
    ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG']
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]!])
      .concat([['PATH', '/usr/bin:/bin:/usr/sbin:/sbin']]),
  );
}
async function nativeApp() {
  if (
    process.platform !== 'darwin' ||
    process.env.ALLRICE_BRIDGE_CONFIG_PATH ||
    process.env.ALLRICE_BRIDGE_DEVICE_TOKEN ||
    !process.execPath.endsWith('/Contents/Resources/RiceBridgeCore')
  )
    fail('UPDATE_NATIVE_APP_REQUIRED');
  return realpath(dirname(dirname(dirname(process.execPath))));
}
async function privateRoot(create = false) {
  const root = managedBridgeDirectory();
  if (create) {
    await mkdir(dirname(root), { mode: 0o700, recursive: true });
    await mkdir(root, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
  }
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700 ||
    (await realpath(root)) !== root
  )
    fail('UPDATE_INSTALL_PATH_UNSAFE');
  return root;
}
async function privateRead(path: string, maximum: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > maximum
    )
      fail('UPDATE_STATE_UNSAFE');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
async function privateWrite(path: string, bytes: Uint8Array) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function environment(): Promise<UpdateEnvironment> {
  const { stdout } = await execute('/usr/bin/sw_vers', ['-productVersion'], {
    timeout: 5000,
    maxBuffer: 128,
  });
  const macOS = stdout.trim().split('.');
  if (macOS.length === 2) macOS.push('0');
  if (process.arch !== 'x64' && process.arch !== 'arm64')
    fail('UPDATE_ARCHITECTURE_INVALID');
  const current = await installer()
    .state()
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  // Compatibility generations, not config.json fields: generation 2 preserves
  // B4 authoritative credential-source records; journal is SQLite user_version.
  return {
    version: bridgeVersion,
    sequence: current?.sequence ?? 1,
    arch: process.arch,
    macOS: macOS.join('.'),
    protocol: BridgeProtocolVersion,
    credentials: 2,
    journal: 1,
    now: Date.now(),
  };
}
type Handoff = {
  v: 1;
  sourceApp: string;
  sourceVersion: string;
  hostPid: number;
  corePid: number;
  environment: UpdateEnvironment;
};
type DrainedTicket = {
  v: 1;
  id: string;
  corePid: number;
  hostPid: number;
  recovery: boolean;
};
/** A first-install ticket must describe the same owner that prepared the
 * request. Recovery intentionally belongs to the newly started, blocked owner. */
export function validateDrainedUpdateTicket(
  value: unknown,
  id: string,
  recovery: boolean,
  original: Pick<Handoff, 'corePid' | 'hostPid'>,
): DrainedTicket {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('UPDATE_STATE_UNSAFE');
  const row = value as DrainedTicket;
  if (
    Object.keys(row).sort().join(',') !== 'corePid,hostPid,id,recovery,v' ||
    row.v !== 1 ||
    !idPattern.test(id) ||
    row.id !== id ||
    row.recovery !== recovery ||
    !Number.isSafeInteger(row.corePid) ||
    row.corePid < 2 ||
    !Number.isSafeInteger(row.hostPid) ||
    row.hostPid < 2 ||
    (!recovery &&
      (row.corePid !== original.corePid || row.hostPid !== original.hostPid))
  )
    fail('UPDATE_STATE_UNSAFE');
  return row;
}
export type DesktopUpdateState = {
  state: string;
  canInstall: boolean;
  canRecover: boolean;
  version?: string;
};

/** In-memory checked bytes bind the native confirmation to one release. A
 * release changing while the user is deciding requires another check/approval. */
export class DesktopUpdater {
  private checked: { metadata: Buffer; update: VerifiedUpdate } | null = null;
  state: DesktopUpdateState = {
    state: 'not-checked',
    canInstall: false,
    canRecover: false,
  };
  async localState() {
    if (!bridgeUpdateTrust)
      return (this.state = {
        state: 'trust-unconfigured',
        canInstall: false,
        canRecover: false,
      });
    const previous = await installer()
      .state()
      .catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
    const pending =
      previous && !['healthy', 'rolled-back'].includes(previous.phase);
    return (this.state = {
      state: pending
        ? 'recovery-required'
        : previous?.phase === 'rolled-back'
          ? 'rolled-back'
          : 'not-checked',
      canInstall: false,
      canRecover: !!pending,
      ...(previous ? { version: previous.version } : {}),
    });
  }
  async check() {
    this.checked = null;
    this.state = { state: 'checking', canInstall: false, canRecover: false };
    if (!bridgeUpdateTrust)
      return (this.state = {
        state: 'trust-unconfigured',
        canInstall: false,
        canRecover: false,
      });
    await nativeApp();
    const previous = await installer()
      .state()
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    if (previous && !['healthy', 'rolled-back'].includes(previous.phase))
      return (this.state = {
        state: 'recovery-required',
        canInstall: false,
        canRecover: true,
        version: previous.version,
      });
    const metadata = await downloadUpdate(
      `${trust().origin}/bridge/${trust().channel}/latest.json`,
      trust(),
      32768,
    );
    try {
      const update = verifyUpdateMetadata(
        metadata,
        trust(),
        await environment(),
      );
      this.checked = { metadata, update };
      return (this.state = {
        state: 'available',
        canInstall: true,
        canRecover: false,
        version: update.release.version,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'UPDATE_DOWNGRADE_BLOCKED'
      )
        return (this.state = {
          state:
            previous?.phase === 'rolled-back'
              ? 'rolled-back'
              : 'no-newer-release',
          canInstall: false,
          canRecover: false,
        });
      throw error;
    }
  }
  async prepare(version: string) {
    if (
      !this.checked ||
      this.state.state !== 'available' ||
      this.checked.update.release.version !== version
    )
      fail('UPDATE_CHECK_REQUIRED');
    const current = await environment();
    const update = verifyUpdateMetadata(
      this.checked.metadata,
      trust(),
      current,
    );
    this.state = {
      state: 'downloading',
      canInstall: false,
      canRecover: false,
      version,
    };
    const archive = await downloadUpdate(
      update.artifact.url,
      trust(),
      update.artifact.bytes,
    );
    verifyUpdatePackage(archive, update);
    const sourceApp = await nativeApp();
    await verifyAppleUpdateBundle(sourceApp, {
      ...update,
      release: { ...update.release, version: bridgeVersion },
    });
    const root = await privateRoot(true);
    if (
      (await readdir(root)).filter((name) => name.startsWith('request-'))
        .length >= 8
    )
      fail('UPDATE_STORAGE_REVIEW');
    const id = randomUUID(),
      request = join(root, `request-${id}`);
    await mkdir(request, { mode: 0o700 });
    await privateWrite(join(request, 'metadata.json'), this.checked.metadata);
    await privateWrite(join(request, 'package.zip'), archive);
    const handoff: Handoff = {
      v: 1,
      sourceApp,
      sourceVersion: bridgeVersion,
      hostPid: process.ppid,
      corePid: process.pid,
      environment: current,
    };
    await privateWrite(
      join(request, 'handoff.json'),
      Buffer.from(JSON.stringify(handoff)),
    );
    await privateWrite(
      join(root, `pending-${id}.json`),
      Buffer.from(JSON.stringify({ id })),
    );
    const previous = join(root, 'pending-request.json');
    if (
      await lstat(previous).then(
        () => true,
        () => false,
      )
    )
      await privateRead(previous, 128);
    await rename(join(root, `pending-${id}.json`), previous);
    const directory = await open(root, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    this.state = {
      state: 'waiting-for-drain',
      canInstall: false,
      canRecover: false,
      version,
    };
    return id;
  }
  async handoff(id: string, recovery = false) {
    trust();
    if (!idPattern.test(id)) fail('UPDATE_STATE_UNSAFE');
    await privateRoot();
    const ticket = randomUUID();
    await privateWrite(
      join(managedBridgeDirectory(), `request-${id}`, `drained-${ticket}.json`),
      Buffer.from(
        JSON.stringify({
          v: 1,
          id,
          corePid: process.pid,
          hostPid: process.ppid,
          recovery,
        }),
      ),
    );
    const child = spawn(
      process.execPath,
      ['update-helper', id, recovery ? 'recover' : 'install', ticket],
      { detached: true, stdio: 'ignore', env: nativeEnvironment() },
    );
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => reject(Error('UPDATE_HELPER_START_FAILED')));
    });
    child.unref();
    this.state = { state: 'restarting', canInstall: false, canRecover: false };
  }
  async recoveryRequest() {
    trust();
    await privateRoot();
    const value = JSON.parse(
      (
        await privateRead(
          join(managedBridgeDirectory(), 'pending-request.json'),
          128,
        )
      ).toString(),
    ) as { id: string };
    if (Object.keys(value).join(',') !== 'id' || !idPattern.test(value.id))
      fail('UPDATE_STATE_UNSAFE');
    return value.id;
  }
}

async function waitOwner() {
  for (let n = 0; n < 240; n++) {
    try {
      return await BridgeInstanceLock.acquire();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'BRIDGE_ALREADY_RUNNING'
      )
        throw error;
    }
    await delay(250);
  }
  return fail('UPDATE_STOP_UNCONFIRMED');
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
async function launch(app: string, id?: string) {
  const child = spawn(
    join(app, 'Contents/MacOS/RiceBridgeApp'),
    id ? [`--update-health-id=${id}`] : [],
    { detached: true, stdio: 'ignore', env: nativeEnvironment() },
  );
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => reject(Error('UPDATE_LAUNCH_FAILED')));
  });
  return child;
}

/** Child monitor has no HTTP management port or elevated authority. It waits
 * for the exact old host to exit AND the original config's OS owner lock. */
export async function runBridgeUpdateHelper(
  id: string,
  recovery = false,
  ticket: string,
) {
  trust();
  if (!idPattern.test(id) || !idPattern.test(ticket))
    fail('UPDATE_STATE_UNSAFE');
  const root = await privateRoot(),
    request = join(root, `request-${id}`);
  const requestInfo = await lstat(request);
  if (
    !requestInfo.isDirectory() ||
    requestInfo.isSymbolicLink() ||
    requestInfo.uid !== process.getuid?.() ||
    (requestInfo.mode & 0o777) !== 0o700
  )
    fail('UPDATE_STATE_UNSAFE');
  const drained = JSON.parse(
    (
      await privateRead(join(request, `drained-${ticket}.json`), 256)
    ).toString(),
  ) as unknown;
  const handoff = JSON.parse(
    (await privateRead(join(request, 'handoff.json'), 2048)).toString(),
  ) as Handoff;
  if (
    handoff.v !== 1 ||
    Object.keys(handoff).sort().join(',') !==
      'corePid,environment,hostPid,sourceApp,sourceVersion,v' ||
    !Number.isSafeInteger(handoff.hostPid) ||
    handoff.hostPid < 2 ||
    !Number.isSafeInteger(handoff.corePid) ||
    handoff.corePid < 2 ||
    typeof handoff.sourceApp !== 'string' ||
    !handoff.sourceApp.startsWith('/') ||
    !handoff.sourceApp.endsWith('.app')
  )
    fail('UPDATE_STATE_UNSAFE');
  const { corePid, hostPid } = validateDrainedUpdateTicket(
    drained,
    id,
    recovery,
    handoff,
  );
  const metadata = await privateRead(join(request, 'metadata.json'), 32768);
  const update = verifyUpdateMetadata(metadata, trust(), {
    ...handoff.environment,
    now: recovery ? handoff.environment.now : Date.now(),
  });
  const consumed = join(request, `consumed-${ticket}.json`);
  if (
    await lstat(consumed).then(
      () => true,
      (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return false;
        throw e;
      },
    )
  )
    fail('UPDATE_REQUEST_CONSUMED');
  await rename(join(request, `drained-${ticket}.json`), consumed);
  // Recovery of a stale download still needs authenticated metadata, but does
  // not use the network or reinterpret an unauthenticated new candidate.
  for (let n = 0; n < 240 && (alive(hostPid) || alive(corePid)); n++)
    await delay(250);
  if (alive(hostPid) || alive(corePid)) fail('UPDATE_STOP_UNCONFIRMED');
  const monitorLock = await BridgeInstanceLock.acquire(join(root, 'monitor'));
  try {
    const result = await monitorBridgeUpdate({
      createInstaller: installer,
      acquireOwner: waitOwner,
      launch,
      verifyRollback: verifyAppleUpdateBundle,
      app: managedApp(),
      sourceApp: handoff.sourceApp,
      sourceVersion: handoff.sourceVersion,
      update,
      metadata,
      archive: recovery
        ? Buffer.alloc(0)
        : await privateRead(
            join(request, 'package.zip'),
            update.artifact.bytes,
          ),
      environment: { ...handoff.environment, now: Date.now() },
      recovery,
    });
    await privateWrite(
      join(request, `result-${randomUUID()}.json`),
      Buffer.from(
        JSON.stringify({
          status: result.status,
          code: result.failureCode
            ? desktopSafeError(Error(result.failureCode))
            : null,
        }),
      ),
    );
  } finally {
    monitorLock.close();
  }
}

/** Native host carries only a random transaction id, never pairing secrets.
 * Runtime initialization calls this BEFORE either controller may claim work. */
export async function acknowledgeBridgeUpdateReadiness(signal?: AbortSignal) {
  const id = healthId();
  if (!id) return;
  if (!idPattern.test(id) || (await nativeApp()) !== managedApp())
    fail('UPDATE_HEALTH_MISMATCH');
  const engine = installer();
  const existing = await engine.state();
  if (
    existing?.id === id &&
    existing.phase === 'healthy' &&
    existing.version === bridgeVersion
  )
    return;
  await engine.reportReady(bridgeVersion, id);
  for (let n = 0; n < 480; n++) {
    if (signal?.aborted) fail('UPDATE_STOP_UNCONFIRMED');
    const state = await engine.state();
    if (state?.id !== id) fail('UPDATE_HEALTH_MISMATCH');
    if (state.phase === 'healthy') return;
    if (state.phase !== 'ready-health') fail('UPDATE_RECOVERY_REQUIRED');
    await delay(250, undefined, { signal }).catch(() =>
      fail('UPDATE_STOP_UNCONFIRMED'),
    );
  }
  fail('UPDATE_HEALTH_TIMEOUT');
}

export async function assertBridgeUpdateStartup() {
  if (!bridgeUpdateTrust || healthId()) return;
  if (!process.execPath.endsWith('/Contents/Resources/RiceBridgeCore')) return;
  if ((await nativeApp()) !== managedApp()) return;
  const state = await installer().state();
  if (state && !['healthy', 'rolled-back'].includes(state.phase))
    fail('UPDATE_RECOVERY_REQUIRED');
}
