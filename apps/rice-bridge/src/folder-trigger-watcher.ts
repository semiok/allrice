import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  LocalFilePathSchema,
  LocalFileVersionSchema,
  UuidSchema,
  canonicalRuntimeBridgeJson,
  type LocalFileVersion,
} from '@allrice/contracts';
import { executeFileSurvey } from './file-survey.js';
import { readNativeFileBytes } from './native-file-reader.js';
import type { FileGuardianControls } from './file-guardian.js';

export const folderTriggerMaximumFiles = 2_000;
export const folderTriggerMaximumSnapshotBytes = 1_000_000;
export const folderTriggerStabilityMs = 2_000;
const directoryPath = z.union([z.literal('.'), LocalFilePathSchema]);
export const FolderTriggerRuleSchema = z
  .object({
    automationId: UuidSchema,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    deviceId: UuidSchema,
    folderGrantId: UuidSchema,
    folderGrantVersion: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    relativePath: directoryPath,
    extensions: z
      .array(z.string().regex(/^[a-z0-9]{1,16}$/))
      .min(1)
      .max(16),
    ignorePaths: z.array(LocalFilePathSchema).max(32),
    admissionExpiresAt: z.iso.datetime(),
  })
  .strict();
export type FolderTriggerRule = z.infer<typeof FolderTriggerRuleSchema>;
export const FolderTriggerRootIdentitySchema = z
  .object({
    path: z.string().min(1).max(4_096),
    dev: z.number().int().safe(),
    ino: z.number().int().safe(),
    directoryDev: z.number().int().safe(),
    directoryIno: z.number().int().safe(),
  })
  .strict();
export type FolderTriggerRootIdentity = z.infer<
  typeof FolderTriggerRootIdentitySchema
>;
export const FolderTriggerFileSchema = z
  .object({ path: LocalFilePathSchema, expected: LocalFileVersionSchema })
  .strict();
export type FolderTriggerFile = z.infer<typeof FolderTriggerFileSchema>;
export const FolderTriggerScanSchema = z
  .object({
    files: z.array(FolderTriggerFileSchema).max(folderTriggerMaximumFiles),
    complete: z.boolean(),
    truncated: z.boolean(),
  })
  .strict();
export type FolderTriggerScan = z.infer<typeof FolderTriggerScanSchema>;
export const FolderTriggerEventSchema = z
  .object({
    eventId: UuidSchema,
    ruleId: UuidSchema,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    grantId: UuidSchema,
    grantVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    path: LocalFilePathSchema,
    expected: LocalFileVersionSchema,
    observedAt: z.iso.datetime(),
  })
  .strict();
export type FolderTriggerEvent = z.infer<typeof FolderTriggerEventSchema>;
export type FolderTriggerSnapshot = {
  root: FolderTriggerRootIdentity;
  baselineComplete: boolean;
  files: FolderTriggerFile[];
};
export interface FolderTriggerJournal {
  assertWorkspace?(root: string): void;
  folderTriggerSnapshot(
    rule: FolderTriggerRule,
  ): Promise<FolderTriggerSnapshot | null>;
  commitFolderTriggerSnapshot(
    rule: FolderTriggerRule,
    root: FolderTriggerRootIdentity,
    scan: FolderTriggerScan,
    observedAt: string,
  ): Promise<FolderTriggerEvent[]>;
  recordFolderTrigger(
    rule: FolderTriggerRule,
    root: FolderTriggerRootIdentity,
    path: string,
    expected: LocalFileVersion,
    observedAt: string,
  ): Promise<FolderTriggerEvent | null>;
  forgetFolderTriggerPath(
    rule: FolderTriggerRule,
    root: FolderTriggerRootIdentity,
    path: string,
  ): Promise<void>;
}

const digest = (value: unknown) =>
  createHash('sha256').update(canonicalRuntimeBridgeJson(value)).digest('hex');
