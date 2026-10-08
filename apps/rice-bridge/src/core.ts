import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { arch, hostname, platform } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

import {
  BridgeCapabilities,
  BridgeProtocolVersion,
  BridgeCommandSchema,
  BridgeWorkspaceSelectionRequestSchema,
  managedPythonPayloadForPlatform,
  pdfReadReleaseForPlatform,
  type RuntimeLocalPythonProfile,
  type RuntimeLocalPdfProfile,
  BridgeSettingsCommandSchema,
  FolderTriggerRuleSchema,
  FolderTriggerEventSchema,
  FolderTriggerObservationSchema,
  UuidSchema,
  type FolderTriggerRule,
  type BridgeSettingsCommand,
  PairBridgeDeviceResponseSchema,
  type BridgeEnvironment,
  type BridgeCommand,
  type BridgeDevice,
  type BridgeFolderGrant,
  type BridgeWorkspaceSelectionRequest,
} from '@allrice/contracts';

import {
  bridgeRequest,
  BridgeClientError,
  type BridgeRequestInput,
} from './client.js';
import { BridgeDualTransport } from './dual-transport.js';
import {
  localCapabilitySettings,
  applyCapabilitySettings,
} from './capability-settings.js';
import {
  deleteConfig,
  deleteDeviceToken,
  configPath,
  readConfig,
  readDeviceToken,
  storeDeviceToken,
  writeConfig,
  type BridgeConfig,
} from './config.js';
import { LocalExecutionError, executeLocalCommand } from './executor.js';
import type { BridgeJournal } from './journal.js';
import { fileGuardianReady } from './file-guardian-resources.js';
import {
  FolderTriggerWatcher,
  folderTriggerRuleFingerprint,
  folderTriggerRuleKey,
  folderTriggerMatches,
  folderTriggerEventId,
  type FolderTriggerWatcherOptions,
} from './folder-trigger-watcher.js';
import {
  nativeSandboxConfig,
  sandboxOptIn,
  saveSandboxOptIn,
} from './sandbox-settings.js';
import { bridgeVersion } from './version.js';
import {
  probeBridgeFiles,
  projectBridgeCapabilityReadiness,
  readinessErrorCode,
} from './capability-readiness.js';
import {
  initialBridgeEnvironment,
  prepareBridgeBrowser,
  bridgePreviewState,
  prepareLocalSandbox,
  prepareAndReportLocalCommand,
} from './runtime-preparation.js';

const execFileAsync = promisify(execFile);
export const defaultBridgeServer =
  process.env.ALLRICE_BRIDGE_DEFAULT_SERVER ?? 'https://allrice-dsh.bplabs.xyz';

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function normalizedServer(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Bridge server must use HTTP or HTTPS');
  }
  return `${url.origin}/`;
}

