import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  BridgeCapabilities,
  BridgeCapabilityReadinessListSchema,
  type BridgeCapabilityReadiness,
  type BridgeEnvironment,
  type BridgeReadinessCapability,
  type BridgeReadinessState,
  type RuntimeLocalPythonProfile,
} from '@allrice/contracts';
import type { BridgeConfig } from './config.js';

/** Probe only the already granted roots and installed git. No scanning or writes. */
export async function probeBridgeFiles(config: BridgeConfig) {
  const roots = await Promise.all(
    config.grants.map(async (grant) => {
      try {
        const root = await realpath(grant.rootPath);
        if (
          createHash('sha256').update(root).digest('hex') !==
            grant.rootFingerprint ||
          !(await stat(root)).isDirectory()
        )
          return { read: false, write: false };
        const read = await access(root, constants.R_OK | constants.X_OK).then(
          () => true,
          () => false,
        );
        const write = await access(root, constants.W_OK | constants.X_OK).then(
          () => true,
          () => false,
        );
        return { read, write };
      } catch {
        return { read: false, write: false };
      }
    }),
  );
  let gitVersion: string | undefined;
  try {
    const { stdout } = await promisify(execFile)('git', ['--version'], {
      timeout: 3000,
      maxBuffer: 4096,
    });
    gitVersion = /^git version ([\w.+-]+)(?: |$)/.exec(stdout.trim())?.[1];
  } catch {
    /* An installed Bridge does not imply git is installed. */
  }
  return {
    folder: roots.some((root) => root.read),
    writable: roots.some((root) => root.write),
    folderReason: config.grants.length
      ? 'folder_unavailable'
      : 'folder_missing',
    gitVersion,
  };
}

export type BridgeFileFacts = Awaited<ReturnType<typeof probeBridgeFiles>>;

