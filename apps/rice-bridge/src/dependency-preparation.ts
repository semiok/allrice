import { createHash } from 'node:crypto';
import {
  runtimeNpmPackageUrl,
  type RuntimeLocalCommand,
} from '@allrice/contracts';
import { LocalCommandError } from './local-command-inputs.js';
import { downloadNpmArchive } from './npm-registry-download.js';

type File = { path: string; content: string };
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
/** Validate exact approved lock entries BEFORE any network request or installation. */
export function validateDependencyInputs(
  command: RuntimeLocalCommand,
  files: File[],
) {
  const spec = command.arguments.dependencies;
  if (!spec) return;
  const prefix =
    command.arguments.path === '.' ? '' : `${command.arguments.path}/`;
  const parse = (name: string) => {
    const file = files.find((f) => f.path === prefix + name);
    if (!file) throw new LocalCommandError('DEPENDENCY_MANIFEST_REQUIRED');
    try {
      const value: unknown = JSON.parse(
        Buffer.from(file.content, 'base64').toString('utf8'),
      );
      if (!object(value)) throw Error();
      return value;
    } catch {
      throw new LocalCommandError('DEPENDENCY_MANIFEST_INVALID');
    }
  };
  const pkg = parse('package.json'),
    lock = parse('package-lock.json');
  if (
    lock.lockfileVersion !== 3 ||
    !object(lock.packages) ||
    !object(lock.packages['']) ||
    pkg.workspaces ||
    pkg.overrides ||
    files.some((f) => f.path === prefix + 'npm-shrinkwrap.json')
  )
    throw new LocalCommandError('DEPENDENCY_LAYOUT_UNSUPPORTED');
  const entries = Object.entries(lock.packages).filter(([key]) => key !== '');
  if (!entries.length || entries.length > 32)
    throw new LocalCommandError('DEPENDENCY_LAYOUT_UNSUPPORTED');
  const used = new Set<string>();
  for (const [path, entry] of entries) {
    if (
      !/^(?:node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*\/)*node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(
        path,
      ) ||
      !object(entry) ||
      entry.link ||
      entry.inBundle
    )
      throw new LocalCommandError('DEPENDENCY_SOURCE_DENIED');
    const name = path.slice(
      path.lastIndexOf('node_modules/') + 'node_modules/'.length,
    );
    const approved = spec.packages.find(
      (p) => p.name === name && p.version === entry.version,
    );
    if (
      !approved ||
      entry.resolved !== runtimeNpmPackageUrl(approved) ||
      entry.integrity !== approved.integrity
    )
      throw new LocalCommandError('DEPENDENCY_LOCK_MISMATCH');
    used.add(`${approved.name}@${approved.version}`);
  }
  if (used.size !== spec.packages.length)
    throw new LocalCommandError('DEPENDENCY_LOCK_MISMATCH');
  // Avoid altering npm semantics with source-provided files/config already in the copy.
  if (
    files.some(
      (f) =>
        f.path.split('/').includes('node_modules') ||
        f.path.endsWith('/.npmrc') ||
        f.path === '.npmrc',
    )
  )
    throw new LocalCommandError('DEPENDENCY_LAYOUT_UNSUPPORTED');
  for (const p of spec.packages)
    if (p.archivePath && !files.some((f) => f.path === p.archivePath))
      throw new LocalCommandError('DEPENDENCY_ARCHIVE_REQUIRED');
}

export async function prepareDependencyArchives(
  command: RuntimeLocalCommand,
  files: File[],
  options: { signal: AbortSignal; maintainLease?: () => Promise<boolean> },
) {
  validateDependencyInputs(command, files);
  const spec = command.arguments.dependencies;
  if (!spec) return [];
  const revoked = () => new LocalCommandError('EXECUTION_REVOKED');
  const leaseAbort = new AbortController();
  const signal = AbortSignal.any([options.signal, leaseAbort.signal]);
  if (signal.aborted) throw revoked();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(revoked());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  let leaseCheck: Promise<void> | undefined;
  const checkLease = () => {
    if (!leaseCheck) {
      const current = (async () => {
        try {
          if (options.maintainLease && !(await options.maintainLease()))
            leaseAbort.abort();
        } catch {
          leaseAbort.abort();
        }
        if (signal.aborted) throw revoked();
      })();
      leaseCheck = current;
      const clear = () => {
        if (leaseCheck === current) leaseCheck = undefined;
      };
      void current.then(clear, clear);
    }
    // An explicit cancellation must not wait for an in-flight heartbeat.
    return Promise.race([leaseCheck, aborted]);
  };
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    await checkLease();
    if (options.maintainLease)
      heartbeat = setInterval(() => {
        // Reuse any pending check; never accumulate overlapping HTTP requests.
        void checkLease().catch(() => undefined);
      }, 1000);
    const archives: string[] = [];
    let total = 0;
    for (const pkg of spec.packages) {
      await checkLease();
      if (signal.aborted) throw revoked();
      let bytes: Buffer;
      try {
        bytes = pkg.archivePath
          ? Buffer.from(
              files.find((f) => f.path === pkg.archivePath)!.content,
              'base64',
            )
          : await downloadNpmArchive(pkg, signal);
      } catch (error) {
        if (signal.aborted) throw revoked();
        if (error instanceof LocalCommandError) throw error;
        throw new LocalCommandError('DEPENDENCY_NETWORK_UNAVAILABLE');
      }
      if (signal.aborted) throw revoked();
      total += bytes.length;
      if (total > 131072)
        throw new LocalCommandError('DEPENDENCY_ARCHIVE_LIMIT');
      if (
        `sha512-${createHash('sha512').update(bytes).digest('base64')}` !==
        pkg.integrity
      )
        throw new LocalCommandError('DEPENDENCY_INTEGRITY_MISMATCH');
      archives.push(bytes.toString('base64'));
    }
    await checkLease();
    if (signal.aborted) throw revoked();
    return archives;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    signal.removeEventListener('abort', onAbort);
  }
}

export function dependencyEvidence(
  command: RuntimeLocalCommand,
  code: number,
  reason: string,
) {
  const spec = command.arguments.dependencies;
  return spec
    ? {
        dependencies: {
          manager: spec.manager,
          registry: spec.registry,
          scripts: spec.scripts,
          packageCount: spec.packages.length,
          location: 'ephemeral_isolated_work_copy' as const,
          status:
            reason === 'exited' && code === 0
              ? ('installed_and_verification_succeeded' as const)
              : ('installation_or_verification_failed' as const),
          hostModified: false as const,
        },
      }
    : {};
}
