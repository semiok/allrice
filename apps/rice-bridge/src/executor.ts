import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  open,
  link,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import {
  BridgeCommandPayloadSchema,
  type BridgeCommandPayload,
} from '@allrice/contracts';

const execFileAsync = promisify(execFile);
const defaultMaximumBytes = 200_000;
const maximumScannedFiles = 2_000;
const ignoredDirectories = new Set(['.git', 'node_modules', '.next', 'dist']);
const sensitiveDirectories = new Set(['.ssh', '.aws', '.gnupg', '.codex']);

export class LocalExecutionError extends Error {
  constructor(
    public readonly code:
      | 'PATH_OUTSIDE_GRANT'
      | 'SENSITIVE_PATH'
      | 'FILE_TOO_LARGE'
      | 'FILE_TYPE_UNSUPPORTED'
      | 'GRANT_NOT_FOUND'
      | 'GIT_COMMAND_FAILED'
      | 'WRITE_PRECONDITION_REQUIRED'
      | 'WRITE_CONFLICT'
      | 'PATH_ALREADY_EXISTS'
      | 'DIRECTORY_NOT_FOUND',
    message: string,
  ) {
    super(message);
  }
}

function sha256(content: Uint8Array) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function isWriteProtectedPath(path: string) {
  return path
    .split('/')
    .some(
      (part) => ignoredDirectories.has(part) || sensitiveDirectories.has(part),
    );
}

function isSensitivePath(path: string) {
  const parts = path.split(sep);
  if (parts.some((part) => sensitiveDirectories.has(part))) return true;
  const name = basename(path).toLowerCase();
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    name === '.npmrc' ||
    name === '.netrc' ||
    name === 'id_rsa' ||
    name === 'id_ed25519' ||
    name.endsWith('.pem') ||
    name.endsWith('.key') ||
    name.endsWith('.p12')
  );
}

export async function resolveAuthorizedPath(root: string, requested: string) {
  const rootReal = await realpath(root);
  const candidate = resolve(rootReal, requested);
  const candidateReal = await realpath(candidate);
  if (
    candidateReal !== rootReal &&
    !candidateReal.startsWith(`${rootReal}${sep}`)
  ) {
    throw new LocalExecutionError(
      'PATH_OUTSIDE_GRANT',
      'Requested path is outside the authorized folder',
    );
  }
  if (isSensitivePath(candidateReal)) {
    throw new LocalExecutionError(
      'SENSITIVE_PATH',
      'Sensitive files are not available to Rice Bridge',
    );
  }
  return { rootReal, candidateReal };
}

async function resolveAuthorizedWriteTarget(root: string, requested: string) {
  const rootReal = await realpath(root);
  const candidate = resolve(rootReal, requested);
  if (
    (candidate !== rootReal && !candidate.startsWith(`${rootReal}${sep}`)) ||
    isSensitivePath(candidate) ||
    isWriteProtectedPath(requested)
  ) {
    throw new LocalExecutionError(
      candidate.startsWith(`${rootReal}${sep}`)
        ? 'SENSITIVE_PATH'
        : 'PATH_OUTSIDE_GRANT',
      'Requested write path is not available to Rice Bridge',
    );
  }
  let parentReal: string;
  try {
    parentReal = await realpath(dirname(candidate));
  } catch {
    throw new LocalExecutionError(
      'DIRECTORY_NOT_FOUND',
      'Parent directory does not exist; create it explicitly first',
    );
  }
  if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${sep}`)) {
    throw new LocalExecutionError(
      'PATH_OUTSIDE_GRANT',
      'Requested write path escapes through a symbolic link',
    );
  }
  const metadata = await lstat(candidate).catch((error: unknown) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  });
  if (metadata?.isSymbolicLink()) {
    throw new LocalExecutionError(
      'PATH_OUTSIDE_GRANT',
      'Rice Bridge does not write through symbolic links',
    );
  }
  return { rootReal, candidate, metadata };
}

export async function writeTextFile(
  root: string,
  requested: string,
  content: string,
  expectedSha256?: string | null,
  beforeCommit?: () => Promise<void>,
) {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.byteLength > defaultMaximumBytes) {
    throw new LocalExecutionError(
      'FILE_TOO_LARGE',
      `File exceeds the ${defaultMaximumBytes} byte write limit`,
    );
  }
  const { rootReal, candidate, metadata } = await resolveAuthorizedWriteTarget(
    root,
    requested,
  );
  if (metadata && !metadata.isFile()) {
    throw new LocalExecutionError(
      'FILE_TYPE_UNSUPPORTED',
      'Requested write path is not a regular file',
    );
  }
  if (metadata) {
    if (!expectedSha256) {
      throw new LocalExecutionError(
        'WRITE_PRECONDITION_REQUIRED',
        'Read the existing file and provide its SHA-256 before overwriting it',
      );
    }
    const existing = await readFile(candidate);
    if (sha256(existing) !== expectedSha256) {
      throw new LocalExecutionError(
        'WRITE_CONFLICT',
        'The file changed after it was read; read it again before writing',
      );
    }
  } else if (expectedSha256) {
    throw new LocalExecutionError(
      'WRITE_CONFLICT',
      'The expected file no longer exists',
    );
  }
  const temporary = resolve(
    dirname(candidate),
    `.allrice-write-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, bytes, {
      flag: 'wx',
      mode: metadata ? metadata.mode : 0o644,
    });
    const staged = await open(
      temporary,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await staged.sync();
    } finally {
      await staged.close();
    }
    if (beforeCommit) await beforeCommit();
    const current = await checkChangesetFile(
      root,
      requested,
      expectedSha256 ?? null,
    );
    if (current?.ino !== metadata?.ino || current?.dev !== metadata?.dev)
      throw new LocalExecutionError(
        'WRITE_CONFLICT',
        'File identity changed during staging',
      );
    // Hard-link insertion refuses a concurrently created destination; rename is
    // the existing single-file replacement, not a cross-file atomic transaction.
    if (metadata) await rename(temporary, candidate);
    else {
      await link(temporary, candidate);
      await unlink(temporary);
    }
    const directory = await open(
      dirname(candidate),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return {
    path: relative(rootReal, candidate),
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    created: !metadata,
  };
}

