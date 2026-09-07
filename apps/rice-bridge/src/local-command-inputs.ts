import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';

import {
  RuntimeLocalCommandSchema,
  type RuntimeLocalCommand,
} from '@allrice/contracts';

export class LocalCommandError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const privatePart =
  /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.gnupg|\.codex|\.gemini|\.config|\.kube|\.docker|\.azure|\.npmrc|\.netrc|id_rsa|id_ed25519)$|\.(?:pem|key|p12|pfx)$/i;

/** Read the exact approved manifest, never traverse/snapshot the whole project. */
export async function readLocalCommandInputs(
  rootPath: string,
  input: RuntimeLocalCommand,
) {
  const command = RuntimeLocalCommandSchema.parse(input).arguments;
  const root = await realpath(rootPath);
  const rootStat = await lstat(root);
  const files: { path: string; content: string }[] = [];
  let total = 0;
  for (const file of command.files) {
    if (file.path.split('/').some((part) => privatePart.test(part)))
      throw new LocalCommandError('SENSITIVE_INPUT');
    let current = root;
    const identities: { path: string; dev: number; ino: number }[] = [];
    for (const part of file.path.split('/').slice(0, -1)) {
      current = join(current, part);
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new LocalCommandError('INPUT_PATH_CHANGED');
      identities.push({ path: current, dev: stat.dev, ino: stat.ino });
    }
    const fullPath = join(root, file.path);
    if (!(await realpath(fullPath)).startsWith(`${root}${sep}`))
      throw new LocalCommandError('INPUT_PATH_CHANGED');
    const handle = await open(
      fullPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > 200_000)
        throw new LocalCommandError('UNSAFE_INPUT_FILE');
      // Bounded FD read even if another process continuously grows the file.
      const bytes = Buffer.alloc(200_001);
      let count = 0;
      while (count < bytes.length) {
        const next = await handle.read(
          bytes,
          count,
          bytes.length - count,
          count,
        );
        if (!next.bytesRead) break;
        count += next.bytesRead;
      }
      const after = await handle.stat();
      const content = bytes.subarray(0, count);
      total += count;
      if (count > 200_000 || total > 262_144)
        throw new LocalCommandError('INPUT_LIMIT');
      const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
      if (
        digest !== file.sha256 ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      )
        throw new LocalCommandError('INPUT_VERSION_CHANGED');
      for (const identity of [
        { path: root, dev: rootStat.dev, ino: rootStat.ino },
        ...identities,
      ]) {
        const now = await lstat(identity.path);
        if (
          now.isSymbolicLink() ||
          now.dev !== identity.dev ||
          now.ino !== identity.ino
        )
          throw new LocalCommandError('INPUT_PATH_CHANGED');
      }
      const final = await lstat(fullPath);
      if (
        final.isSymbolicLink() ||
        final.dev !== after.dev ||
        final.ino !== after.ino ||
        final.nlink !== 1
      )
        throw new LocalCommandError('INPUT_PATH_CHANGED');
      files.push({ path: file.path, content: content.toString('base64') });
    } finally {
      await handle.close();
    }
  }
  return { command, files };
}
