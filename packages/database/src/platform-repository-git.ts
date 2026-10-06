import { createHash } from 'node:crypto';
import { validateRepositoryArchive } from './platform-repository-source.ts';
import type { RepositoryArchive } from './platform-repair-contracts.ts';

/** Git object SHA-1 is a separate identity from the material's SHA-256. */
export function gitObjectId(type: 'blob' | 'tree' | 'commit', bytes: Buffer) {
  return createHash('sha1')
    .update(Buffer.from(`${type} ${bytes.length}\0`))
    .update(bytes)
    .digest('hex');
}
export function gitBlobId(bytes: Buffer) {
  return gitObjectId('blob', bytes);
}
type Tree = Map<string, Tree | { mode: string; sha: string }>;

/** Compute the complete tree, including executable modes and Git directory order. */
export function repositoryGitTree(raw: RepositoryArchive) {
  const archive = validateRepositoryArchive(raw);
  return gitTreeForBlobs(
    archive.files.map((file) => ({
      path: file.path,
      mode: file.mode,
      sha: gitBlobId(Buffer.from(file.contentBase64, 'base64')),
    })),
  );
}
export function gitTreeForBlobs(
  files: Array<{ path: string; mode: string; sha: string }>,
) {
  if (files.length < 1 || files.length > 5000)
    throw Error('REPOSITORY_GIT_PATH_INVALID');
  const root: Tree = new Map();
  for (const file of files) {
    if (
      !/^[a-f0-9]{40}$/.test(file.sha) ||
      !['100644', '100755'].includes(file.mode) ||
      !file.path ||
      file.path.length > 500 ||
      /[\\\0\r\n]/.test(file.path) ||
      file.path.split('/').some((p) => !p || p === '.' || p === '..')
    )
      throw Error('REPOSITORY_GIT_PATH_INVALID');
    const parts = file.path.split('/');
    let tree = root;
    for (const part of parts.slice(0, -1)) {
      let child = tree.get(part);
      if (!child) tree.set(part, (child = new Map()));
      if (!(child instanceof Map)) throw Error('REPOSITORY_GIT_PATH_CONFLICT');
      tree = child;
    }
    const name = parts.at(-1)!;
    if (tree.has(name)) throw Error('REPOSITORY_GIT_PATH_CONFLICT');
    tree.set(name, {
      mode: file.mode,
      sha: file.sha,
    });
  }
  function hash(tree: Tree): string {
    const entries = [...tree].map(([name, entry]) => {
      const directory = entry instanceof Map;
      return {
        sortKey: Buffer.from(name + (directory ? '/' : '')),
        bytes: Buffer.concat([
          Buffer.from(`${directory ? '40000' : entry.mode} ${name}\0`),
          Buffer.from(directory ? hash(entry) : entry.sha, 'hex'),
        ]),
      };
    });
    entries.sort((a, b) => Buffer.compare(a.sortKey, b.sortKey));
    return gitObjectId('tree', Buffer.concat(entries.map((e) => e.bytes)));
  }
  return hash(root);
}

export interface RepositoryCommitMetadata {
  login: string;
  userId: number;
  timestamp: string;
  message: string;
}
/** Frozen before START so a lost response has one exact object to read back. */
export function repositoryCommitIdentity(
  tree: string,
  parent: string,
  metadata: RepositoryCommitMetadata,
) {
  if (
    !/^[a-f0-9]{40}$/.test(tree) ||
    !/^[a-f0-9]{40}$/.test(parent) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(metadata.login) ||
    !Number.isSafeInteger(metadata.userId) ||
    metadata.userId < 1 ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(metadata.timestamp) ||
    !Number.isFinite(Date.parse(metadata.timestamp)) ||
    !metadata.message ||
    metadata.message.length > 200 ||
    /[\r\n\0]/.test(metadata.message)
  )
    throw Error('REPOSITORY_COMMIT_METADATA_INVALID');
  const seconds = Math.floor(Date.parse(metadata.timestamp) / 1000);
  const author = {
    name: metadata.login,
    email: `${metadata.userId}+${metadata.login}@users.noreply.github.com`,
    date: metadata.timestamp,
  };
  const signature = `${author.name} <${author.email}> ${seconds} +0000`;
  const message = metadata.message + '\n';
  const bytes = Buffer.from(
    `tree ${tree}\nparent ${parent}\nauthor ${signature}\ncommitter ${signature}\n\n${message}`,
  );
  return {
    sha: gitObjectId('commit', bytes),
    payload: {
      tree,
      parents: [parent],
      author,
      committer: author,
      message,
    },
  };
}
