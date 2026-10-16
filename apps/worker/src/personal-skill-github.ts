import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  parsePersonalSkillGitHubUrl,
  personalSkillLimits,
} from '@allrice/contracts';
import { fileArchiveMaximumFiles } from '@allrice/file-archives';

const shaPattern = /^[a-f0-9]{40}$/u;
const limits = {
  source: personalSkillLimits.sourceBytes,
  resource: personalSkillLimits.resourceBytes,
  resources: personalSkillLimits.packageResources,
  resourceTotal: personalSkillLimits.totalResourceBytes,
  candidates: personalSkillLimits.packageCandidates,
  total: personalSkillLimits.archiveBytes,
  metadata: 2_000_000,
  entries: 10_000,
  references: 8,
  requests: 300,
  timeoutMs: 60_000,
  archiveFiles: fileArchiveMaximumFiles,
} as const;
export class PersonalSkillSourceError extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}
function fail(code: string): never {
  throw new PersonalSkillSourceError(code);
}
const validPath = (path: string) =>
  path.length > 0 &&
  path.length <= 512 &&
  // eslint-disable-next-line no-control-regex -- Reject control bytes in untrusted Git paths.
  !/[\\:\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(path) &&
  path.split('/').every((part) => part && part !== '.' && part !== '..');
const key = (path: string) => path.normalize('NFC').toUpperCase().toLowerCase();
const quotePath = (path: string) =>
  path.split('/').map(encodeURIComponent).join('/');
const GitRepositorySchema = z.object({
  private: z.boolean(),
  full_name: z.string(),
  default_branch: z.string().optional(),
  license: z.object({ spdx_id: z.string().nullish() }).nullish(),
});
const GitCommitSchema = z.object({
  sha: z.string(),
  commit: z.object({ tree: z.object({ sha: z.string() }) }),
});
const GitTreeSchema = z.object({
  sha: z.string(),
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.enum(['blob', 'tree', 'commit']),
      sha: z.string(),
      size: z.number().int().nonnegative().optional(),
    }),
  ),
});
type GitEntry = z.infer<typeof GitTreeSchema>['tree'][number];
type Resolved = {
  ref: string;
  commitSha: string;
  treeSha: string;
  tree: GitEntry[];
  root: string;
};
function metadata<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) return fail('source_response_invalid');
  return result.data;
}

