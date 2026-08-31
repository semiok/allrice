import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';
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
      | 'GIT_COMMAND_FAILED',
    message: string,
  ) {
    super(message);
  }
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
      summary: `在 Snow 的 Mac 上找到 ${output.matches.length} 个匹配`,
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
      output: { path: relative(rootReal, candidateReal), content },
      summary: `已从 Snow 的 Mac 读取 ${payload.arguments.path}`,
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
      summary: '已读取 Snow 的 Mac 仓库状态',
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
    summary: '已读取 Snow 的 Mac 仓库差异',
  };
}