/** Bounded CAS precondition. Does not claim an OS compare-and-swap against an
 * uncooperative same-user editor racing the final rename/unlink syscall. */
export async function checkChangesetFile(
  root: string,
  requested: string,
  expected: string | null,
) {
  const { rootReal, candidate, metadata } = await resolveAuthorizedWriteTarget(
    root,
    requested,
  );
  let parent = rootReal;
  for (const part of requested.split('/').slice(0, -1)) {
    parent = resolve(parent, part);
    const entry = await lstat(parent);
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new LocalExecutionError(
        'PATH_OUTSIDE_GRANT',
        'Changesets do not follow directory links',
      );
  }
  if (!metadata) {
    if (expected !== null)
      throw new LocalExecutionError(
        'WRITE_CONFLICT',
        'Expected file is absent',
      );
    return null;
  }
  if (!metadata.isFile() || metadata.nlink !== 1)
    throw new LocalExecutionError(
      'FILE_TYPE_UNSUPPORTED',
      'Changesets require a regular unlinked file',
    );
  if (expected === null)
    throw new LocalExecutionError('WRITE_CONFLICT', 'A file already exists');
  if (metadata.size > defaultMaximumBytes)
    throw new LocalExecutionError(
      'FILE_TOO_LARGE',
      'Changeset file exceeds limit',
    );
  const handle = await open(
    candidate,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    const buffer = Buffer.alloc(defaultMaximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const current = await lstat(candidate);
    if (
      opened.ino !== metadata.ino ||
      opened.dev !== metadata.dev ||
      current.ino !== opened.ino ||
      current.dev !== opened.dev ||
      bytes.length > defaultMaximumBytes ||
      sha256(bytes) !== expected
    )
      throw new LocalExecutionError(
        'WRITE_CONFLICT',
        'File changed since the reviewed baseline',
      );
  } finally {
    await handle.close();
  }
  return metadata;
}

/** Exact single-file removal only; the immutable Changeset retains prior bytes. */
export async function removeChangesetFile(
  root: string,
  requested: string,
  expected: string,
  beforeCommit: () => Promise<void>,
) {
  const before = await checkChangesetFile(root, requested, expected);
  await beforeCommit();
  const after = await checkChangesetFile(root, requested, expected);
  if (!before || !after || before.ino !== after.ino || before.dev !== after.dev)
    throw new LocalExecutionError('WRITE_CONFLICT', 'File identity changed');
  const { candidate } = await resolveAuthorizedWriteTarget(root, requested);
  await unlink(candidate);
  const directory = await open(
    dirname(candidate),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function createDirectory(root: string, requested: string) {
  const { rootReal, candidate, metadata } = await resolveAuthorizedWriteTarget(
    root,
    requested,
  );
  if (metadata) {
    throw new LocalExecutionError(
      'PATH_ALREADY_EXISTS',
      'Requested directory already exists',
    );
  }
  await mkdir(candidate, { mode: 0o755 });
  return { path: relative(rootReal, candidate), created: true };
}

async function readTextFile(path: string, maximumBytes: number) {
  const metadata = await stat(path);
  if (!metadata.isFile()) {
    throw new LocalExecutionError(
      'FILE_TYPE_UNSUPPORTED',
      'Requested path is not a regular file',
    );
  }
  if (metadata.size > maximumBytes) {
    throw new LocalExecutionError(
      'FILE_TOO_LARGE',
      `File exceeds the ${maximumBytes} byte read limit`,
    );
  }
  const content = await readFile(path);
  if (content.includes(0)) {
    throw new LocalExecutionError(
      'FILE_TYPE_UNSUPPORTED',
      'Binary files are not available to Rice Bridge',
    );
  }
  return content.toString('utf8');
}

async function listFiles(root: string, path: string, limit: number) {
  const { rootReal, candidateReal } = await resolveAuthorizedPath(root, path);
  const entries = await readdir(candidateReal, { withFileTypes: true });
  return entries.slice(0, limit).map((entry) => ({
    path: relative(rootReal, resolve(candidateReal, entry.name)) || '.',
    type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
  }));
}

async function searchFiles(
  root: string,
  path: string,
  query: string,
  limit: number,
) {
  const { rootReal, candidateReal } = await resolveAuthorizedPath(root, path);
  const queue = [candidateReal];
  const matches: { path: string; line: number; preview: string }[] = [];
  let scanned = 0;
  while (
    queue.length > 0 &&
    matches.length < limit &&
    scanned < maximumScannedFiles
  ) {
    const current = queue.shift()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (matches.length >= limit || scanned >= maximumScannedFiles) break;
      const target = resolve(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name) && !isSensitivePath(target)) {
          queue.push(target);
        }
        continue;
      }
      if (!entry.isFile() || isSensitivePath(target)) continue;
      scanned += 1;
      const metadata = await lstat(target);
      if (metadata.size > defaultMaximumBytes) continue;
      const content = await readFile(target);
      if (content.includes(0)) continue;
      const lines = content.toString('utf8').split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (line.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
          matches.push({
            path: relative(rootReal, target),
            line: index + 1,
            preview: line.slice(0, 500),
          });
          if (matches.length >= limit) break;
        }
      }
    }
  }
  return {
    matches,
    scannedFiles: scanned,
    truncated: scanned >= maximumScannedFiles,
  };
}