export function folderTriggerRuleKey(input: FolderTriggerRule) {
  const rule = FolderTriggerRuleSchema.parse(input);
  return digest([
    rule.automationId,
    rule.revision,
    rule.deviceId,
    rule.folderGrantId,
    rule.folderGrantVersion,
  ]);
}
export function normalizeFolderTriggerRule(input: FolderTriggerRule) {
  const rule = FolderTriggerRuleSchema.parse(input);
  return {
    ...rule,
    extensions: [...new Set(rule.extensions)].sort(),
    ignorePaths: [...new Set(rule.ignorePaths)].sort(),
  };
}
export function folderTriggerRuleFingerprint(input: FolderTriggerRule) {
  const rule = normalizeFolderTriggerRule(input);
  return digest({
    scope: folderTriggerRuleKey(rule),
    relativePath: rule.relativePath,
    extensions: rule.extensions,
    ignorePaths: rule.ignorePaths,
  });
}
/** A stable UUID is an idempotency reference, never an authorization token. */
export function folderTriggerEventId(
  rule: FolderTriggerRule,
  file: FolderTriggerFile,
) {
  const hex = digest([folderTriggerRuleKey(rule), file.path, file.expected]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export class FolderTriggerError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const blockedNames = new Set([
  '.git',
  '.ssh',
  '.aws',
  '.gnupg',
  '.codex',
  '.kube',
  '.azure',
  '.docker',
  '.config',
  '.cache',
  '.npm',
  '.yarn',
  '.pnpm-store',
  'cache',
  'caches',
  'node_modules',
  '.next',
  'dist',
  'build',
  '__pycache__',
  '.venv',
  'venv',
  '.secrets',
  'secrets',
  'secret',
  '.npmrc',
  '.netrc',
  'id_rsa',
  'id_ed25519',
  'credentials',
  'credentials.json',
  '.ds_store',
]);
export function folderTriggerIgnores(rule: FolderTriggerRule, path: string) {
  const lower = path.normalize('NFC').toLowerCase();
  return (
    lower
      .split('/')
      .some(
        (part) =>
          blockedNames.has(part) ||
          part === '.env' ||
          part.startsWith('.env.') ||
          part.startsWith('.allrice-') ||
          part.startsWith('~$') ||
          /\.(?:part|tmp|swp|swo|crdownload|pem|key|p12)$/.test(part),
      ) ||
    rule.ignorePaths.some((ignored) => {
      const value = ignored.normalize('NFC').toLowerCase();
      return lower === value || lower.startsWith(value + '/');
    })
  );
}
export function folderTriggerMatches(rule: FolderTriggerRule, path: string) {
  return (
    LocalFilePathSchema.safeParse(path).success &&
    (rule.relativePath === '.' || path.startsWith(rule.relativePath + '/')) &&
    !folderTriggerIgnores(rule, path) &&
    rule.extensions.includes(posix.extname(path).slice(1).toLowerCase())
  );
}

export type FolderTriggerWatcherHandle = {
  ready: Promise<void>;
  close(): Promise<void>;
};
export type FolderTriggerWatcherFactory = (
  directory: string,
  options: {
    cwd: string;
    depth: number;
    ignored(path: string, metadata?: Stats): boolean;
    awaitWriteFinish: { stabilityThreshold: number; pollInterval: number };
    atomic: boolean;
    onChange(kind: 'add' | 'change' | 'unlink', path: string): void;
    onError(error: unknown): void;
  },
) => Promise<FolderTriggerWatcherHandle>;
export const createFolderTriggerWatcher: FolderTriggerWatcherFactory = async (
  directory,
  options,
) => {
  const { watch } = await import('chokidar');
  const watched = new Set<string>();
  const key = (path: string) =>
    isAbsolute(path) ? relative(options.cwd, path) : path;
  const watcher = watch(directory, {
    cwd: options.cwd,
    depth: options.depth,
    ignored: (path, metadata) => {
      if (options.ignored(path, metadata)) return true;
      if (metadata && !watched.has(key(path))) {
        if (watched.size >= folderTriggerMaximumFiles + 1) {
          options.onError(new FolderTriggerError('FOLDER_TRIGGER_WATCH_LIMIT'));
          return true;
        }
        watched.add(key(path));
      }
      return false;
    },
    awaitWriteFinish: options.awaitWriteFinish,
    atomic: options.atomic,
    ignoreInitial: true,
    followSymlinks: false,
    usePolling: false,
  });
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    watcher.once('ready', resolveReady);
    watcher.once('error', rejectReady);
  });
  // Own the rejection even if close/abort happens before start awaits readiness.
  void ready.catch(() => undefined);
  for (const kind of ['add', 'change', 'unlink'] as const)
    watcher.on(kind, (path) => {
      if (kind === 'unlink') watched.delete(key(path));
      options.onChange(kind, path);
    });
  watcher.on('unlinkDir', (path) => {
    const prefix = key(path);
    for (const path of watched)
      if (path === prefix || path.startsWith(prefix + '/'))
        watched.delete(path);
    options.onChange('unlink', path);
  });
  watcher.on('error', options.onError);
  return { ready, close: () => watcher.close() };
};
const mediaTypes: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
async function survey(
  root: string,
  path: string,
  controls: FileGuardianControls,
) {
  return (
    await executeFileSurvey(
      root,
      path,
      {
        mode: 'files',
        hash: true,
        maximumEntries: folderTriggerMaximumFiles,
        maximumHashBytes: 128_000_000,
      },
      controls,
    )
  ).output;
}
/** Node supplies metadata only; the sealed primitive checks actual original bytes. */
async function verifySurveyFile(
  root: string,
  path: string,
  checksum: string,
  sizeBytes: number,
  controls: FileGuardianControls,
) {
  const metadata = await lstat(resolve(root, path));
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== sizeBytes)
    throw new FolderTriggerError('FOLDER_TRIGGER_FILE_CHANGED');
  const expected = LocalFileVersionSchema.parse({
    checksum,
    sizeBytes,
    version: `sha256:${createHash('sha256')
      .update(
        JSON.stringify([
          path,
          metadata.dev,
          metadata.ino,
          metadata.size,
          metadata.mtimeMs,
          metadata.ctimeMs,
          checksum,
        ]),
      )
      .digest('hex')}`,
    mediaType:
      mediaTypes[posix.extname(path).slice(1).toLowerCase()] ??
      'application/octet-stream',
  });
  await readNativeFileBytes(root, path, expected, controls);
  return expected;
}
async function scanNative(
  root: string,
  rule: FolderTriggerRule,
  controls: FileGuardianControls,
): Promise<FolderTriggerScan> {
  const result = await survey(root, rule.relativePath, controls);
  const files: FolderTriggerFile[] = [];
  let complete =
    !result.truncated &&
    result.skipped.every((file) => folderTriggerIgnores(rule, file.path));
  for (const file of result.files) {
    if (!folderTriggerMatches(rule, file.path)) continue;
    if (!file.checksum) {
      complete = false;
      continue;
    }
    try {
      files.push({
        path: file.path,
        expected: await verifySurveyFile(
          root,
          file.path,
          file.checksum,
          file.sizeBytes,
          controls,
        ),
      });
    } catch (error) {
      if (controls.signal?.aborted) throw error;
      complete = false;
    }
  }
  return { files, complete, truncated: result.truncated };
}
async function inspectNative(
  root: string,
  path: string,
  controls: FileGuardianControls,
): Promise<LocalFileVersion | null> {
  const result = await survey(root, posix.dirname(path), controls).catch(
    (error: unknown) => {
      if (
        error instanceof Error &&
        'code' in error &&
        ['ENOENT', 'FILE_NOT_FOUND'].includes(String(error.code))
      )
        return null;
      throw error;
    },
  );
  if (!result) return null;
  const file = result.files.find((file) => file.path === path);
  if (!file?.checksum) {
    if (result.truncated || result.skipped.some((file) => file.path === path))
      throw new FolderTriggerError('FOLDER_TRIGGER_SCAN_INCOMPLETE');
    return null;
  }
  return verifySurveyFile(root, path, file.checksum, file.sizeBytes, controls);
}
export type FolderTriggerWatcherOptions = {
  rule: FolderTriggerRule;
  journal: FolderTriggerJournal;
  getRoot(rule: FolderTriggerRule): Promise<string | null>;
  authorize?: () => Promise<boolean>;
  watcherFactory?: FolderTriggerWatcherFactory;
  scan?: typeof scanNative;
  inspect?: typeof inspectNative;
  settle?: (signal: AbortSignal) => Promise<void>;
  onError?: (code: string) => void;
  now?: () => number;
  signal?: AbortSignal;
};

