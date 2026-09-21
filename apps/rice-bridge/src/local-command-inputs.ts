import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';

import {
  RuntimeLocalCommandSchema,
  ChangesetDocumentSchema,
  commandCandidateManifest,
  type RuntimeLocalCommand,
} from '@allrice/contracts';

export class LocalCommandError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const privatePart =
  /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.gnupg|\.codex|\.gemini|\.config|\.kube|\.docker|\.azure|\.npmrc|\.netrc|id_rsa|id_ed25519)$|\.(?:pem|key|p12|pfx)$/i;

const hash = (bytes: string | Buffer) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
/** Reconstructable from the immutable payload, but not sufficient execution proof. */
export function candidateEvidence(input: RuntimeLocalCommand) {
  try {
    const candidate = input.arguments.candidate;
    if (!candidate) return {};
    if (
      Buffer.byteLength(candidate.content) > 512_000 ||
      hash(candidate.content) !== candidate.checksum
    )
      throw new LocalCommandError('CANDIDATE_CONTENT_CHANGED');
    const document = ChangesetDocumentSchema.parse(
      JSON.parse(candidate.content),
    );
    for (const file of document.files) {
      if (file.path.split('/').some((part) => privatePart.test(part)))
        throw new LocalCommandError('SENSITIVE_INPUT');
      for (const side of [file.before, file.after])
        if (
          side &&
          (Buffer.byteLength(side.text) > 200_000 ||
            hash(side.text) !== side.checksum)
        )
          throw new LocalCommandError('CANDIDATE_CONTENT_CHANGED');
    }
    const manifest = commandCandidateManifest(
      input.arguments.files,
      candidate.content,
    );
    return {
      candidate: {
        artifactId: candidate.artifactId,
        checksum: candidate.checksum,
        inputDigest: hash(JSON.stringify(manifest)),
      },
    };
  } catch (error) {
    if (error instanceof LocalCommandError) throw error;
    throw new LocalCommandError('CANDIDATE_CONTENT_CHANGED');
  }
}

/** Read the exact approved manifest, never traverse/snapshot the whole project. */
export async function readLocalCommandInputs(
  rootPath: string,
  input: RuntimeLocalCommand,
) {
  const command = RuntimeLocalCommandSchema.parse(input).arguments;
  const evidence = candidateEvidence(input);
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
  if (command.candidate) {
    const document = ChangesetDocumentSchema.parse(
      JSON.parse(command.candidate.content),
    );
    const staged = new Map(files.map((file) => [file.path, file]));
    for (const file of document.files) {
      if (!file.before) {
        // No traversal through links, including dangling symlinks. A missing
        // parent is safe because this code NEVER creates anything on the host.
        let current = root;
        const parts = file.path.split('/');
        for (let i = 0; i < parts.length; i++) {
          current = join(current, parts[i]!);
          const stat = await lstat(current).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            },
          );
          if (!stat) break;
          if (i === parts.length - 1)
            throw new LocalCommandError('INPUT_VERSION_CHANGED');
          if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new LocalCommandError('INPUT_PATH_CHANGED');
        }
      }
      if (file.after)
        staged.set(file.path, {
          path: file.path,
          content: Buffer.from(file.after.text).toString('base64'),
        });
      else staged.delete(file.path);
    }
    files.splice(
      0,
      files.length,
      ...[...staged.values()].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      ),
    );
    if (
      files.reduce(
        (size, file) => size + Buffer.from(file.content, 'base64').length,
        0,
      ) > 262_144
    )
      throw new LocalCommandError('INPUT_LIMIT');
    const actual = hash(
      JSON.stringify(
        files.map((f) => [f.path, hash(Buffer.from(f.content, 'base64'))]),
      ),
    );
    if (actual !== evidence.candidate?.inputDigest)
      throw new LocalCommandError('CANDIDATE_CONTENT_CHANGED');
    const now = await lstat(root);
    if (
      now.isSymbolicLink() ||
      now.dev !== rootStat.dev ||
      now.ino !== rootStat.ino
    )
      throw new LocalCommandError('INPUT_PATH_CHANGED');
  }
  return { command, files, ...evidence };
}