async function gitReadOnly(
  root: string,
  path: string,
  mode: 'status' | 'diff',
  staged: boolean,
  maximumBytes: number,
) {
  const { candidateReal } = await resolveAuthorizedPath(root, path);
  const args =
    mode === 'status'
      ? ['-C', candidateReal, 'status', '--short', '--branch']
      : ['-C', candidateReal, 'diff', ...(staged ? ['--cached'] : []), '--'];
  try {
    const result = await execFileAsync('git', args, {
      timeout: 15_000,
      maxBuffer: maximumBytes,
      encoding: 'utf8',
    });
    return { output: result.stdout.slice(0, maximumBytes) };
  } catch (error) {
    throw new LocalExecutionError(
      'GIT_COMMAND_FAILED',
      error instanceof Error ? error.message : 'Read-only Git command failed',
    );
  }
}

export async function executeLocalCommand(
  root: string,
  payloadInput: BridgeCommandPayload,
) {
  const payload = BridgeCommandPayloadSchema.parse(payloadInput);
  if (payload.capability === 'local.fs.list') {
    const output = await listFiles(
      root,
      payload.arguments.path,
      payload.arguments.limit,
    );
    return { output, summary: `已列出 ${output.length} 个本地项目` };
  }
  if (payload.capability === 'local.fs.search') {
    const output = await searchFiles(
      root,
      payload.arguments.path,
      payload.arguments.query,
      payload.arguments.limit,
    );
    return {
      output,
      summary: `在当前 Mac 上找到 ${output.matches.length} 个匹配`,
    };
  }
  if (payload.capability === 'local.fs.read') {
    const { rootReal, candidateReal } = await resolveAuthorizedPath(
      root,
      payload.arguments.path,
    );
    const content = await readTextFile(
      candidateReal,
      payload.arguments.maxBytes,
    );
    return {
      output: {
        path: relative(rootReal, candidateReal),
        content,
        sha256: sha256(Buffer.from(content, 'utf8')),
      },
      summary: `已从当前 Mac 读取 ${payload.arguments.path}`,
    };
  }
  if (payload.capability === 'local.fs.write') {
    const output = await writeTextFile(
      root,
      payload.arguments.path,
      payload.arguments.content,
      payload.arguments.expectedSha256,
    );
    return {
      output,
      summary: `${output.created ? '已新建' : '已更新'}当前 Mac 文件 ${output.path}`,
    };
  }
  if (payload.capability === 'local.fs.mkdir') {
    const output = await createDirectory(root, payload.arguments.path);
    return {
      output,
      summary: `已在当前 Mac 新建目录 ${output.path}`,
    };
  }
  if (payload.capability === 'local.git.status') {
    return {
      output: await gitReadOnly(
        root,
        payload.arguments.path,
        'status',
        false,
        defaultMaximumBytes,
      ),
      summary: '已读取当前 Mac 仓库状态',
    };
  }
  return {
    output: await gitReadOnly(
      root,
      payload.arguments.path,
      'diff',
      payload.arguments.staged,
      payload.arguments.maxBytes,
    ),
    summary: '已读取当前 Mac 仓库差异',
  };
}
