import { randomUUID } from 'node:crypto';
import { arch } from 'node:os';
import {
  createFolderGrant,
  pair,
  revoke,
  start,
  type BridgeRuntimeState,
} from './core.js';
import {
  readConfig,
  writeConfig,
  readDeviceCredentials,
  type BridgeConfig,
  type DeviceCredentials,
} from './config.js';
import {
  KeychainUnavailableError,
  type KeychainUnavailableReason,
} from './keychain.js';
import {
  desktopMaximumFrameBytes,
  desktopSafeError,
  desktopSafeText,
  parseDesktopRequest,
  type DesktopRequest,
} from './desktop-protocol.js';
import { bridgeVersion } from './version.js';
import {
  DesktopUpdater,
  acknowledgeBridgeUpdateReadiness,
  assertBridgeUpdateStartup,
} from './desktop-update.js';
import { localPreviewOptIn } from './local-preview-settings.js';
import { localPreviewCli } from './local-preview-cli.js';
import {
  localBrowserOptIn,
  localBrowserCli,
} from './local-browser-settings.js';

export async function runDesktopController() {
  const updater = new DesktopUpdater();
  const notices: { at: string; code: string }[] = [];
  let sequence = 0;
  let mode:
    | 'unpaired'
    | 'running'
    | 'pausing'
    | 'paused'
    | 'stopping'
    | 'draining'
    | 'error' = 'unpaired';
  let errorCode: string | null = null;
  let config: BridgeConfig | null = null;
  let browserEnabled = false;
  let previewEnabled = false;
  let credentialStorage: DeviceCredentials['storage'] | null = null;
  let credentialFileSecure: boolean | null = null;
  let keychainUnavailableReason: KeychainUnavailableReason | null = null;
  let credentialCleanupPending = false;
  let runtime: BridgeRuntimeState = {
    phase: 'stopped',
    workspaceLabels: [],
    activeForeground: 0,
    activeServices: 0,
    pendingReceipts: 0,
    unknownOperations: 0,
  };
  let running: Promise<void> | null = null;
  let runtimeFailed = false;
  let abort: AbortController | null = null;
  let drain: AbortController | null = null;
  let picker: {
    id: string;
    resolve: (path: string) => void;
    reject: (error: Error) => void;
  } | null = null;
  let closing = false;
  const lifecycle = new AbortController();
  let initializing = true;
  let outputClosed = false;
  let buffer = Buffer.alloc(0);
  let work = Promise.resolve();
  let queued = 0;
  const ids = new Set<string>();
  const original = {
    info: console.info,
    warn: console.warn,
    error: console.error,
    log: console.log,
  };
  const note = (code: string) => {
    notices.push({ at: new Date().toISOString(), code });
    if (notices.length > 100) notices.shift();
  };
  // The old CLI logger is intentionally NOT a desktop output protocol or export.
  console.info = console.log = () => note('CORE_NOTICE');
  console.warn = () => note('CORE_WARNING');
  console.error = () => note('CORE_ERROR');
  const send = (value: object) => {
    if (outputClosed) return;
    const data = JSON.stringify({ v: 1, ...value }) + '\n';
    if (
      Buffer.byteLength(data) > 32_768 ||
      process.stdout.writableLength > 131_072
    ) {
      if (!closing) void shutdown();
      return;
    }
    process.stdout.write(data);
  };
  const state = () => ({
    version: bridgeVersion,
    architecture: arch(),
    mode,
    errorCode,
    deviceId: config?.deviceId ?? null,
    deviceName: config ? desktopSafeText(config.deviceName) : null,
    server: config ? new URL(config.server).origin : null,
    credentialStorage,
    credentialFileSecure,
    keychainUnavailableReason,
    credentialCleanupPending,
    browserEnabled,
    previewEnabled,
    environment: runtime.environment ?? null,
    update: updater.state,
    connection: runtime.phase,
    workspaceLabels: config
      ? runtime.workspaceLabels.map(desktopSafeText).slice(0, 16)
      : [],
    activeForeground: runtime.activeForeground,
    activeServices: runtime.activeServices,
    activeBrowsers: runtime.activeBrowsers ?? 0,
    pendingReceipts: runtime.pendingReceipts,
    unknownOperations: runtime.unknownOperations,
  });
  const publish = () =>
    send({ type: 'state', sequence: ++sequence, state: state() });
  const reply = (
    request: DesktopRequest,
    ok: boolean,
    data?: object,
    code?: string,
  ) =>
    send({
      type: 'response',
      id: request.id,
      ok,
      ...(data ? { data } : {}),
      ...(code ? { code } : {}),
    });
  const cancelPicker = () => {
    picker?.reject(Error('DESKTOP_PICKER_CANCELED'));
    picker = null;
  };
  const refresh = async () => {
    let next: BridgeConfig;
    try {
      next = await readConfig();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        config = null;
        browserEnabled = false;
        previewEnabled = false;
        credentialStorage = null;
        credentialFileSecure = null;
        keychainUnavailableReason = null;
        return;
      }
      throw Error('DESKTOP_CONFIG_INVALID');
    }
    if (
      !next ||
      typeof next.deviceId !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(next.deviceId) ||
      typeof next.deviceName !== 'string' ||
      typeof next.server !== 'string' ||
      (next.paused !== undefined && typeof next.paused !== 'boolean') ||
      !Array.isArray(next.grants) ||
      next.grants.some(
        (grant) =>
          typeof grant.label !== 'string' || typeof grant.rootPath !== 'string',
      )
    )
      throw Error('DESKTOP_CONFIG_INVALID');
    try {
      const url = new URL(next.server);
      if (
        url.username ||
        url.password ||
        !['https:', 'http:'].includes(url.protocol)
      )
        throw Error();
    } catch {
      throw Error('DESKTOP_CONFIG_INVALID');
    }
    config = next;
    browserEnabled = await localBrowserOptIn(next).catch(() => {
      note('LOCAL_BROWSER_SETTINGS_UNSAFE');
      return false;
    });
    previewEnabled = await localPreviewOptIn(next).catch(() => {
      note('LOCAL_PREVIEW_SETTINGS_UNSAFE');
      return false;
    });
    runtime.workspaceLabels = next.grants.map((grant) => grant.label);
    try {
      const credentials = await readDeviceCredentials(next.deviceId);
      credentialStorage = credentials.storage;
      credentialFileSecure = credentials.privateFileSecure ?? null;
      keychainUnavailableReason = credentials.keychainUnavailableReason ?? null;
    } catch (error) {
      credentialStorage = null;
      credentialFileSecure = null;
      keychainUnavailableReason =
        error instanceof KeychainUnavailableError ? error.reason : null;
      throw Error('DESKTOP_CREDENTIAL_UNAVAILABLE');
    }
  };
  const halt = async () => {
    cancelPicker();
    abort?.abort();
    if (running) await running;
    abort = null;
    if (runtimeFailed || runtime.phase !== 'stopped') {
      mode = 'error';
      errorCode = 'DESKTOP_STOP_UNCONFIRMED';
      publish();
      throw Error(errorCode);
    }
    if (!closing) mode = config ? 'paused' : 'unpaired';
    publish();
  };
  const resume = async () => {
    if (running || closing) return;
    await refresh();
    if (closing) return;
    if (!config) throw Error('DESKTOP_PAIRING_REQUIRED');
    if (config.paused) {
      config = { ...config, paused: false };
      await writeConfig(config);
    }
    mode = 'running';
    errorCode = null;
    runtimeFailed = false;
    abort = new AbortController();
    drain = new AbortController();
    publish();
    running = start({
      signal: abort.signal,
      drainSignal: drain.signal,
      onReady: () => acknowledgeBridgeUpdateReadiness(abort?.signal),
      onState: (next) => {
        runtime = next;
        if (next.environment?.settings)
          browserEnabled = next.environment.settings.localBrowser;
        publish();
      },
      onNotice: note,
      chooseWorkspace: () =>
        new Promise<string>((resolve, reject) => {
          if (closing || abort?.signal.aborted || picker)
            return reject(Error('DESKTOP_PICKER_CANCELED'));
          const id = randomUUID();
          picker = { id, resolve, reject };
          send({ type: 'picker', pickerId: id });
        }),
    })
      .catch((error: unknown) => {
        runtimeFailed = true;
        errorCode = desktopSafeError(error);
        mode = 'error';
        note(errorCode);
        publish();
      })
      .finally(() => {
        running = null;
      });
  };
  const perform = async (request: DesktopRequest) => {
    if (request.type === 'pair') {
      await refresh();
      if (config) throw Error('DESKTOP_ALREADY_PAIRED');
      await pair(['--server', request.server, '--code', request.code]);
      await refresh();
      await resume();
    } else if (request.type === 'resume') await resume();
    else if (request.type === 'prepare') {
      if (
        runtime.activeForeground ||
        runtime.activeServices ||
        runtime.activeBrowsers
      )
        throw Error('DESKTOP_BUSY');
      await halt();
      await resume();
    } else if (request.type === 'updateStatus') {
      await updater.check();
      publish();
      reply(request, true, updater.state);
      return;
    } else if (request.type === 'recoverUpdate') {
      if (!updater.state.canRecover) throw Error('UPDATE_RECOVERY_REQUIRED');
      if (
        running ||
        runtime.phase !== 'stopped' ||
        runtime.activeForeground ||
        runtime.activeServices ||
        runtime.unknownOperations
      )
        throw Error('UPDATE_DRAIN_UNCONFIRMED');
      const id = await updater.recoveryRequest();
      await updater.handoff(id, true);
      reply(request, true, { restart: true });
      return;
    } else if (request.type === 'drain' || request.type === 'installUpdate') {
      const requestId =
        request.type === 'installUpdate'
          ? await updater.prepare(request.version)
          : null;
      cancelPicker();
      mode = 'draining';
      drain?.abort();
      publish();
      if (running) await running;
      if (
        runtimeFailed ||
        runtime.phase !== 'stopped' ||
        runtime.activeForeground ||
        runtime.activeServices ||
        runtime.unknownOperations
      ) {
        mode = 'error';
        throw Error('UPDATE_DRAIN_UNCONFIRMED');
      }
      mode = config ? 'paused' : 'unpaired';
      if (config && !requestId) {
        config = { ...(await readConfig()), paused: true };
        await writeConfig(config);
      }
      publish();
      if (requestId) {
        if (closing) throw Error('UPDATE_STOP_UNCONFIRMED');
        await updater.handoff(requestId);
        reply(request, true, { restart: true });
        return;
      }
    } else if (request.type === 'pause') {
      mode = 'pausing';
      publish();
      await halt();
      if (config) {
        config = { ...(await readConfig()), paused: true };
        await writeConfig(config);
      }
    } else if (request.type === 'workspace') {
      await refresh();
      if (!config) throw Error('DESKTOP_PAIRING_REQUIRED');
      const shouldResume = mode === 'running';
      mode = 'pausing';
      publish();
      await halt();
      await createFolderGrant(request.path);
      await refresh();
      if (shouldResume) await resume();
    } else if (request.type === 'browser' || request.type === 'preview') {
      await refresh();
      if (!config) throw Error('DESKTOP_PAIRING_REQUIRED');
      const shouldResume = mode === 'running';
      mode = 'pausing';
      publish();
      await halt();
      // A failed stop never changes persistent permissions. Enabling does not
      // start Chrome, install dependencies or grant any server-side capability.
      const action = [request.enabled ? 'enable' : 'disable'];
      if (request.type === 'preview') await localPreviewCli(action);
      else await localBrowserCli(action);
      await refresh();
      if (shouldResume) await resume();
    } else if (request.type === 'revoke') {
      await refresh();
      if (!config || config.deviceId !== request.confirmDeviceId)
        throw Error('DESKTOP_REVOKE_MISMATCH');
      mode = 'pausing';
      publish();
      await halt();
      // If the server is unavailable this throws; config and token remain.
      const result = await revoke();
      // A later device's successful cleanup says nothing about credentials
      // retained by an earlier revocation in this Core process.
      credentialCleanupPending ||= !result.cleanupComplete;
      if (credentialCleanupPending) note('DESKTOP_REVOKED_CLEANUP_PENDING');
      if (!result.configDeleted) {
        mode = 'error';
        errorCode = 'DESKTOP_REVOKED_CLEANUP_PENDING';
        publish();
        reply(request, true, {
          serverRevoked: true,
          cleanupComplete: false,
          configDeleted: false,
        });
        return;
      }
      config = null;
      browserEnabled = false;
      previewEnabled = false;
      credentialStorage = null;
      credentialFileSecure = null;
      keychainUnavailableReason = null;
      mode = 'unpaired';
      errorCode = credentialCleanupPending
        ? 'DESKTOP_REVOKED_CLEANUP_PENDING'
        : null;
      publish();
      reply(request, true, {
        serverRevoked: true,
        cleanupComplete: result.cleanupComplete,
        configDeleted: true,
      });
      return;
    }
    publish();
    reply(request, true);
  };
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (request?: DesktopRequest) => {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    lifecycle.abort();
    mode = 'stopping';
    publish();
    cancelPicker();
    abort?.abort();
    shutdownPromise = (async () => {
      try {
        await work;
        await halt();
        if (request) reply(request, true);
      } catch (error) {
        errorCode = desktopSafeError(error);
        mode = 'error';
        note(errorCode);
        publish();
        if (request) reply(request, false, undefined, errorCode);
        process.exitCode = 1;
      } finally {
        finish();
      }
    })();
    return shutdownPromise;
  };
  const onInput = (chunk: Buffer) => {
    if (closing) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > desktopMaximumFrameBytes * 2) {
      errorCode = 'DESKTOP_FRAME_LIMIT';
      void shutdown();
      return;
    }
    while (buffer.includes(10)) {
      const boundary = buffer.indexOf(10);
      const line = buffer.subarray(0, boundary).toString('utf8');
      buffer = buffer.subarray(boundary + 1);
      let request: DesktopRequest;
      try {
        request = parseDesktopRequest(line);
      } catch (error) {
        errorCode = desktopSafeError(error);
        note(errorCode);
        send({ type: 'protocolError', code: errorCode });
        void shutdown();
        return;
      }
      if (ids.has(request.id)) {
        reply(request, false, undefined, 'DESKTOP_REQUEST_DUPLICATE');
        continue;
      }
      if (ids.size >= 4096) {
        errorCode = 'DESKTOP_FRAME_LIMIT';
        void shutdown();
        return;
      }
      ids.add(request.id);
      if (request.type === 'stop') {
        void shutdown(request);
        return;
      }
      if (request.type === 'status') {
        reply(request, true, state());
        continue;
      }
      if (request.type === 'diagnostics') {
        reply(request, true, {
          version: bridgeVersion,
          architecture: arch(),
          mode,
          connection: runtime.phase,
          workspaceCount: config?.grants.length ?? 0,
          credentialStorage,
          credentialFileSecure,
          keychainUnavailableReason,
          credentialCleanupPending,
          activeForeground: runtime.activeForeground,
          activeServices: runtime.activeServices,
          pendingReceipts: runtime.pendingReceipts,
          unknownOperations: runtime.unknownOperations,
          notices,
        });
        continue;
      }
      if (request.type === 'picker') {
        if (picker?.id !== request.pickerId) {
          reply(request, false, undefined, 'DESKTOP_REQUEST_INVALID');
          continue;
        }
        const current = picker;
        picker = null;
        if (request.path === null)
          current.reject(Error('DESKTOP_PICKER_CANCELED'));
        else current.resolve(request.path);
        reply(request, true);
        continue;
      }
      if (initializing) {
        reply(request, false, undefined, 'DESKTOP_BUSY');
        continue;
      }
      if (queued >= 8) {
        reply(request, false, undefined, 'DESKTOP_BUSY');
        continue;
      }
      queued++;
      work = work
        .then(async () => {
          if (closing) {
            reply(request, false, undefined, 'DESKTOP_BUSY');
            return;
          }
          try {
            await perform(request);
          } catch (error) {
            errorCode = desktopSafeError(error);
            note(errorCode);
            publish();
            reply(request, false, undefined, errorCode);
          }
        })
        .finally(() => {
          queued--;
        });
    }
    if (buffer.length > desktopMaximumFrameBytes) {
      errorCode = 'DESKTOP_FRAME_LIMIT';
      void shutdown();
    }
  };
  const onEnd = () => {
    void shutdown();
  };
  const onError = () => {
    outputClosed = true;
    void shutdown();
  };
  process.stdin.on('data', onInput);
  process.stdin.once('end', onEnd);
  process.stdout.on('error', onError);
  process.once('SIGTERM', onEnd);
  process.once('SIGINT', onEnd);
  try {
    try {
      await refresh();
      await updater.localState();
      await assertBridgeUpdateStartup();
      const stored = config as BridgeConfig | null;
      if (stored && !stored.paused) await resume();
      else {
        if (stored?.paused) mode = 'paused';
        await acknowledgeBridgeUpdateReadiness(lifecycle.signal);
        publish();
      }
    } catch (error) {
      mode = 'error';
      errorCode = desktopSafeError(error);
      publish();
    }
    initializing = false;
    await done;
  } finally {
    process.stdin.removeListener('data', onInput);
    process.stdin.removeListener('end', onEnd);
    process.stdout.removeListener('error', onError);
    process.removeListener('SIGTERM', onEnd);
    process.removeListener('SIGINT', onEnd);
    process.stdin.pause();
    Object.assign(console, original);
  }
}