/** Projection over existing probes/settings/journal, never another state machine. */
export function projectBridgeCapabilityReadiness(input: {
  environment: BridgeEnvironment;
  nativeMac: boolean;
  phase: string;
  files: BridgeFileFacts;
  activeForeground: number;
  activeBrowsers: number;
  operationLedgerEnabled: boolean;
  browserVersion?: string;
  runner?: {
    backend: string;
    imageDigest: string;
    architecture: string;
    features?: string[];
  };
  errors?: Partial<Record<'browser' | 'sandbox', string>>;
  managedPython?: {
    state: 'ready' | 'preparing' | 'paused' | 'unsupported';
    profile?: RuntimeLocalPythonProfile;
    reason?: string;
  };
  observedAt?: string;
}) {
  const env = input.environment,
    reports: BridgeCapabilityReadiness[] = [];
  const versions = { bridge: env.clientVersion, node: process.versions.node };
  const add = (
    capability: BridgeReadinessCapability,
    state: BridgeReadinessState,
    reason: string,
    missing: string[] = [],
    extra: Record<string, string> = {},
  ) => {
    const absentImplementation = !input.nativeMac;
    if (
      !absentImplementation &&
      (env.paused || input.phase === 'stopping' || input.phase === 'stopped')
    ) {
      state = 'paused';
      reason = 'device_paused';
    } else if (!absentImplementation && input.phase === 'offline') {
      state = 'offline';
      reason = 'bridge_offline';
    }
    reports.push({
      capability,
      state,
      reason,
      missing,
      versions: { ...versions, ...extra },
      observedAt: input.observedAt ?? new Date().toISOString(),
    });
  };
  for (const capability of BridgeCapabilities) {
    if (capability === 'local.python.execute') continue;
    const write =
      capability === 'local.fs.write' ||
      capability === 'local.fs.mkdir' ||
      capability === 'local.file.save';
    const git = capability.startsWith('local.git.');
    const missing =
      (write || capability.startsWith('local.file.')) &&
      !input.operationLedgerEnabled
        ? ['operation_ledger_disabled']
        : !input.files.folder
          ? [input.files.folderReason]
          : write && !input.files.writable
            ? ['folder_read_only']
            : git && !input.files.gitVersion
              ? ['git_missing']
              : [];
    add(
      capability,
      !input.nativeMac || missing.length
        ? 'unsupported'
        : input.activeForeground
          ? 'busy'
          : 'ready',
      !input.nativeMac
        ? 'platform_unsupported'
        : (missing[0] ?? (input.activeForeground ? 'local_busy' : 'ready')),
      missing,
      {
        ...(git && input.files.gitVersion
          ? { git: input.files.gitVersion }
          : {}),
        ...(capability.startsWith('local.file.') ? { binaryFiles: '1' } : {}),
      },
    );
  }
  const runtime = (
    capability: BridgeReadinessCapability,
    kind: 'browser' | 'sandbox' | 'preview' | 'development',
    paused: boolean,
    extra: Record<string, string>,
    needsFolder = false,
  ) => {
    const condition = env[kind] ?? 'unavailable';
    const missing =
      needsFolder && !input.files.folder ? [input.files.folderReason] : [];
    const reason = !input.nativeMac
      ? 'platform_unsupported'
      : paused || condition === 'paused'
        ? 'capability_paused'
        : condition === 'preparing'
          ? 'runtime_preparing'
          : condition === 'unavailable'
            ? (input.errors?.[kind === 'browser' ? 'browser' : 'sandbox'] ??
              `${kind}_unavailable`)
            : (missing[0] ?? 'ready');
    const state: BridgeReadinessState = !input.nativeMac
      ? 'unsupported'
      : paused || condition === 'paused'
        ? 'paused'
        : condition === 'preparing'
          ? 'preparing'
          : condition === 'unavailable' || missing.length
            ? 'unsupported'
            : (
                  kind === 'browser'
                    ? input.activeBrowsers
                    : input.activeForeground
                )
              ? 'busy'
              : 'ready';
    add(
      capability,
      state,
      state === 'busy' ? 'local_busy' : reason,
      condition === 'unavailable' ? [reason] : missing,
      extra,
    );
  };
  const runnerVersions: Record<string, string> = input.runner
    ? {
        backend: input.runner.backend,
        image: input.runner.imageDigest,
        architecture: input.runner.architecture,
      }
    : {};
  runtime(
    'local.browser',
    'browser',
    env.settings?.localBrowser === false,
    input.browserVersion ? { chromium: input.browserVersion } : {},
  );
  runtime(
    'local.process',
    'sandbox',
    env.settings?.localCommand === false,
    runnerVersions,
    true,
  );
  runtime(
    'local.development',
    'development',
    env.settings?.development === false || env.settings?.localCommand === false,
    runnerVersions,
    true,
  );
  runtime('local.preview', 'preview', false, runnerVersions, true);
  if (input.runner?.features?.includes('local_mcp'))
    runtime(
      'local.mcp',
      'sandbox',
      env.settings?.localCommand === false,
      runnerVersions,
      true,
    );
  else
    add(
      'local.mcp',
      'unsupported',
      'local_mcp_disabled',
      ['local_mcp_runtime'],
      runnerVersions,
    );
  const managed = input.managedPython,
    profile = managed?.profile;
  const pythonVersions: Record<string, string> = profile
    ? {
        backend: profile.backend,
        image: profile.imageId,
        architecture: profile.architecture,
        python: profile.pythonVersion,
        profile: String(profile.profileVersion),
        packages: profile.packagesChecksum,
        officeChecker: profile.officeCheckerChecksum,
        pngChecker: profile.pngCheckerChecksum,
        font: profile.fontChecksum,
      }
    : {};
  for (const capability of ['local.office', 'local.python'] as const) {
    const state =
      managed?.state === 'ready' && input.activeForeground
        ? 'busy'
        : (managed?.state ?? 'unsupported');
    const reason =
      state === 'busy'
        ? 'local_busy'
        : (managed?.reason ??
          (state === 'ready'
            ? 'ready'
            : state === 'preparing'
              ? 'runtime_preparing'
              : state === 'paused'
                ? 'capability_paused'
                : 'office_not_implemented'));
    add(
      capability,
      state,
      reason,
      state === 'unsupported' ? [reason] : [],
      pythonVersions,
    );
  }
  add(
    'local.office.formulas',
    'unsupported',
    'office_formula_runtime_not_prepared',
    ['formula_runtime'],
    pythonVersions,
  );
  add(
    'local.office.preview',
    'unsupported',
    'office_preview_runtime_not_prepared',
    ['render_runtime'],
    pythonVersions,
  );
  return BridgeCapabilityReadinessListSchema.parse(reports);
}

/** Never send raw exception messages: they may include local paths or arguments. */
export function readinessErrorCode(error: unknown, fallback: string) {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? error.code
      : error instanceof Error
        ? error.message
        : null;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_.-]{0,119}$/.test(code)
    ? code
    : fallback;
}