export function normalizedPairingCode(value: string) {
  const compact = value.trim().replaceAll('-', '').toUpperCase();
  if (!/^[A-F0-9]{8}$/.test(compact)) {
    throw new Error('配对码格式不正确，请输入网页显示的 8 位配对码');
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

async function credentials(config: BridgeConfig) {
  return {
    config,
    token: await readDeviceToken(config.deviceId),
  };
}

export async function pair(args: string[]) {
  const currentArch = arch();
  if (
    platform() !== 'darwin' ||
    (currentArch !== 'arm64' && currentArch !== 'x64')
  ) {
    throw new Error(
      'Rice Bridge supports Apple Silicon and Intel 64-bit macOS only',
    );
  }
  const serverInput = option(args, '--server');
  if (!serverInput) throw new Error('pair requires --server https://...');
  const server = normalizedServer(serverInput);
  const codeInput = option(args, '--code');
  const code = codeInput ? normalizedPairingCode(codeInput) : undefined;
  if (!code) throw new Error('pair requires --code XXXX-XXXX');
  const name = option(args, '--name') ?? `${hostname()} · Rice Bridge`;
  const response = PairBridgeDeviceResponseSchema.parse(
    await bridgeRequest({
      server,
      path: '/api/v1/bridge/device/pair',
      method: 'POST',
      body: {
        code,
        name,
        platform: currentArch === 'arm64' ? 'macos-arm64' : 'macos-x64',
        protocolVersion: BridgeProtocolVersion,
        capabilities: BridgeCapabilities,
      },
    }),
  );
  await storeDeviceToken(response.device.id, response.deviceToken);
  const paired: BridgeConfig = {
    server,
    deviceId: response.device.id,
    deviceName: response.device.name,
    grants: [],
    journalNamespace: response.device.id,
  };
  await writeConfig(paired);
  await saveSandboxOptIn(paired, true);
  await (
    await import('./local-browser-settings.js')
  ).saveLocalBrowserOptIn(paired, true);
  await (
    await import('./local-preview-settings.js')
  ).saveLocalPreviewOptIn(paired, true);
  console.info(`Rice Bridge 已连接：${response.device.name}`);
}

export async function createFolderGrant(path: string, name?: string) {
  const rootPath = await realpath(path);
  if (!(await stat(rootPath)).isDirectory())
    throw Error('BRIDGE_WORKSPACE_REQUIRED');
  await assertWorkspaceExcludesBridgeState(rootPath);
  const label = name ?? basename(rootPath);
  const rootFingerprint = createHash('sha256').update(rootPath).digest('hex');
  const { config, token } = await credentials(await readConfig());
  const response = await bridgeRequest<{ grant: BridgeFolderGrant }>({
    server: config.server,
    path: '/api/v1/bridge/device/grants',
    method: 'POST',
    token,
    body: { label, rootFingerprint },
  });
  const next: BridgeConfig = {
    ...config,
    grants: [
      ...config.grants.filter(
        (candidate) => candidate.id !== response.grant.id,
      ),
      { ...response.grant, rootPath },
    ],
  };
  await writeConfig(next);
  console.info(`已授权文件夹：${label}`);
  return response.grant;
}

export async function grant(args: string[]) {
  const path = args[0];
  if (!path) throw new Error('grant requires a folder path');
  await createFolderGrant(path, option(args, '--name'));
}

export async function status() {
  const { config, token } = await credentials(await readConfig());
  const response = await bridgeRequest<{
    device: BridgeDevice;
    grants: BridgeFolderGrant[];
  }>({
    server: config.server,
    path: '/api/v1/bridge/device/status',
    token,
  });
  console.info(JSON.stringify(response, null, 2));
}

async function complete(
  config: BridgeConfig,
  token: string,
  command: BridgeCommand,
) {
  const grant = config.grants.find(
    (candidate) => candidate.id === command.folderGrantId,
  );
  if (!grant) {
    throw new LocalExecutionError(
      'GRANT_NOT_FOUND',
      'The command references a folder that is not authorized on this Mac',
    );
  }
  try {
    await assertWorkspaceExcludesBridgeState(await realpath(grant.rootPath));
    const result = await executeLocalCommand(grant.rootPath, command.payload);
    await bridgeRequest({
      server: config.server,
      path: `/api/v1/bridge/device/commands/${command.id}/complete`,
      method: 'POST',
      token,
      body: {
        leaseToken: command.leaseToken,
        status: 'succeeded',
        output: result.output,
        summary: result.summary,
      },
    });
  } catch (error) {
    const code =
      error instanceof LocalExecutionError
        ? error.code
        : 'LOCAL_EXECUTION_FAILED';
    await bridgeRequest({
      server: config.server,
      path: `/api/v1/bridge/device/commands/${command.id}/complete`,
      method: 'POST',
      token,
      body: {
        leaseToken: command.leaseToken,
        status: 'failed',
        summary: error instanceof Error ? error.message.slice(0, 500) : code,
        errorCode: code,
      },
    });
  }
}

async function completeLocalFileCommand(
  config: BridgeConfig,
  token: string,
  command: BridgeCommand,
  journal: BridgeJournal,
  options: StartOptions,
  signal: AbortSignal,
) {
  const { executeLocalFile, LocalFileError } = await import('./local-files.js');
  const { localFileHttpTransport, isLocalFilePayload, flushLocalFileCommands } =
    await import('./local-file-client.js');
  if (!isLocalFilePayload(command.payload))
    throw Error('LOCAL_FILE_INVALID_COMMAND');
  if (!(await journal.beginFileCommand(command))) {
    await flushLocalFileCommands({
      server: config.server,
      token,
      journal,
      signal,
    });
    return;
  }
  const grant = config.grants.find((g) => g.id === command.folderGrantId);
  try {
    if (!grant) throw new LocalFileError('GRANT_NOT_FOUND');
    const root = await realpath(grant.rootPath);
    if (
      createHash('sha256').update(root).digest('hex') !== grant.rootFingerprint
    )
      throw new LocalFileError('FOLDER_CHANGED');
    journal.assertWorkspace(root);
    const channel = localFileHttpTransport({
      server: config.server,
      token,
      kind: 'command',
      id: command.id,
      leaseToken: command.leaseToken,
      signal,
    });
    const output = await executeLocalFile(root, command.payload, {
      ...channel,
      signal,
      chooseFile: options.chooseFile ?? chooseLocalFile,
      checkpoint: (output) => journal.fileCommandCheckpoint(command, output),
    });
    if (output.status === 'inspected')
      await journal.fileCommandCheckpoint(command, output);
  } catch (error) {
    await journal.completeFileCommand(command, {
      leaseToken: command.leaseToken,
      status:
        error instanceof LocalFileError && error.unknown
          ? 'unknown'
          : error instanceof LocalFileError && error.code === 'FILE_CANCELED'
            ? 'canceled'
            : 'failed',
      summary: '本地文件操作未完成；请查看具体原因，未知结果不得重做',
      errorCode:
        error instanceof LocalFileError ? error.code : 'LOCAL_FILE_FAILED',
    });
  }
  await flushLocalFileCommands({
    server: config.server,
    token,
    journal,
    signal,
  });
}

async function chooseLocalFile(root: string, signal?: AbortSignal) {
  if (platform() !== 'darwin') return null;
  try {
    const result = await execFileAsync(
      '/usr/bin/osascript',
      [
        '-e',
        'on run argv\nreturn POSIX path of (choose file with prompt "选择已授权文件夹内要上传的文件" default location (POSIX file (item 1 of argv)))\nend run',
        root,
      ],
      { signal, timeout: 300_000 },
    );
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function chooseWorkspaceFolder() {
  if (platform() !== 'darwin') {
    throw new Error('Native workspace selection requires macOS');
  }
  const result = await execFileAsync('/usr/bin/osascript', [
    '-e',
    'POSIX path of (choose folder with prompt "选择 Rice 的本地工作区")',
  ]);
  return result.stdout.trim();
}

async function completeWorkspaceSelection(
  config: BridgeConfig,
  token: string,
  request: BridgeWorkspaceSelectionRequest,
  picker = chooseWorkspaceFolder,
  beforeGrant?: () => Promise<void>,
) {
  try {
    const rootPath = await picker();
    await beforeGrant?.();
    const grant = await createFolderGrant(rootPath);
    await bridgeRequest({
      server: config.server,
      path: `/api/v1/bridge/device/workspace-selections/${request.id}/complete`,
      method: 'POST',
      token,
      body: {
        leaseToken: request.leaseToken,
        status: 'succeeded',
        grantId: grant.id,
      },
    });
    console.info(`✓ 本地工作区已切换为：${grant.label}`);
  } catch {
    await bridgeRequest({
      server: config.server,
      path: `/api/v1/bridge/device/workspace-selections/${request.id}/complete`,
      method: 'POST',
      token,
      body: {
        leaseToken: request.leaseToken,
        status: 'failed',
        errorCode: 'NATIVE_PICKER_CANCELED',
      },
    }).catch(() => undefined);
    console.info('未选择新的本地工作区。');
  }
}

export interface BridgeRuntimeState {
  environment?: BridgeEnvironment;
  phase: 'connecting' | 'online' | 'offline' | 'stopping' | 'stopped';
  workspaceLabels: string[];
  activeForeground: number;
  activeBrowsers?: number;
  activeServices: number;
  pendingReceipts: number;
  unknownOperations: number;
}

/** Local execution may not overwrite its pairing, owner lock or evidence. */
export async function assertWorkspaceExcludesBridgeState(root: string) {
  const requested = resolve(configPath());
  // Compare physical paths: Application Support or a configured parent may be
  // reached through a symlink (and macOS /var aliases /private/var).
  const configuration = join(
    await realpath(dirname(requested)),
    basename(requested),
  );
  const relation = relative(root, configuration);
  if (
    relation === '' ||
    (!relation.startsWith(`..${sep}`) && relation !== '..') ||
    root.startsWith(`${configuration}.`)
  )
    throw Error('BRIDGE_WORKSPACE_CONTAINS_STATE');
}

export function journalDirectory(config: BridgeConfig) {
  if (config.journalNamespace !== undefined) {
    if (
      config.journalNamespace !== config.deviceId ||
      !/^[a-f0-9-]{36}$/i.test(config.journalNamespace)
    )
      throw Error('JOURNAL_NAMESPACE_INVALID');
    return `${configPath()}.operation-journal-${config.journalNamespace}`;
  }
  return `${configPath()}.operation-journal`;
}

/** Chokidar's global override wins over usePolling:false. Refuse it, without
 * changing the user's environment or silently installing a polling loop. */
export function assertFolderTriggerWatcherEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const value = environment.CHOKIDAR_USEPOLLING?.toLowerCase();
  if (value && value !== 'false' && value !== '0')
    throw Error('FOLDER_TRIGGER_POLLING_UNSUPPORTED');
}

export function projectFolderTriggerEnvironment(
  environment: BridgeEnvironment,
  available: boolean,
  stopping: boolean,
) {
  let supported = available && !stopping && !environment.paused;
  try {
    assertFolderTriggerWatcherEnvironment();
  } catch {
    supported = false;
  }
  if (supported) environment.folderTriggerVersion = 1;
  else delete environment.folderTriggerVersion;
}

/** Verify the actual sealed primitive and SQLite guard on an empty directory
 * we own. A source-level feature flag or installed helper path is insufficient. */
export async function probeFolderTriggerRuntime(input: {
  journal: BridgeJournal | null;
  directory: string;
  signal: AbortSignal;
}) {
  if (
    !input.journal ||
    process.platform !== 'darwin' ||
    !['x64', 'arm64'].includes(process.arch) ||
    !fileGuardianReady()
  )
    return false;
  assertFolderTriggerWatcherEnvironment();
  input.signal.throwIfAborted();
  await input.journal.diagnosticCounts();
  const directory = await mkdtemp(join(input.directory, 'folder-probe-'));
  try {
    input.signal.throwIfAborted();
    const { executeFileSurvey } = await import('./file-survey.js');
    const { output } = await executeFileSurvey(
      await realpath(directory),
      '.',
      { mode: 'files', hash: false, maximumEntries: 1, maximumHashBytes: 1 },
      { signal: input.signal },
    );
    input.signal.throwIfAborted();
    return output.complete && !output.truncated && output.files.length === 0;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type FolderCoreWatcher = Pick<
  FolderTriggerWatcher,
  'start' | 'renewAdmission' | 'reconcile' | 'close'
>;
type FolderCoreEntry = {
  rule: FolderTriggerRule;
  watcher: FolderCoreWatcher;
  task: Promise<void>;
  ready: boolean;
  errorCode: string | null;
  observation?: string;
};
export type FolderTriggerCoreOptions = {
  server: string;
  deviceId: string;
  token: string;
  journal: BridgeJournal;
  signal: AbortSignal;
  drainSignal?: AbortSignal;
  available(): boolean;
  readCredentials?(): Promise<{ config: BridgeConfig; token: string }>;
  request?(input: BridgeRequestInput): Promise<unknown>;
  makeWatcher?(options: FolderTriggerWatcherOptions): FolderCoreWatcher;
  onDiagnostic?(code: string): void;
};

/** Called by the existing heartbeat only. All facts remain in the exact device
 * journal until the authenticated server acknowledges the immutable event. */
export class FolderTriggerCore {
  private entries = new Map<string, FolderCoreEntry>();
  private syncTask: Promise<void> | null = null;
  private flushTask: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private disconnected = false;
  private identityCurrent = true;
  private readonly abort = () => {
    void this.close().catch(() =>
      this.options.onDiagnostic?.('FOLDER_TRIGGER_STOP_UNCONFIRMED'),
    );
  };
  constructor(private readonly options: FolderTriggerCoreOptions) {
    options.signal.addEventListener('abort', this.abort, { once: true });
    options.drainSignal?.addEventListener('abort', this.abort, { once: true });
  }
  get canAdvertise() {
    return (
      this.identityCurrent &&
      !this.closing &&
      !this.options.signal.aborted &&
      !this.options.drainSignal?.aborted
    );
  }
  private request(input: Omit<BridgeRequestInput, 'server' | 'token'>) {
    return (this.options.request ?? bridgeRequest)({
      ...input,
      server: this.options.server,
      token: this.options.token,
      signal: input.signal ?? this.options.signal,
      maximumResponseBytes: input.maximumResponseBytes ?? 4096,
      timeoutMs: 5000,
    });
  }
  private code(error: unknown) {
    return readinessErrorCode(error, 'FOLDER_TRIGGER_UNAVAILABLE');
  }
  private async currentConfig() {
    if (
      this.closing ||
      this.options.signal.aborted ||
      this.options.drainSignal?.aborted
    )
      throw Error('FOLDER_TRIGGER_CLOSED');
    assertFolderTriggerWatcherEnvironment();
    if (!this.options.available()) throw Error('FOLDER_TRIGGER_UNAVAILABLE');
    const current = await (
      this.options.readCredentials ??
      (async () => credentials(await readConfig()))
    )();
    if (
      current.config.server !== this.options.server ||
      current.config.deviceId !== this.options.deviceId ||
      current.token !== this.options.token
    ) {
      this.identityCurrent = false;
      throw Error('FOLDER_TRIGGER_IDENTITY_CHANGED');
    }
    if (current.config.paused) {
      this.identityCurrent = false;
      throw Error('FOLDER_TRIGGER_PAUSED');
    }
    this.identityCurrent = true;
    return current.config;
  }
  private async root(rule: FolderTriggerRule) {
    const config = await this.currentConfig();
    const current = this.entries.get(folderTriggerRuleKey(rule));
    if (
      !current ||
      current.errorCode ||
      folderTriggerRuleFingerprint(current.rule) !==
        folderTriggerRuleFingerprint(rule) ||
      Date.parse(current.rule.admissionExpiresAt) <= Date.now() ||
      rule.deviceId !== this.options.deviceId
    )
      throw Error('FOLDER_TRIGGER_SCOPE_REVOKED');
    // The authenticated current rule binds runtime_generation. Local config
    // only maps that exact grant id to its previously selected physical root.
    const grant = config.grants.find(
      (value) => value.id === rule.folderGrantId,
    );
    if (
      !grant ||
      (await realpath(grant.rootPath)) !== grant.rootPath ||
      createHash('sha256').update(grant.rootPath).digest('hex') !==
        grant.rootFingerprint
    )
      throw Error('FOLDER_TRIGGER_ROOT_CHANGED');
    return grant.rootPath;
  }
  private async drop(entry: FolderCoreEntry) {
    entry.ready = false;
    await entry.watcher.close();
    await entry.task;
    entry.ready = false;
  }
  private async pause(error: unknown) {
    const code = this.code(error);
    const entries = [...this.entries.values()];
    for (const entry of entries) entry.errorCode = code;
    const results = await Promise.allSettled(
      entries.map((entry) => this.drop(entry)),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    if (code === 'FOLDER_TRIGGER_PAUSED' && !this.closing) {
      try {
        const current = await (
          this.options.readCredentials ??
          (async () => credentials(await readConfig()))
        )();
        // Release can overlap a re-pair. Report the completed physical pause
        // only while its original device/server/token still owns this scope.
        if (
          current.config.server === this.options.server &&
          current.config.deviceId === this.options.deviceId &&
          current.token === this.options.token
        )
          await this.observe();
      } catch (error) {
        // A failed status delivery keeps its digest unacknowledged for the
        // next scoped check without undoing the physical watcher release.
        this.options.onDiagnostic?.(this.code(error));
      }
    }
  }
  /** Local identity/settings changes also stop listeners during long commands. */
  async checkScope() {
    try {
      await this.currentConfig();
    } catch (error) {
      await this.pause(error);
      throw error;
    }
  }
  synchronize() {
    if (this.closing) return Promise.resolve();
    this.syncTask ??= this.sync().finally(() => {
      this.syncTask = null;
    });
    return this.syncTask;
  }
  async connectionFailure(error: unknown) {
    this.disconnected = true;
    if (error instanceof BridgeClientError && [401, 403].includes(error.status))
      await this.pause(error);
  }
  private async sync() {
    try {
      await this.checkScope();
      const response = z
        .object({ rules: z.array(FolderTriggerRuleSchema).max(32) })
        .strict()
        .parse(
          await this.request({
            path: '/api/v1/bridge/folder-triggers',
            // 32 bounded rules may include 16 UTF-8 relative exclusions each.
            maximumResponseBytes: 2_000_000,
          }),
        );
      await this.checkScope();
      const rules = new Map<string, FolderTriggerRule>();
      const ids = new Set<string>();
      for (const rule of response.rules) {
        if (
          rule.deviceId !== this.options.deviceId ||
          ids.has(rule.automationId) ||
          Date.parse(rule.admissionExpiresAt) <= Date.now() ||
          Date.parse(rule.admissionExpiresAt) > Date.now() + 80000
        )
          throw Error('FOLDER_TRIGGER_RULE_INVALID');
        ids.add(rule.automationId);
        rules.set(folderTriggerRuleKey(rule), rule);
      }
      const reconnect = this.disconnected;
      this.disconnected = false;
      const observations = new Map<string, string | undefined>();
      for (const [key, entry] of this.entries) {
        const rule = rules.get(key);
        if (
          rule &&
          folderTriggerRuleFingerprint(rule) ===
            folderTriggerRuleFingerprint(entry.rule)
        ) {
          // Preserve and report an asynchronous startup failure before retry;
          // retrying cannot erase it or repeatedly write the same status.
          if (entry.errorCode) await this.observe(undefined, [entry]);
          observations.set(key, entry.observation);
        }
        if (
          !rule ||
          entry.errorCode ||
          folderTriggerRuleFingerprint(rule) !==
            folderTriggerRuleFingerprint(entry.rule)
        ) {
          await this.drop(entry);
          this.entries.delete(key);
        }
      }
      for (const [key, rule] of rules) {
        if (this.closing) break;
        const old = this.entries.get(key);
        if (old) {
          old.rule = rule;
          try {
            await old.watcher.renewAdmission(rule);
            if (reconnect && old.ready) {
              old.ready = false;
              old.task = old.watcher
                .reconcile()
                .then(() => {
                  old.ready = true;
                })
                .catch((error: unknown) => {
                  old.errorCode = this.code(error);
                });
            }
          } catch (error) {
            old.errorCode = this.code(error);
            await this.drop(old);
          }
          continue;
        }
        const watcher = (
          this.options.makeWatcher ??
          ((options) => new FolderTriggerWatcher(options))
        )({
          rule,
          journal: this.options.journal,
          signal: this.options.signal,
          getRoot: (bound) => this.root(FolderTriggerRuleSchema.parse(bound)),
          authorize: async () => {
            await this.root(rule);
            return true;
          },
          onError: (code) => {
            if (code === 'FOLDER_TRIGGER_FILE_CHANGED') {
              this.options.onDiagnostic?.(code);
              return;
            }
            entry.ready = false;
            entry.errorCode = code;
          },
        });
        const entry: FolderCoreEntry = {
          rule,
          watcher,
          ready: false,
          errorCode: null,
          task: Promise.resolve(),
          observation: observations.get(key),
        };
        this.entries.set(key, entry);
        entry.task = watcher
          .start()
          .then(() => {
            entry.ready = true;
          })
          .catch((error: unknown) => {
            entry.errorCode = this.code(error);
          });
      }
      await this.observe();
      void this.flush().catch((error: unknown) => {
        this.options.onDiagnostic?.(this.code(error));
      });
    } catch (error) {
      this.disconnected = true;
      if (
        !(error instanceof BridgeClientError) ||
        ![0, 502, 503, 504].includes(error.status)
      )
        await this.pause(error);
      this.options.onDiagnostic?.(this.code(error));
    }
  }
  private async observe(
    signal?: AbortSignal,
    entries: Iterable<FolderCoreEntry> = this.entries.values(),
  ) {
    for (const entry of entries) {
      // Startup/reconcile retain no false listening fact and do not produce
      // a paused/listening flicker on every heartbeat.
      if (!entry.ready && !entry.errorCode) continue;
      const observation = FolderTriggerObservationSchema.parse({
        ruleId: entry.rule.automationId,
        revision: entry.rule.revision,
        status: entry.errorCode
          ? [
              'FOLDER_TRIGGER_ADMISSION_EXPIRED',
              'FOLDER_TRIGGER_PAUSED',
              'FOLDER_TRIGGER_CLOSED',
            ].includes(entry.errorCode)
            ? 'paused'
            : 'error'
          : entry.ready
            ? 'listening'
            : 'paused',
        errorCode: entry.errorCode,
      });
      const digest = JSON.stringify(observation);
      if (entry.observation === digest) continue;
      await this.request({
        path: '/api/v1/bridge/folder-triggers/observations',
        method: 'POST',
        body: observation,
        signal,
      });
      entry.observation = digest;
    }
  }
  flush() {
    if (this.closing) return Promise.resolve();
    this.flushTask ??= this.deliver()
      .catch(async (error: unknown) => {
        await this.connectionFailure(error);
        throw error;
      })
      .finally(() => {
        this.flushTask = null;
      });
    return this.flushTask;
  }
  private async deliver() {
    let remaining = 16;
    for (const entry of this.entries.values()) {
      if (!entry.ready || entry.errorCode) continue;
      await this.root(entry.rule);
      for (const event of await this.options.journal.pendingFolderTriggers(
        entry.rule,
        remaining,
      )) {
        await this.root(entry.rule);
        // Renew performs only pinned root/authority checks, never a survey.
        // Delivery cannot borrow a same-path replacement directory's grant.
        await entry.watcher.renewAdmission(entry.rule);
        const body = FolderTriggerEventSchema.parse(event);
        if (
          body.ruleId !== entry.rule.automationId ||
          body.revision !== entry.rule.revision ||
          body.grantId !== entry.rule.folderGrantId ||
          body.grantVersion !== entry.rule.folderGrantVersion ||
          !folderTriggerMatches(entry.rule, body.path) ||
          body.eventId !== folderTriggerEventId(entry.rule, body)
        ) {
          entry.errorCode = 'FOLDER_TRIGGER_EVENT_INVALID';
          await this.drop(entry);
          throw Error('FOLDER_TRIGGER_EVENT_INVALID');
        }
        const response = z.object({ acceptedEventId: UuidSchema }).parse(
          await this.request({
            path: '/api/v1/bridge/folder-triggers/events',
            method: 'POST',
            body,
          }),
        );
        // The server may dedup to a different event id. Its acknowledgement is
        // authoritative, but the local row to clear is always the original id.
        UuidSchema.parse(response.acceptedEventId);
        await this.root(entry.rule);
        await entry.watcher.renewAdmission(entry.rule);
        await this.options.journal.acknowledgeFolderTrigger(
          entry.rule,
          event.eventId,
        );
        if (--remaining === 0) return;
      }
    }
  }
  async close() {
    if (this.closing) return this.closing;
    this.options.signal.removeEventListener('abort', this.abort);
    this.options.drainSignal?.removeEventListener('abort', this.abort);
    this.closing = (async () => {
      await this.pause(Error('FOLDER_TRIGGER_CLOSED'));
      await this.syncTask;
      await this.flushTask?.catch((error: unknown) => {
        this.options.onDiagnostic?.(this.code(error));
      });
      try {
        const current = await (
          this.options.readCredentials ??
          (async () => credentials(await readConfig()))
        )();
        if (
          current.config.server === this.options.server &&
          current.config.deviceId === this.options.deviceId &&
          current.token === this.options.token
        )
          await this.observe(AbortSignal.timeout(5000));
      } catch (error) {
        // Failed status delivery never turns a physically released observer
        // into an unknown file mutation or clears an event outbox.
        this.options.onDiagnostic?.(this.code(error));
      }
      this.entries.clear();
    })();
    return this.closing;
  }
}

type StartOptions = {
  signal?: AbortSignal;
  /** Stop acquiring work; let already claimed foreground work finish. This
   * is separate from pause/cancel and never aborts a running command. */
  drainSignal?: AbortSignal;
  /** Native update handshake: local initialization precedes acquisition. */
  onReady?: () => Promise<void>;
  onState?: (state: BridgeRuntimeState) => void;
  onNotice?: (
    code:
      | 'BRIDGE_CONNECTED'
      | 'CONNECTION_UNAVAILABLE'
      | 'SANDBOX_UNAVAILABLE'
      | 'WORKSPACE_CHANGED'
      | 'BRIDGE_STOPPED',
  ) => void;
  chooseWorkspace?: () => Promise<string>;
  chooseFile?: (root: string, signal?: AbortSignal) => Promise<string | null>;
};

export async function start(options: StartOptions = {}) {
  while (!options.signal?.aborted && !options.drainSignal?.aborted) {
    const settings = await startSession(options);
    if (!settings) return;
    await applyCapabilitySettings(await readConfig(), settings);
  }
}

async function startSession(
  options: StartOptions,
): Promise<BridgeSettingsCommand | null> {
  // A managed candidate must not bypass interrupted-update startup gating by
  // being invoked as `start` from a terminal instead of by the native host.
  const updateLifecycle = await import('./desktop-update.js');
  await updateLifecycle.assertBridgeUpdateStartup();
  let { config, token } = await credentials(await readConfig());
  let capabilitySettings = await localCapabilitySettings(config);
  let requestedSettings: BridgeSettingsCommand | null = null;
  if (config.paused) {
    config = { ...config, paused: false };
    await writeConfig(config);
  }
  const optedIn = await sandboxOptIn(config).catch(() => {
    console.warn(
      '沙箱设置无效，保持普通文件功能；请运行 sandbox status 检查。',
    );
    return false;
  });
  const operationLedgerEnabled =
    process.env.ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED !== '0';
  const operationModule = operationLedgerEnabled
    ? await import('./operation-client.js')
    : null;
  let transport: BridgeDualTransport | null = null;
  let transportIdentity = '';
  const { ProjectPreviewRelay } = await import('./project-preview-relay.js');
  let projectPreviewRelay: InstanceType<typeof ProjectPreviewRelay> | undefined;
  const currentTransport = () => {
    if (
      !operationLedgerEnabled ||
      process.env.ALLRICE_BRIDGE_WSS_ENABLED === '0'
    )
      return null;
    // Credential/config changes close the old connection instead of borrowing it
    // across devices or tenants. The identity string is never logged/persisted.
    const identity = JSON.stringify([config.server, config.deviceId, token]);
    if (identity !== transportIdentity) {
      transport?.close();
      transport = new BridgeDualTransport({
        server: config.server,
        deviceId: config.deviceId,
        token,
        onPreview: (frame, send) => {
          if (!runner || !journal) {
            void send({
              version: 1,
              type: 'preview.end',
              id: frame.id,
              error: true,
            });
            return;
          }
          projectPreviewRelay ??= new ProjectPreviewRelay(runner, journal);
          projectPreviewRelay.receive(frame, send);
        },
        onPreviewDisconnect: () => projectPreviewRelay?.close(),
      });
      transportIdentity = identity;
    }
    return transport;
  };
  const journal = operationLedgerEnabled
    ? await (
        await import('./journal.js')
      ).BridgeJournal.open({
        directory: journalDirectory(config),
        server: config.server,
        deviceId: config.deviceId,
      })
    : null;
  let stopping = false;
  const commandAbort = new AbortController();
  const sandboxConfig =
    optedIn &&
    process.platform === 'darwin' &&
    ['arm64', 'x64'].includes(process.arch)
      ? nativeSandboxConfig()
      : undefined;
  const pythonRelease = managedPythonPayloadForPlatform(
    `macos-${process.arch}`,
  );
  const managedSandbox =
    operationLedgerEnabled &&
    optedIn &&
    process.platform === 'darwin' &&
    pythonRelease?.nativeSupported
      ? new (await import('./managed-python-sandbox.js')).ManagedPythonSandbox(
          config,
          pythonRelease,
        )
      : undefined;
  const runnerSocket =
    process.env.ALLRICE_LOCAL_DOCKER_SOCKET ??
    managedSandbox?.runner.api.socketPath ??
    sandboxConfig?.socketPath;
  const runnerImage =
    process.env.ALLRICE_LOCAL_COMMAND_IMAGE ?? sandboxConfig?.imageDigest;
  const runnerMcpBinding = { server: config.server, deviceId: config.deviceId };
  const runner =
    operationLedgerEnabled &&
    (process.env.ALLRICE_LOCAL_COMMAND_ENABLED ?? (optedIn ? '1' : '0')) ===
      '1' &&
    process.platform === 'darwin' &&
    ['x64', 'arm64'].includes(process.arch) &&
    runnerSocket &&
    runnerImage
      ? new (await import('./local-command-runner.js')).LocalCommandRunner({
          socketPath: runnerSocket,
          imageDigest: runnerImage,
          ...(managedSandbox && pythonRelease
            ? {
                projectPreparation: {
                  root: `${configPath()}.project-preparation-${config.deviceId}`,
                  pythonImage: pythonRelease.imageId,
                  architecture: pythonRelease.architecture,
                },
              }
            : {}),
          localMcpEnabled: () =>
            import('./local-mcp-settings.js').then((module) =>
              module.localMcpEnabledForBinding(runnerMcpBinding),
            ),
        })
      : undefined;
  let runnerAvailable = false;
  let pythonAvailable = false;
  const pdfRunner =
    operationLedgerEnabled &&
    process.platform === 'darwin' &&
    pdfReadReleaseForPlatform(`macos-${process.arch}`)?.nativeSupported
      ? new (await import('./local-pdf-runner.js')).LocalPdfRunner({
          directory: `${configPath()}.pdf-read-${config.deviceId}`,
        })
      : undefined;
  let pdfAvailable = false;
  let folderRuntimeAvailable = false;
  let folderTriggers: FolderTriggerCore | null = null;
  let pdfProfile: RuntimeLocalPdfProfile | undefined;
  let pdfState: 'ready' | 'preparing' | 'unsupported' = pdfRunner
    ? 'preparing'
    : 'unsupported';
  let pdfReason = pdfRunner
    ? 'runtime_preparing'
    : 'PDF_NATIVE_PLATFORM_UNVERIFIED';
  let lastPdfProbe = 0;
  let pythonProfile: RuntimeLocalPythonProfile | undefined;
  let pythonState: 'ready' | 'preparing' | 'paused' | 'unsupported' =
    managedSandbox ? 'preparing' : optedIn ? 'unsupported' : 'paused';
  let pythonReason = managedSandbox
    ? 'runtime_preparing'
    : optedIn
      ? 'UNSUPPORTED_NATIVE_PLATFORM'
      : 'capability_paused';
  let browserHasActiveWork = () => false;
  let browserHasActiveBrowser = () => false;
  let fileFacts = await probeBridgeFiles(config);
  let browserVersion: string | undefined;
  let runnerProfile:
    Awaited<ReturnType<NonNullable<typeof runner>['preflight']>> | undefined;
  const readinessErrors: Partial<Record<'browser' | 'sandbox', string>> = {};
  const state: BridgeRuntimeState = {
    phase: 'connecting',
    workspaceLabels: config.grants.map((grant) => grant.label),
    activeForeground: 0,
    activeServices: 0,
    pendingReceipts: 0,
    unknownOperations: 0,
    environment: {
      ...initialBridgeEnvironment(),
      settings: capabilitySettings.settings,
      settingsRevision: capabilitySettings.revision,
      development: capabilitySettings.settings.development
        ? 'preparing'
        : 'paused',
    },
  };
  const capabilityReadiness = (phase = state.phase) =>
    projectBridgeCapabilityReadiness({
      environment: state.environment!,
      nativeMac:
        process.platform === 'darwin' &&
        ['arm64', 'x64'].includes(process.arch),
      phase,
      files: fileFacts,
      activeForeground: state.activeForeground,
      activeBrowsers: browserHasActiveBrowser() ? 1 : 0,
      operationLedgerEnabled,
      browserVersion,
      runner: runnerProfile,
      errors: readinessErrors,
      managedPython: {
        state: capabilitySettings.settings.localCommand
          ? pythonState
          : 'paused',
        profile: pythonProfile,
        reason: capabilitySettings.settings.localCommand
          ? pythonReason
          : 'capability_paused',
      },
      managedPdf: { state: pdfState, profile: pdfProfile, reason: pdfReason },
    });
  const publish = () => {
    projectFolderTriggerEnvironment(
      state.environment!,
      folderRuntimeAvailable && Boolean(folderTriggers?.canAdvertise),
      stopping || Boolean(options.drainSignal?.aborted),
    );
    if (
      pdfState === 'ready' &&
      state.environment!.fileDerivationVersion === 1 &&
      !state.environment!.paused
    )
      state.environment!.documentTransformsVersion = 1;
    else delete state.environment!.documentTransformsVersion;
    state.environment!.readiness = capabilityReadiness();
    options.onState?.({
      ...state,
      workspaceLabels: [...state.workspaceLabels],
    });
  };
  const updateFacts = async () => {
    if (journal) {
      const facts = await journal.diagnosticCounts();
      state.pendingReceipts = facts.pendingReceipts;
      state.unknownOperations = facts.unknownOperations;
      state.activeServices = (
        await import('./local-process-manager.js')
      ).activeLocalProcessCount(journal);
    }
    state.activeBrowsers = browserHasActiveBrowser() ? 1 : 0;
    state.workspaceLabels = config.grants.map((grant) => grant.label);
    publish();
  };
  const stop = () => {
    stopping = true;
    state.phase = 'stopping';
    publish();
    commandAbort.abort();
    (transport as BridgeDualTransport | null)?.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  const wait = async (ms: number) => {
    await delay(ms, undefined, { signal: commandAbort.signal }).catch(
      () => undefined,
    );
  };
  folderTriggers = journal
    ? new FolderTriggerCore({
        server: config.server,
        deviceId: config.deviceId,
        token,
        journal,
        signal: commandAbort.signal,
        drainSignal: options.drainSignal,
        available: () => folderRuntimeAvailable && !stopping && runtimeReady,
        onDiagnostic: (code) => {
          if (code === 'FOLDER_TRIGGER_IDENTITY_CHANGED') {
            folderRuntimeAvailable = false;
            publish();
          }
          console.warn(code);
        },
      })
    : null;
  publish();
  console.info(`Rice Bridge ${bridgeVersion} 正在运行：${config.deviceName}`);
  let lastHeartbeatAt = 0;
  let heartbeatInFlight: Promise<void> | null = null;
  const heartbeat = () => {
    heartbeatInFlight ??= (async () => {
      if (folderRuntimeAvailable && !stopping)
        await folderTriggers?.checkScope().catch((error: unknown) => {
          console.warn(readinessErrorCode(error, 'FOLDER_TRIGGER_UNAVAILABLE'));
        });
      capabilitySettings = await localCapabilitySettings(config);
      state.environment!.settings = capabilitySettings.settings;
      state.environment!.settingsRevision = capabilitySettings.revision;
      fileFacts = await probeBridgeFiles(config);
      publish();
      const response = await bridgeRequest<{ settings?: unknown }>({
        server: config.server,
        path: '/api/v1/bridge/device/heartbeat',
        method: 'POST',
        token,
        body: {
          protocolVersion: BridgeProtocolVersion,
          capabilities: BridgeCapabilities,
          environment: {
            ...state.environment,
            readiness: capabilityReadiness('online'),
          },
        },
        timeoutMs: 5000,
      }).catch(async (error: unknown) => {
        await folderTriggers?.connectionFailure(error);
        throw error;
      });
      const next = BridgeSettingsCommandSchema.safeParse(response.settings);
      if (
        !stopping &&
        next.success &&
        next.data.revision > capabilitySettings.revision
      ) {
        requestedSettings = next.data;
        stop();
      }
      lastHeartbeatAt = Date.now();
      if (!stopping) state.phase = 'online';
      options.onNotice?.('BRIDGE_CONNECTED');
      publish();
      if (!stopping && runtimeReady)
        void folderTriggers?.synchronize().catch((error: unknown) => {
          console.warn(readinessErrorCode(error, 'FOLDER_TRIGGER_UNAVAILABLE'));
        });
    })().finally(() => {
      heartbeatInFlight = null;
    });
    return heartbeatInFlight;
  };
  let preparing: Promise<void> | null = null;
  let lastBrowserProbe = 0;
  let lastSandboxResume = 0;
  const prepare = () => {
    if (
      stopping ||
      options.drainSignal?.aborted ||
      commandAbort.signal.aborted ||
      preparing
    )
      return;
    preparing = (async () => {
      const environment = state.environment!;
      // Preparation cannot hold up file operations or the device heartbeat.
      await Promise.all([
        (async () => {
          if (Date.now() - lastBrowserProbe < 60_000) return;
          lastBrowserProbe = Date.now();
          try {
            if (environment.browser !== 'ready') {
              environment.browser = 'preparing';
              publish();
            }
            environment.browser = await prepareBridgeBrowser(
              config,
              commandAbort.signal,
              (version) => {
                browserVersion = version;
              },
            );
            delete readinessErrors.browser;
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === 'LOCAL_BROWSER_CLEANUP_PENDING'
            )
              browserStopUnconfirmed = true;
            environment.browser = 'unavailable';
            readinessErrors.browser = readinessErrorCode(
              error,
              'browser_unavailable',
            );
          }
        })(),
        (async () => {
          runnerAvailable = false;
          if (!runner) {
            environment.sandbox = optedIn ? 'unavailable' : 'paused';
            readinessErrors.sandbox = optedIn
              ? 'sandbox_not_installed'
              : 'capability_paused';
            return;
          }
          try {
            const { profile, reportFailed } =
              await prepareAndReportLocalCommand({
                signal: commandAbort.signal,
                prepare: async () => {
                  if (
                    managedSandbox &&
                    !process.env.ALLRICE_LOCAL_DOCKER_SOCKET
                  ) {
                    await prepareLocalSandbox(
                      managedSandbox,
                      commandAbort.signal,
                    );
                    await managedSandbox.prepareNodeImage(commandAbort.signal);
                  }
                  try {
                    return await runner.preflight(commandAbort.signal);
                  } catch (error) {
                    if (Date.now() - lastSandboxResume < 60_000) throw error;
                    lastSandboxResume = Date.now();
                    environment.sandbox = 'preparing';
                    publish();
                    return prepareLocalSandbox(runner, commandAbort.signal);
                  }
                },
                report: (verified) =>
                  bridgeRequest({
                    server: config.server,
                    path: '/api/v1/bridge/device/runtime-profile',
                    method: 'POST',
                    token,
                    body: { contractVersion: 1, ...verified, available: true },
                    maximumResponseBytes: 4096,
                    timeoutMs: 5000,
                    signal: commandAbort.signal,
                  }),
              });
            if (reportFailed)
              console.warn('LOCAL_COMMAND_PROFILE_REPORT_UNAVAILABLE');
            // A verified local runtime may stay physically ready after a
            // transient report failure, but new commands require the ACK.
            runnerAvailable = !reportFailed;
            runnerProfile = profile;
            delete readinessErrors.sandbox;
            environment.sandbox = 'ready';
          } catch (error) {
            environment.sandbox = 'unavailable';
            readinessErrors.sandbox = readinessErrorCode(
              error,
              'sandbox_unavailable',
            );
            options.onNotice?.('SANDBOX_UNAVAILABLE');
          }
        })(),
        (async () => {
          pdfAvailable = false;
          if (!pdfRunner) return;
          if (!pdfProfile && Date.now() - lastPdfProbe < 60_000) return;
          try {
            lastPdfProbe = Date.now();
            const profile = pdfProfile
              ? await pdfRunner.preflight()
              : await pdfRunner.probe(commandAbort.signal);
            commandAbort.signal.throwIfAborted();
            await bridgeRequest({
              server: config.server,
              path: '/api/v1/bridge/device/runtime-profile',
              method: 'POST',
              token,
              body: profile,
              maximumResponseBytes: 4096,
              timeoutMs: 5000,
              signal: commandAbort.signal,
            });
            pdfProfile = profile;
            pdfAvailable = true;
            pdfState = 'ready';
            pdfReason = 'ready';
          } catch (error) {
            pdfState = 'unsupported';
            pdfReason = readinessErrorCode(error, 'pdf_runtime_unavailable');
          }
          publish();
        })(),
      ]);
      // Same preparation lifecycle; this fixed private VM is separate from
      // the existing Node VM and never inherits business folder mounts.
      if (managedSandbox && capabilitySettings.settings.localCommand) {
        pythonAvailable = false;
        try {
          if (state.activeForeground) {
            if (pythonProfile) {
              await managedSandbox.runner.preflight(commandAbort.signal, false);
              await bridgeRequest({
                server: config.server,
                path: '/api/v1/bridge/device/runtime-profile',
                method: 'POST',
                token,
                body: pythonProfile,
                maximumResponseBytes: 4096,
                timeoutMs: 5000,
                signal: commandAbort.signal,
              });
              pythonAvailable = true;
              pythonState = 'ready';
              pythonReason = 'ready';
            }
          } else {
            if (!pythonProfile) {
              pythonState = 'preparing';
              pythonReason = 'runtime_preparing';
              publish();
            }
            const profile = await prepareLocalSandbox(
              managedSandbox,
              commandAbort.signal,
            );
            commandAbort.signal.throwIfAborted();
            await bridgeRequest({
              server: config.server,
              path: '/api/v1/bridge/device/runtime-profile',
              method: 'POST',
              token,
              body: profile,
              maximumResponseBytes: 4096,
              timeoutMs: 5000,
              signal: commandAbort.signal,
            });
            pythonProfile = profile;
            pythonAvailable = true;
            pythonState = 'ready';
            pythonReason = 'ready';
          }
        } catch (error) {
          pythonState = 'unsupported';
          pythonReason = readinessErrorCode(
            error,
            'managed_python_unavailable',
          );
        }
      }
      environment.preview = await bridgePreviewState(config, environment).catch(
        () => 'unavailable',
      );
      environment.development = capabilitySettings.settings.development
        ? environment.sandbox
        : 'paused';
      if (!stopping && !commandAbort.signal.aborted) {
        publish();
        await heartbeat();
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        preparing = null;
      });
  };
  // Long commands must not make the device look offline. Operation permission
  // renewal is a separate, shorter loop inside the supervised runner.
  const heartbeatTimer = setInterval(() => {
    prepare();
    if (!stopping)
      void heartbeat().catch(() => {
        runnerAvailable = false;
        pythonAvailable = false;
        pdfAvailable = false;
        state.phase = 'offline';
        publish();
      });
  }, 20_000);
  // Browser control is independent of a folder grant or a Linux command VM.
  // Capture this pairing so a later re-pair cannot lend its credentials to an
  // already running browser. Cleanup/outbox/revocations run even with opt-in off.
  const browserIdentity = { server: config.server, deviceId: config.deviceId };
  const browserPaired = async () => {
    try {
      const current = await readConfig();
      return (
        current.server === browserIdentity.server &&
        current.deviceId === browserIdentity.deviceId
      );
    } catch {
      return false;
    }
  };
  let browserTask: Promise<void> | null = null;
  let runtimeReady = false;
  let browserStopUnconfirmed = false;
  let folderStopUnconfirmed = false;
  try {
    const [
      { LocalBrowserController },
      { LocalBrowserHttpAuthority },
      { LocalBrowserProfiles },
      { LocalBrowserOutbox },
      { localBrowserOptIn },
    ] = await Promise.all([
      import('./local-browser-controller.js'),
      import('./local-browser-client.js'),
      import('./local-browser-profiles.js'),
      import('./local-browser-outbox.js'),
      import('./local-browser-settings.js'),
    ]);
    const controller = new LocalBrowserController({
      deviceId: browserIdentity.deviceId,
      authority: new LocalBrowserHttpAuthority({
        server: browserIdentity.server,
        token,
      }),
      profiles: new LocalBrowserProfiles(configPath(), browserIdentity.server),
      outbox: new LocalBrowserOutbox(
        configPath(),
        browserIdentity.server,
        browserIdentity.deviceId,
      ),
      paired: browserPaired,
      preview: runner
        ? {
            runner,
            enabled: async () =>
              (await browserPaired()) &&
              (await sandboxOptIn(config).catch(() => false)) &&
              (await (
                await import('./local-preview-settings.js')
              )
                .localPreviewOptIn(config)
                .catch(() => false)),
          }
        : undefined,
      enabled: async () =>
        runtimeReady &&
        (await browserPaired()) &&
        (await localBrowserOptIn(config).catch(() => false)),
      acquiring: () => runtimeReady && !options.drainSignal?.aborted,
      onError: (code) => {
        if (code === 'LOCAL_BROWSER_CLEANUP_PENDING')
          browserStopUnconfirmed = true;
        console.warn(code);
      },
      onDiagnostic: (stage, code) =>
        console.warn('LOCAL_BROWSER_DIAGNOSTIC', stage, code),
    });
    browserHasActiveWork = () => controller.hasActiveWork;
    browserHasActiveBrowser = () => controller.hasActiveBrowser;
    browserTask = controller.run(commandAbort.signal).catch(() => {
      browserStopUnconfirmed = true;
      console.warn('LOCAL_BROWSER_CLEANUP_PENDING');
    });
  } catch {
    console.warn('LOCAL_BROWSER_UNAVAILABLE');
  }
  let reconnectDelayMs = 1_000;
  try {
    folderRuntimeAvailable = await probeFolderTriggerRuntime({
      journal,
      directory: journalDirectory(config),
      signal: commandAbort.signal,
    }).catch((error: unknown) => {
      console.warn(readinessErrorCode(error, 'FOLDER_TRIGGER_UNAVAILABLE'));
      return false;
    });
    if (options.onReady) await options.onReady();
    else await updateLifecycle.acknowledgeBridgeUpdateReadiness(options.signal);
    runtimeReady = true;
    prepare();
    while (!stopping) {
      if (options.drainSignal?.aborted) {
        await folderTriggers?.close();
        // Facts must be readable. A failed delivery alone is not failed stop;
        // known durable receipts can remain queued across the update.
        await updateFacts();
        if (browserStopUnconfirmed) throw Error('UPDATE_DRAIN_UNCONFIRMED');
        if (!state.activeServices && !browserHasActiveWork()) break;
        // Existing services retain their own bounded leases/cancellation path.
        await wait(250);
        continue;
      }
      try {
        if (Date.now() - lastHeartbeatAt >= 30_000) {
          await heartbeat();
        }
        const selection = await bridgeRequest<{ request: unknown }>({
          server: config.server,
          path: '/api/v1/bridge/device/workspace-selections/next',
          method: 'POST',
          token,
          signal: commandAbort.signal,
        });
        if (stopping) break;
        if (selection.request) {
          await completeWorkspaceSelection(
            config,
            token,
            BridgeWorkspaceSelectionRequestSchema.parse(selection.request),
            options.chooseWorkspace,
            journal
              ? async () =>
                  (
                    await import('./local-process-manager.js')
                  ).stopLocalProcesses(journal)
              : undefined,
          );
          ({ config, token } = await credentials(await readConfig()));
          await folderTriggers?.checkScope().catch(() => undefined);
          options.onNotice?.('WORKSPACE_CHANGED');
          await updateFacts();
          reconnectDelayMs = 1_000;
          continue;
        }
        if (operationModule && journal) {
          ({ config, token } = await credentials(await readConfig()));
          await folderTriggers?.checkScope().catch(() => undefined);
          const worked = await new operationModule.RuntimeBridgeOperationClient(
            {
              config,
              token,
              journal,
              chooseFile: options.chooseFile ?? chooseLocalFile,
              runner: runnerAvailable ? runner : undefined,
              pythonRunner: pythonAvailable
                ? managedSandbox?.runner
                : undefined,
              pdfRunner: pdfAvailable ? pdfRunner : undefined,
              signal: commandAbort.signal,
              acquiring: () => !options.drainSignal?.aborted,
              request: currentTransport()?.request,
              onActivity: (active) => {
                state.activeForeground = active ? 1 : 0;
                publish();
              },
            },
          )
            .pollOnce()
            .catch((error: unknown) => {
              // A server-side rollback must not break the legacy file queue.
              // Retain the journal/outbox; never reinterpret a rejected command.
              if (
                error instanceof BridgeClientError &&
                error.status === 404 &&
                error.message === 'FEATURE_DISABLED'
              )
                return false;
              throw error;
            })
            .finally(async () => {
              state.activeForeground = 0;
              await updateFacts();
            });
          reconnectDelayMs = 1_000;
          if (worked) continue;
          // Existing file/git tools still use the legacy queue in P05. Keep
          // draining it when the opt-in operation queue is idle; the legacy
          // schema can never authorize the new process capability.
        }
        if (options.drainSignal?.aborted) continue;
        const response = await bridgeRequest<{ command: unknown }>({
          server: config.server,
          path: '/api/v1/bridge/device/commands/next',
          method: 'POST',
          token,
          signal: commandAbort.signal,
        });
        if (stopping) break;
        if (response.command) {
          // A folder granted from another terminal should become available
          // without requiring the long-running Bridge process to restart.
          ({ config, token } = await credentials(await readConfig()));
          await folderTriggers?.checkScope().catch(() => undefined);
          state.activeForeground = 1;
          publish();
          const command = BridgeCommandSchema.parse(response.command);
          if (command.payload.capability.startsWith('local.file.')) {
            if (!journal) throw Error('LOCAL_FILE_JOURNAL_UNAVAILABLE');
            await completeLocalFileCommand(
              config,
              token,
              command,
              journal,
              options,
              commandAbort.signal,
            );
          } else await complete(config, token, command);
          state.activeForeground = 0;
          await updateFacts();
        } else {
          const channel = currentTransport();
          if (channel) await channel.waitForWork(750);
          else await wait(750);
        }
        reconnectDelayMs = 1_000;
      } catch (error) {
        if (stopping) break;
        if (options.drainSignal?.aborted) continue;
        state.phase = 'offline';
        options.onNotice?.('CONNECTION_UNAVAILABLE');
        publish();
        console.error(
          `Bridge 暂时断开，${Math.ceil(reconnectDelayMs / 1_000)} 秒后重试：${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
        await wait(reconnectDelayMs);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
        lastHeartbeatAt = 0;
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
    commandAbort.abort();
    await browserTask;
    await preparing;
    await (heartbeatInFlight as Promise<void> | null)?.catch(() => undefined);
    await folderTriggers?.close().catch(() => {
      folderStopUnconfirmed = true;
      console.warn('FOLDER_TRIGGER_STOP_UNCONFIRMED');
    });
    state.environment = initialBridgeEnvironment(true);
    await heartbeat().catch(() => undefined);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    options.signal?.removeEventListener('abort', stop);
    (transport as BridgeDualTransport | null)?.close();
    await (heartbeatInFlight as Promise<void> | null)?.catch(() => undefined);
    if (journal)
      await (
        await import('./local-process-manager.js')
      ).stopLocalProcesses(journal);
    await managedSandbox?.stop();
    if (journal) {
      const flushSignal = AbortSignal.timeout(5000);
      await new (
        await import('./operation-client.js')
      ).RuntimeBridgeOperationClient({
        config,
        token,
        journal,
        pdfRunner,
        request: (input) =>
          bridgeRequest({
            ...input,
            signal: flushSignal,
            timeoutMs: Math.min(input.timeoutMs ?? 2500, 2500),
          }),
      })
        .flush()
        .catch(() => undefined);
      await updateFacts().catch(() => undefined);
    }
    if (!folderStopUnconfirmed) await journal?.close();
    state.phase =
      browserStopUnconfirmed || folderStopUnconfirmed ? 'stopping' : 'stopped';
    state.activeForeground = 0;
    state.activeServices = 0;
    if (!browserStopUnconfirmed && !folderStopUnconfirmed)
      options.onNotice?.('BRIDGE_STOPPED');
    publish();
  }
  if (browserStopUnconfirmed) throw Error('LOCAL_BROWSER_CLEANUP_PENDING');
  if (folderStopUnconfirmed) throw Error('FOLDER_TRIGGER_STOP_UNCONFIRMED');
  console.info('Rice Bridge 已停止');
  return requestedSettings;
}

export async function hasStoredPairing() {
  let config: BridgeConfig;
  try {
    config = await readConfig();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw Error('本机配对配置无法读取，请保留原文件并检查诊断，不要重新配对。');
  }
  if (!config || typeof config.deviceId !== 'string' || !config.deviceId) {
    throw Error('本机配对配置无效，请保留原文件并检查诊断，不要重新配对。');
  }
  try {
    await readDeviceToken(config.deviceId);
    return true;
  } catch {
    // A temporarily inaccessible credential is not a new installation. Never
    // consume another pairing code or replace the existing identity here.
    throw Error(
      '本机已有配对，但凭证暂不可读。请检查钥匙串或凭证文件权限，不要重新配对或删除配置。',
    );
  }
}

async function promptPairingCode(message: string) {
  if (platform() !== 'darwin') {
    throw new Error('Rice Bridge 首次配对仅支持 macOS');
  }
  try {
    const result = await execFileAsync('/usr/bin/osascript', [
      '-e',
      'on run argv',
      '-e',
      'set dialogResult to display dialog (item 1 of argv) default answer "" with title "Rice Bridge 首次配对" buttons {"取消", "配对并启动"} default button "配对并启动" cancel button "取消"',
      '-e',
      'return text returned of dialogResult',
      '-e',
      'end run',
      message,
    ]);
    return result.stdout.trim();
  } catch {
    return null;
  }
}

export async function launch() {
  if (!(await hasStoredPairing())) {
    let message =
      '这是第一次打开 Rice Bridge。\n\n请在 AllRice 页面生成配对码，并在下方输入。配对成功后，本机会安全保存授权，以后直接打开即可自动连接。';
    while (true) {
      const input = await promptPairingCode(message);
      if (input === null) {
        console.info('已取消 Rice Bridge 配对');
        return;
      }
      try {
        const code = normalizedPairingCode(input);
        await pair(['--server', defaultBridgeServer, '--code', code]);
        break;
      } catch (error) {
        message = `配对失败：${
          error instanceof Error ? error.message : '未知错误'
        }\n\n请确认配对码仍在 10 分钟有效期内，然后重新输入。`;
      }
    }
  }
  if ((await readConfig()).paused) {
    console.info('Rice Bridge 已暂停，可从菜单恢复连接。');
    return;
  }
  await start();
}

export async function revoke() {
  const { config, token } = await credentials(await readConfig());
  await bridgeRequest({
    server: config.server,
    path: '/api/v1/bridge/device/revoke',
    method: 'POST',
    token,
  });
  // Desktop halts first; standalone revoke owns the exclusive instance lock.
  // The private browser index covers inactive opt-in login state as well.
  let browserCleanupComplete = false;
  try {
    const { LocalBrowserProfiles } =
      await import('./local-browser-profiles.js');
    await new LocalBrowserProfiles(configPath(), config.server).revokeDevice(
      config.deviceId,
    );
    browserCleanupComplete = true;
  } catch {
    console.warn('LOCAL_BROWSER_CLEANUP_PENDING');
  }
  const credentialCleanup = await deleteDeviceToken(config.deviceId);
  const configDeleted = browserCleanupComplete && (await deleteConfig());
  const cleanupComplete =
    browserCleanupComplete && credentialCleanup.complete && configDeleted;
  if (cleanupComplete) console.info('Rice Bridge 设备授权已撤销');
  else
    console.warn(
      'Rice Bridge 服务端授权已撤销，但本机凭证清理未完成。请保留诊断记录；不要使用已失效的令牌重试撤销，也不要把此结果当作所有本机凭证均已删除。',
    );
  return {
    serverRevoked: true as const,
    cleanupComplete,
    configDeleted,
    credentialCleanup,
  };
}

export function help() {
  console.info(
    `Rice Bridge ${bridgeVersion}\n\n直接打开 RiceBridge：首次输入配对码，之后自动连接。\n\nCommands:\n  pair --server URL --code XXXX-XXXX [--name NAME]\n  grant PATH [--name NAME]\n  start\n  status\n  sandbox status|enable|disable\n  local-mcp status|enable|disable\n  local-mcp --help\n  --version\n  revoke\n\n配对后自动准备已有独立沙箱；通用计算可由云端承接。选择目录后即可使用文件功能，修改与命令在任务内批准。`,
  );
  console.info(
    '  browser status|enable|disable\n配对后自动准备独立浏览器，不需要再次去网页授权；不读取日常 Chrome 登录资料。敏感动作在任务内确认。',
  );
  console.info(
    '  preview status|enable|disable\n项目预览随本地环境自动准备，运行项目服务时在任务内批准；不开放本机端口或公共网址。',
  );
}

export async function sandbox(args: string[]) {
  const action = args[0] ?? 'status';
  if (!['status', 'enable', 'disable'].includes(action))
    throw Error('sandbox status|enable|disable');
  if (action === 'disable') {
    await saveSandboxOptIn(await readConfig(), false);
    console.info('已关闭本地沙箱设置，请退出并重新打开 Bridge 生效。');
    return;
  }
  const runner = new (
    await import('./local-command-runner.js')
  ).LocalCommandRunner(nativeSandboxConfig());
  const profile = await runner.preflight();
  console.info(
    `本地 Linux 沙箱可用：${profile.architecture} · 固定 Node 工具链；不等于服务端已授权执行。`,
  );
  if (action === 'enable') {
    const { config, token } = await credentials(await readConfig());
    // Fail closed before persisting opt-in if this tenant/server has not enabled it.
    await bridgeRequest({
      server: config.server,
      path: '/api/v1/bridge/device/runtime-profile',
      method: 'POST',
      token,
      body: { contractVersion: 1, ...profile, available: true },
      maximumResponseBytes: 4096,
      timeoutMs: 5000,
    });
    await saveSandboxOptIn(config, true);
    console.info(
      '已保存本机沙箱设置；退出并重新打开 Bridge 后生效。命令仍需工作区授权、员工权限和网页单次审批。',
    );
  }
}