export async function readPublicGitHubSource(
  url: string,
  {
    fetch: fetcher = fetch,
    signal,
    timeoutMs = limits.timeoutMs,
  }: {
    fetch?: typeof globalThis.fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
) {
  let source;
  try {
    source = parsePersonalSkillGitHubUrl(url);
  } catch {
    return fail('source_url_invalid');
  }
  const bounded = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(signal ? [signal] : []),
  ]);
  const base = `https://api.github.com/repos/${source.owner}/${source.repo}`;
  let requestCount = 0;
  async function bytes(
    address: string,
    maxBytes: number,
    missing = false,
  ): Promise<Buffer | null> {
    bounded.throwIfAborted();
    if (++requestCount > limits.requests) fail('source_request_limit');
    let response;
    try {
      response = await fetcher(address, {
        method: 'GET',
        redirect: 'manual',
        signal: bounded,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
        },
      });
    } catch (error) {
      if (bounded.aborted) throw bounded.reason;
      throw new PersonalSkillSourceError('source_network_failed', {
        cause: error,
      });
    }
    if (response.status === 404 && missing) {
      await response.body?.cancel();
      return null;
    }
    if (response.status === 403 || response.status === 429) {
      await response.body?.cancel();
      fail('source_access_or_rate_limited');
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      fail('source_redirect_unsupported');
    }
    const missingCommit = missing && response.status === 422;
    if (response.status !== 200 && !missingCommit) {
      await response.body?.cancel();
      fail('source_unavailable');
    }
    if (missingCommit) maxBytes = Math.min(maxBytes, 16384);
    if (response.url && response.url !== address) {
      await response.body?.cancel();
      fail('source_redirect_unsupported');
    }
    const size = response.headers.get('content-length');
    if (size !== null && (!/^\d+$/.test(size) || Number(size) > maxBytes)) {
      await response.body?.cancel();
      fail('source_too_large');
    }
    if (!response.body) fail('source_response_invalid');
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let count = 0;
    try {
      while (true) {
        bounded.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        count += next.value.byteLength;
        if (count > maxBytes) fail('source_too_large');
        chunks.push(next.value);
      }
      const result = Buffer.concat(chunks, count);
      if (missingCommit) {
        let error;
        try {
          error = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(result),
          );
        } catch {
          fail('source_response_invalid');
        }
        const ref = decodeURIComponent(
          new URL(address).pathname.split('/commits/')[1] ?? '',
        );
        if (error.message === `No commit found for SHA: ${ref}`) return null;
        fail('source_reference_invalid');
      }
      return result;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async function json(address: string, missing = false): Promise<unknown> {
    const result = await bytes(address, limits.metadata, missing);
    if (result === null) return null;
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(result),
      );
    } catch {
      fail('source_response_invalid');
    }
  }
  const repo = metadata(GitRepositorySchema, await json(base));
  if (
    repo.private !== false ||
    typeof repo.full_name !== 'string' ||
    repo.full_name.toLowerCase() !==
      `${source.owner}/${source.repo}`.toLowerCase()
  )
    fail('source_repository_identity_invalid');
  const treeCache = new Map<string, GitEntry[]>();
  async function resolve(ref: string) {
    const raw = await json(`${base}/commits/${encodeURIComponent(ref)}`, true);
    if (raw === null) return null;
    const commit = metadata(GitCommitSchema, raw);
    const sha = commit.sha,
      treeSha = commit.commit?.tree?.sha;
    if (
      !shaPattern.test(sha) ||
      !shaPattern.test(treeSha) ||
      (shaPattern.test(ref) && ref !== sha)
    )
      fail('source_commit_identity_invalid');
    if (!treeCache.has(treeSha)) {
      const result = metadata(
        GitTreeSchema,
        await json(`${base}/git/trees/${treeSha}?recursive=1`),
      );
      if (
        result.sha !== treeSha ||
        result.truncated !== false ||
        !Array.isArray(result.tree)
      )
        fail('source_tree_incomplete');
      if (result.tree.length > limits.entries) fail('source_tree_limit');
      const paths = new Set();
      for (const entry of result.tree) {
        if (!validPath(entry.path)) fail('source_path_invalid');
        const normalized = key(entry.path);
        if (paths.has(normalized)) fail('source_path_conflict');
        paths.add(normalized);
      }
      treeCache.set(treeSha, result.tree);
    }
    return { ref, commitSha: sha, treeSha, tree: treeCache.get(treeSha)! };
  }
  const possibilities: Resolved[] = [];
  if (source.kind === 'repository') {
    if (typeof repo.default_branch !== 'string' || !repo.default_branch)
      fail('source_ref_missing');
    const resolved = await resolve(repo.default_branch);
    if (resolved) possibilities.push({ ...resolved, root: '' });
  } else {
    const maxRef =
      source.kind === 'blob' ? source.tail.length - 1 : source.tail.length;
    if (!shaPattern.test(source.tail[0]!) && maxRef > limits.references)
      fail('source_ref_ambiguous');
    const count = shaPattern.test(source.tail[0]!) ? 1 : maxRef;
    for (let length = 1; length <= count; length++) {
      const resolved = await resolve(source.tail.slice(0, length).join('/'));
      if (!resolved) continue;
      const root = source.tail.slice(length).join('/');
      if (
        !root ||
        resolved.tree.some(
          (entry) =>
            entry.path === root &&
            (source.kind === 'blob'
              ? entry.type === 'blob'
              : entry.type === 'tree'),
        )
      )
        possibilities.push({ ...resolved, root });
    }
  }
  if (!possibilities.length) fail('source_not_found');
  if (possibilities.length !== 1) fail('source_ref_ambiguous');
  const selected = possibilities[0]!,
    prefix = selected.root ? selected.root + '/' : '';
  const discovered = selected.tree.filter((entry) =>
    source.kind === 'blob'
      ? entry.path === selected.root
      : entry.path.startsWith(prefix) &&
        entry.path.split('/').at(-1) === 'SKILL.md',
  );
  // SKILL.md templates inside a candidate's resources are bytes, not extra skills.
  const definitions = discovered.filter(
    (entry) =>
      !discovered.some((parent) => {
        if (parent === entry) return false;
        const directory = parent.path.slice(0, -'SKILL.md'.length);
        return (
          entry.path.startsWith(directory) &&
          /^(references|assets|scripts)\//.test(
            entry.path.slice(directory.length),
          )
        );
      }),
  );
  if (!definitions.length) fail('source_skill_missing');
  if (definitions.length > limits.candidates) fail('source_candidate_limit');
  const wanted = new Map<string, GitEntry>();
  for (const definition of definitions) {
    const directory = definition.path.slice(0, -'SKILL.md'.length);
    const resources = selected.tree.filter(
      (entry) =>
        entry.path.startsWith(directory) &&
        /^(references|assets|scripts)\//.test(
          entry.path.slice(directory.length),
        ) &&
        entry.type !== 'tree',
    );
    if (resources.length > limits.resources) fail('source_resource_limit');
    let size = 0;
    for (const entry of [definition, ...resources]) {
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))
        fail('source_link_unsupported');
      if (
        !shaPattern.test(entry.sha) ||
        typeof entry.size !== 'number' ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0
      )
        fail('source_blob_identity_invalid');
      const bound = entry === definition ? limits.source : limits.resource;
      if (entry.size > bound) fail('source_too_large');
      if (entry !== definition) size += entry.size;
      if (size > limits.resourceTotal) fail('source_resource_limit');
      wanted.set(entry.path, entry);
    }
    // An asset directory itself may be a symlink/submodule rather than a tree.
    for (const entry of selected.tree) {
      const relative = entry.path.slice(directory.length);
      if (
        entry.path.startsWith(directory) &&
        /^(references|assets|scripts)$/.test(relative) &&
        entry.type !== 'tree'
      )
        fail('source_link_unsupported');
    }
  }
  const entries = [...wanted.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  // Reuse the existing archive codec without widening its global Bridge bounds.
  if (entries.length > limits.archiveFiles) fail('source_archive_file_limit');
  if (entries.reduce((total, entry) => total + entry.size!, 0) > limits.total)
    fail('source_too_large');
  const files = [];
  // Metadata is pinned before any content is fetched. No code is executed.
  for (const entry of entries) {
    const address = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${selected.commitSha}/${quotePath(entry.path)}`;
    const content = await bytes(address, entry.size!);
    if (!content || content.byteLength !== entry.size)
      fail('source_blob_identity_invalid');
    const gitHash = createHash('sha1')
      .update(`blob ${content.length}\0`)
      .update(content)
      .digest('hex');
    if (gitHash !== entry.sha) fail('source_blob_identity_invalid');
    if (
      content
        .subarray(0, 80)
        .toString()
        .startsWith('version https://git-lfs.github.com/spec/v1')
    )
      fail('source_lfs_unsupported');
    files.push({
      path: entry.path,
      bytes: content,
      gitBlobSha: entry.sha,
      checksum: 'sha256:' + createHash('sha256').update(content).digest('hex'),
    });
  }
  return {
    files,
    candidatePaths: definitions.map((entry) => entry.path).sort(),
    provenance: {
      owner: source.owner,
      repository: source.repo,
      requestedUrl: url,
      resolvedRef: selected.ref,
      commitSha: selected.commitSha,
      treeSha: selected.treeSha,
      sourcePath: selected.root,
      license:
        repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION'
          ? {
              status: 'provider-metadata-only' as const,
              identifier: repo.license.spdx_id,
            }
          : { status: 'unknown' as const },
    },
    requestCount,
    credentialsUsed: false,
    codeExecuted: false,
  };
}