export class FolderTriggerWatcher {
  private rule: FolderTriggerRule;
  private root: FolderTriggerRootIdentity | null = null;
  private handle: FolderTriggerWatcherHandle | null = null;
  private controller = new AbortController();
  private tail = Promise.resolve();
  private paths = new Map<string, { dirty: boolean }>();
  private closing: Promise<void> | null = null;
  private started = false;
  private active = false;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private readonly abort = () => {
    void this.close().catch(() =>
      this.options.onError?.('FOLDER_TRIGGER_STOP_UNCONFIRMED'),
    );
  };
  constructor(private readonly options: FolderTriggerWatcherOptions) {
    this.rule = normalizeFolderTriggerRule(options.rule);
    options.signal?.addEventListener('abort', this.abort, { once: true });
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private code(error: unknown) {
    return error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
      ? error.code
      : 'FOLDER_TRIGGER_UNAVAILABLE';
  }
  private controls(): FileGuardianControls {
    return {
      signal: this.controller.signal,
      authorize: async () => {
        await this.check();
        return true;
      },
    };
  }
  private async check() {
    if (this.controller.signal.aborted || this.options.signal?.aborted)
      throw new FolderTriggerError('FOLDER_TRIGGER_CLOSED');
    if (Date.parse(this.rule.admissionExpiresAt) <= this.now())
      throw new FolderTriggerError('FOLDER_TRIGGER_ADMISSION_EXPIRED');
    if (this.options.authorize && !(await this.options.authorize()))
      throw new FolderTriggerError('FOLDER_TRIGGER_SCOPE_REVOKED');
    const path = await this.options.getRoot(structuredClone(this.rule));
    if (!path || !isAbsolute(path) || (await realpath(path)) !== path)
      throw new FolderTriggerError('FOLDER_TRIGGER_ROOT_CHANGED');
    const root = await lstat(path),
      directoryPath = resolve(path, this.rule.relativePath);
    const directory = await lstat(directoryPath);
    if (
      !root.isDirectory() ||
      !directory.isDirectory() ||
      (await realpath(directoryPath)) !== directoryPath
    )
      throw new FolderTriggerError('FOLDER_TRIGGER_ROOT_CHANGED');
    const identity = FolderTriggerRootIdentitySchema.parse({
      path,
      dev: root.dev,
      ino: root.ino,
      directoryDev: directory.dev,
      directoryIno: directory.ino,
    });
    if (
      this.root &&
      canonicalRuntimeBridgeJson(identity) !==
        canonicalRuntimeBridgeJson(this.root)
    )
      throw new FolderTriggerError('FOLDER_TRIGGER_ROOT_CHANGED');
    if (this.controller.signal.aborted || this.options.signal?.aborted)
      throw new FolderTriggerError('FOLDER_TRIGGER_CLOSED');
    return identity;
  }
  private armExpiry() {
    clearTimeout(this.expiry);
    this.expiry = setTimeout(
      () => {
        this.options.onError?.('FOLDER_TRIGGER_ADMISSION_EXPIRED');
        this.abort();
      },
      Math.min(
        2_147_483_647,
        Math.max(0, Date.parse(this.rule.admissionExpiresAt) - this.now()),
      ),
    );
    this.expiry.unref?.();
  }
  private queue<T>(action: () => Promise<T>) {
    const result = this.tail.then(action);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private async settle() {
    await (this.options.settle?.(this.controller.signal) ??
      delay(folderTriggerStabilityMs, undefined, {
        signal: this.controller.signal,
      }));
    await this.check();
  }
  private watchPath(path: string) {
    return isAbsolute(path) && this.root
      ? relative(this.root.path, path)
      : path;
  }
  private notify(path: string) {
    if (!this.active || this.controller.signal.aborted) return;
    const normalized = this.watchPath(path);
    if (
      normalized === '' ||
      normalized === '.' ||
      normalized === this.rule.relativePath
    ) {
      void this.queue(() => this.check()).catch((error) => this.fail(error));
      return;
    }
    if (!folderTriggerMatches(this.rule, normalized)) return;
    const previous = this.paths.get(normalized);
    if (previous) {
      previous.dirty = true;
      return;
    }
    if (this.paths.size >= folderTriggerMaximumFiles) {
      this.fail(new FolderTriggerError('FOLDER_TRIGGER_EVENT_LIMIT'));
      return;
    }
    const entry = { dirty: true };
    this.paths.set(normalized, entry);
    void this.queue(async () => {
      try {
        for (let count = 0; entry.dirty; count++) {
          if (count >= 8)
            throw new FolderTriggerError('FOLDER_TRIGGER_EVENT_LIMIT');
          entry.dirty = false;
          await this.observe(normalized).catch((error: unknown) => {
            if (
              [
                'FILE_CHANGED',
                'FILE_NOT_FOUND',
                'FILE_PARENT_CHANGED',
                'FOLDER_TRIGGER_FILE_CHANGED',
                'ENOENT',
              ].includes(this.code(error))
            ) {
              this.options.onError?.('FOLDER_TRIGGER_FILE_CHANGED');
              return;
            }
            throw error;
          });
        }
      } finally {
        this.paths.delete(normalized);
      }
    }).catch((error) => this.fail(error));
  }
  private fail(error: unknown) {
    if (this.controller.signal.aborted) return;
    this.options.onError?.(this.code(error));
    this.abort();
  }
  private async observe(path: string) {
    const root = await this.check();
    const inspect = this.options.inspect ?? inspectNative;
    const first = await inspect(root.path, path, this.controls());
    if (!first) {
      await this.check();
      await this.options.journal.forgetFolderTriggerPath(this.rule, root, path);
      return;
    }
    await this.settle();
    const expected = await inspect(root.path, path, this.controls());
    await this.check();
    if (
      !expected ||
      canonicalRuntimeBridgeJson(first) !== canonicalRuntimeBridgeJson(expected)
    ) {
      this.options.onError?.('FOLDER_TRIGGER_FILE_CHANGED');
      return;
    }
    await this.options.journal.recordFolderTrigger(
      this.rule,
      root,
      path,
      expected,
      new Date(this.now()).toISOString(),
    );
  }
  async start() {
    if (this.started)
      throw new FolderTriggerError('FOLDER_TRIGGER_ALREADY_STARTED');
    this.started = true;
    try {
      const existing = await this.options.journal.folderTriggerSnapshot(
        this.rule,
      );
      this.root = existing?.root ?? null;
      this.root = await this.check();
      this.options.journal.assertWorkspace?.(this.root.path);
      this.armExpiry();
      const root = this.root;
      // Bound the selected tree before the mature library opens OS watchers.
      // Re-read after ready: the first complete baseline starts at that commit.
      const preflight = FolderTriggerScanSchema.parse(
        await (this.options.scan ?? scanNative)(
          root.path,
          this.rule,
          this.controls(),
        ),
      );
      if (!preflight.complete || preflight.truncated)
        throw new FolderTriggerError('FOLDER_TRIGGER_SCAN_INCOMPLETE');
      await this.check();
      this.handle = await (
        this.options.watcherFactory ?? createFolderTriggerWatcher
      )(resolve(root.path, this.rule.relativePath), {
        cwd: root.path,
        depth: 7,
        ignored: (path, metadata) =>
          folderTriggerIgnores(this.rule, this.watchPath(path)) ||
          Boolean(
            metadata?.isFile() &&
            !folderTriggerMatches(this.rule, this.watchPath(path)),
          ),
        awaitWriteFinish: {
          stabilityThreshold: folderTriggerStabilityMs,
          pollInterval: 100,
        },
        atomic: true,
        onChange: (_kind, path) => this.notify(path),
        onError: (error) => this.fail(error),
      });
      if (this.controller.signal.aborted || this.options.signal?.aborted) {
        await this.handle.close();
        throw new FolderTriggerError('FOLDER_TRIGGER_CLOSED');
      }
      await new Promise<void>((resolveReady, rejectReady) => {
        const abort = () =>
          rejectReady(new FolderTriggerError('FOLDER_TRIGGER_CLOSED'));
        this.controller.signal.addEventListener('abort', abort, { once: true });
        if (this.controller.signal.aborted) abort();
        void this.handle!.ready.then(resolveReady, rejectReady).finally(() =>
          this.controller.signal.removeEventListener('abort', abort),
        );
      });
      const result = await this.reconcile();
      await this.check();
      this.active = true;
      return result;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async reconcile(renewedRule?: FolderTriggerRule) {
    return this.queue(async () => {
      if (!this.started)
        throw new FolderTriggerError('FOLDER_TRIGGER_NOT_STARTED');
      if (renewedRule) {
        const renewed = normalizeFolderTriggerRule(renewedRule);
        if (
          folderTriggerRuleFingerprint(renewed) !==
          folderTriggerRuleFingerprint(this.rule)
        )
          throw new FolderTriggerError('FOLDER_TRIGGER_SCOPE_CHANGED');
        this.rule = renewed;
        this.armExpiry();
      }
      const root = await this.check(),
        scan = this.options.scan ?? scanNative;
      const before = await this.options.journal.folderTriggerSnapshot(
        this.rule,
      );
      let current = FolderTriggerScanSchema.parse(
        await scan(root.path, this.rule, this.controls()),
      );
      if (
        current.files.some(
          (file) => !folderTriggerMatches(this.rule, file.path),
        )
      )
        throw new FolderTriggerError('FOLDER_TRIGGER_PATH_DENIED');
      if (
        before?.baselineComplete &&
        current.files.some(
          (file) =>
            !before.files.some(
              (old) =>
                old.path === file.path &&
                canonicalRuntimeBridgeJson(old.expected) ===
                  canonicalRuntimeBridgeJson(file.expected),
            ),
        )
      ) {
        await this.settle();
        const after = FolderTriggerScanSchema.parse(
          await scan(root.path, this.rule, this.controls()),
        );
        const files = after.files.filter((file) =>
          current.files.some(
            (old) =>
              old.path === file.path &&
              canonicalRuntimeBridgeJson(old.expected) ===
                canonicalRuntimeBridgeJson(file.expected),
          ),
        );
        current = {
          files,
          complete: after.complete && files.length === after.files.length,
          truncated: after.truncated,
        };
      }
      await this.check();
      const events = await this.options.journal.commitFolderTriggerSnapshot(
        this.rule,
        root,
        current,
        new Date(this.now()).toISOString(),
      );
      return {
        complete: current.complete,
        truncated: current.truncated,
        observedFiles: current.files.length,
        queuedEvents: events.length,
      };
    }).catch((error: unknown) => {
      this.fail(error);
      throw error;
    });
  }
  /** Heartbeats renew authority without reading every observed file again. */
  async renewAdmission(input: FolderTriggerRule) {
    const renewed = normalizeFolderTriggerRule(input);
    if (
      !this.started ||
      this.controller.signal.aborted ||
      folderTriggerRuleFingerprint(renewed) !==
        folderTriggerRuleFingerprint(this.rule)
    )
      throw new FolderTriggerError('FOLDER_TRIGGER_SCOPE_CHANGED');
    // An expired lease cannot be revived on an existing observer. A new
    // instance must reconcile the immutable snapshot before listening again.
    try {
      await this.check();
      if (Date.parse(renewed.admissionExpiresAt) <= this.now())
        throw new FolderTriggerError('FOLDER_TRIGGER_ADMISSION_EXPIRED');
      this.rule = renewed;
      await this.check();
      this.armExpiry();
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }
  /** Useful to owners draining this module; does not wait for future fs events. */
  async idle() {
    await this.tail;
  }
  async close() {
    if (this.closing) return this.closing;
    this.active = false;
    this.controller.abort();
    clearTimeout(this.expiry);
    this.options.signal?.removeEventListener('abort', this.abort);
    this.closing = (async () => {
      try {
        await this.handle?.close();
      } finally {
        await this.tail;
        this.paths.clear();
      }
    })();
    return this.closing;
  }
}
