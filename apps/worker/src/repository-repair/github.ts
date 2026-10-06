import { platformRepository } from '@allrice/database/technical-contracts';

const api = 'https://api.github.com';
const prefix = `/repos/${platformRepository.fullName}`;
const shaPattern = /^[a-f0-9]{40}$/;
const loginPattern = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/;
export class RepositoryRemoteError extends Error {
  constructor(
    public readonly code:
      | 'REPOSITORY_REMOTE_UNAVAILABLE'
      | 'REPOSITORY_REMOTE_CONFLICT'
      | 'REPOSITORY_REMOTE_INVALID',
    public readonly status: number | null = null,
  ) {
    super(code);
  }
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
  return raw as Record<string, unknown>;
}
function sha(raw: unknown) {
  if (typeof raw !== 'string' || !shaPattern.test(raw))
    throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
  return raw;
}
function positive(raw: unknown) {
  if (!Number.isSafeInteger(raw) || Number(raw) < 1)
    throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
  return Number(raw);
}
export interface RepositoryRemotePull {
  number: number;
  url: string;
  headSha: string;
  baseSha: string;
  draft: boolean;
  state: 'open' | 'closed';
}
export interface RepositoryGithubGate {
  (): Promise<{ token: string; remainingMs: number }>;
}

/** Trusted Worker transport. No model URL, automatic redirect or raw-error echo. */
export class FixedRepositoryGithub {
  constructor(
    private readonly gate: RepositoryGithubGate,
    private readonly signal: AbortSignal,
    private readonly fetcher: typeof fetch = fetch,
    private readonly readOnly = false,
  ) {}
  private async request(
    path: string,
    method: 'GET' | 'POST' | 'PUT' = 'GET',
    payload?: unknown,
  ) {
    if (this.readOnly && method !== 'GET')
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    this.signal.throwIfAborted();
    const { token, remainingMs } = await this.gate();
    if (!token.startsWith('github_pat_') || remainingMs < 1)
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_UNAVAILABLE');
    // Every caller below constructs a fixed endpoint; queries never change the origin.
    if (
      !(
        path === '/user' ||
        path === '/graphql' ||
        path.startsWith(prefix + '/') ||
        path === prefix
      ) ||
      /[\r\n\0]/.test(path)
    )
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    if (body && Buffer.byteLength(body) > 100_000)
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    let response: Response;
    try {
      response = await this.fetcher(api + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
          'user-agent': 'AllRice-Platform-Repository',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        redirect: 'manual',
        signal: AbortSignal.any([
          this.signal,
          AbortSignal.timeout(Math.min(10_000, remainingMs)),
        ]),
        ...(body ? { body } : {}),
      });
    } catch {
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_UNAVAILABLE');
    }
    if (response.status === 404 && method === 'GET') {
      await response.body?.cancel();
      return null;
    }
    if (response.status < 200 || response.status > 299) {
      await response.body?.cancel();
      throw new RepositoryRemoteError(
        response.status === 409 || response.status === 422
          ? 'REPOSITORY_REMOTE_CONFLICT'
          : 'REPOSITORY_REMOTE_UNAVAILABLE',
        response.status,
      );
    }
    if (!response.body)
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 2_000_000)
          throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
        chunks.push(next.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  async repository() {
    const row = object(await this.request(prefix));
    if (
      row.id !== platformRepository.id ||
      row.full_name !== platformRepository.fullName
    )
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    return { id: platformRepository.id, fullName: platformRepository.fullName };
  }
  async user() {
    const row = object(await this.request('/user'));
    if (typeof row.login !== 'string' || !loginPattern.test(row.login))
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    return { id: positive(row.id), login: row.login };
  }
  async main() {
    const row = object(await this.request(prefix + '/git/ref/heads/main'));
    if (row.ref !== 'refs/heads/main')
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    return sha(object(row.object).sha);
  }
  async commit(id: string) {
    const raw = await this.request(prefix + '/git/commits/' + sha(id));
    if (raw === null) return null;
    const row = object(raw);
    if (sha(row.sha) !== id || !Array.isArray(row.parents))
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    return {
      sha: id,
      tree: sha(object(row.tree).sha),
      parents: row.parents.map((p) => sha(object(p).sha)),
    };
  }
  async blob(id: string) {
    const raw = await this.request(prefix + '/git/blobs/' + sha(id));
    if (raw === null) return null;
    const row = object(raw);
    if (
      sha(row.sha) !== id ||
      row.encoding !== 'base64' ||
      typeof row.content !== 'string' ||
      row.content.length > 70_000 ||
      !Number.isSafeInteger(row.size) ||
      Number(row.size) > 50_000
    )
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    const text = row.content.replace(/\n/g, ''),
      bytes = Buffer.from(text, 'base64');
    if (bytes.toString('base64') !== text || bytes.length !== row.size)
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    return bytes;
  }
  async tree(id: string) {
    const raw = await this.request(prefix + '/git/trees/' + sha(id));
    if (raw === null) return null;
    const row = object(raw);
    if (
      sha(row.sha) !== id ||
      row.truncated !== false ||
      !Array.isArray(row.tree)
    )
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    return id;
  }
  async recursiveTree(id: string) {
    const row = object(
      await this.request(prefix + '/git/trees/' + sha(id) + '?recursive=1'),
    );
    if (
      sha(row.sha) !== id ||
      row.truncated !== false ||
      !Array.isArray(row.tree) ||
      row.tree.length > 10000
    )
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    return row.tree.flatMap((raw) => {
      const e = object(raw);
      if (e.type === 'tree' && e.mode === '040000') return [];
      if (
        e.type !== 'blob' ||
        !['100644', '100755'].includes(String(e.mode)) ||
        typeof e.path !== 'string'
      )
        throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
      return [{ path: e.path, mode: String(e.mode), sha: sha(e.sha) }];
    });
  }
  async branch(name: string) {
    this.branchName(name);
    const raw = await this.request(prefix + '/git/ref/heads/' + name);
    if (raw === null) return null;
    const row = object(raw);
    if (row.ref !== 'refs/heads/' + name)
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    return sha(object(row.object).sha);
  }
  private branchName(name: string) {
    if (
      !/^allrice\/repairs\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        name,
      )
    )
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
  }
  private pull(raw: unknown, branch: string): RepositoryRemotePull {
    const row = object(raw),
      head = object(row.head),
      base = object(row.base);
    const number = positive(row.number),
      url = `https://github.com/${platformRepository.fullName}/pull/${number}`;
    if (
      row.html_url !== url ||
      head.ref !== branch ||
      base.ref !== 'main' ||
      object(head.repo).id !== platformRepository.id ||
      object(base.repo).id !== platformRepository.id ||
      typeof row.draft !== 'boolean' ||
      !['open', 'closed'].includes(String(row.state))
    )
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    return {
      number,
      url,
      headSha: sha(head.sha),
      baseSha: sha(base.sha),
      draft: row.draft,
      state: row.state as 'open' | 'closed',
    };
  }
  async pulls(branch: string) {
    this.branchName(branch);
    const query = new URLSearchParams({
      state: 'all',
      head: `semiok:${branch}`,
      base: 'main',
      per_page: '100',
    });
    const raw = await this.request(prefix + '/pulls?' + query);
    if (!Array.isArray(raw) || raw.length >= 100)
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    return raw.map((p) => this.pull(p, branch));
  }
  async mergePull(number: number, branch: string) {
    this.branchName(branch);
    const row = object(
        await this.request(prefix + '/pulls/' + positive(number)),
      ),
      pull = this.pull(row, branch);
    if (
      pull.number !== number ||
      typeof row.node_id !== 'string' ||
      row.node_id.length > 200 ||
      typeof row.merged !== 'boolean' ||
      (row.merged && row.state !== 'closed')
    )
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    return {
      ...pull,
      nodeId: row.node_id,
      merged: row.merged,
      mergeSha: row.merged ? sha(row.merge_commit_sha) : null,
    };
  }
  async mainProtection() {
    return this.request(prefix + '/branches/main/protection');
  }
  async readyPull(number: number, branch: string, nodeId: string) {
    const pull = await this.mergePull(number, branch);
    if (pull.nodeId !== nodeId || pull.state !== 'open' || pull.merged)
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_CONFLICT');
    await this.request('/graphql', 'POST', {
      query:
        'mutation AllRiceReady($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft}}}',
      variables: { id: nodeId },
    });
  }
  async mergeExactPull(number: number, headSha: string) {
    // A single server-side head condition. The caller also requires current
    // strict/admin-enforced base protection; it never invokes an admin bypass.
    await this.request(
      prefix + '/pulls/' + positive(number) + '/merge',
      'PUT',
      { sha: sha(headSha), merge_method: 'merge' },
    );
  }
  async mainContains(mergeSha: string, mainSha: string) {
    if (mergeSha === mainSha) return true;
    const row = object(
      await this.request(
        prefix + '/compare/' + sha(mergeSha) + '...' + sha(mainSha),
      ),
    );
    return (
      row.status === 'ahead' &&
      object(row.base_commit).sha === mergeSha &&
      object(row.merge_base_commit).sha === mergeSha
    );
  }
  async createBlob(contentBase64: string) {
    await this.request(prefix + '/git/blobs', 'POST', {
      content: contentBase64,
      encoding: 'base64',
    });
  }
  async createTree(
    baseTree: string,
    path: string,
    mode: '100644' | '100755',
    blob: string,
  ) {
    // The path cannot be selected by model or browser input.
    if (path !== 'packages/project-runtime/src/command-output.ts')
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    await this.request(prefix + '/git/trees', 'POST', {
      base_tree: sha(baseTree),
      tree: [{ path, mode, type: 'blob', sha: sha(blob) }],
    });
  }
  async createCommit(payload: {
    tree: string;
    parents: string[];
    message: string;
    author: { name: string; email: string; date: string };
    committer: { name: string; email: string; date: string };
  }) {
    await this.request(prefix + '/git/commits', 'POST', payload);
  }
  async createBranch(branch: string, commit: string) {
    this.branchName(branch);
    await this.request(prefix + '/git/refs', 'POST', {
      ref: 'refs/heads/' + branch,
      sha: sha(commit),
    });
  }
  async createPull(branch: string, publicationId: string) {
    this.branchName(branch);
    if (branch !== 'allrice/repairs/' + publicationId)
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    await this.request(prefix + '/pulls', 'POST', {
      head: branch,
      base: 'main',
      draft: true,
      title: 'fix: candidate command output redaction',
      body: `AllRice fixed repository candidate ${publicationId}.\n\nOnly the approved command-output replacement is included. Existing CI and independent review are required before merge.`,
    });
  }
  async workflow() {
    return object(await this.request(prefix + '/actions/workflows/ci.yml'));
  }
  async workflowRuns(headSha: string) {
    const row = object(
      await this.request(
        prefix +
          '/actions/workflows/ci.yml/runs?' +
          new URLSearchParams({
            event: 'pull_request',
            head_sha: sha(headSha),
            per_page: '20',
          }),
      ),
    );
    if (
      !Array.isArray(row.workflow_runs) ||
      !Number.isSafeInteger(row.total_count) ||
      Number(row.total_count) < row.workflow_runs.length ||
      Number(row.total_count) >= 20
    )
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    return row.workflow_runs.map(object);
  }
  async workflowRun(id: number) {
    return object(await this.request(prefix + '/actions/runs/' + positive(id)));
  }
  async workflowJobs(id: number, attempt: number) {
    const row = object(
      await this.request(
        prefix +
          '/actions/runs/' +
          positive(id) +
          '/attempts/' +
          positive(attempt) +
          '/jobs?per_page=100',
      ),
    );
    if (
      !Array.isArray(row.jobs) ||
      !Number.isSafeInteger(row.total_count) ||
      Number(row.total_count) < row.jobs.length ||
      Number(row.total_count) >= 100
    )
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    return row.jobs.map(object);
  }
  async workflowArtifacts(id: number) {
    const row = object(
      await this.request(
        prefix + '/actions/runs/' + positive(id) + '/artifacts?per_page=100',
      ),
    );
    if (
      !Array.isArray(row.artifacts) ||
      !Number.isSafeInteger(row.total_count) ||
      Number(row.total_count) < row.artifacts.length ||
      Number(row.total_count) >= 100
    )
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    return row.artifacts.map(object);
  }
  async downloadArtifact(id: number) {
    this.signal.throwIfAborted();
    const first = await this.gate();
    if (first.remainingMs < 1)
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_UNAVAILABLE');
    let ticket: Response;
    try {
      ticket = await this.fetcher(
        api + prefix + '/actions/artifacts/' + positive(id) + '/zip',
        {
          headers: {
            authorization: 'Bearer ' + first.token,
            'X-GitHub-Api-Version': '2026-03-10',
            accept: 'application/vnd.github+json',
          },
          redirect: 'manual',
          signal: AbortSignal.any([
            this.signal,
            AbortSignal.timeout(Math.min(10000, first.remainingMs)),
          ]),
        },
      );
    } catch {
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_UNAVAILABLE');
    }
    await ticket.body?.cancel();
    if (ticket.status !== 302)
      throw new RepositoryRemoteError(
        'REPOSITORY_REMOTE_UNAVAILABLE',
        ticket.status,
      );
    let url: URL;
    try {
      url = new URL(ticket.headers.get('location') ?? '');
    } catch {
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    }
    // GitHub's documented artifact storage hosts; the signed ticket is never stored or returned.
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !(
        url.hostname === 'results-receiver.actions.githubusercontent.com' ||
        /^[a-z0-9]+\.blob\.core\.windows\.net$/.test(url.hostname)
      )
    )
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    const next = await this.gate();
    if (next.remainingMs < 1)
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_UNAVAILABLE');
    let response: Response;
    try {
      response = await this.fetcher(url, {
        redirect: 'manual',
        signal: AbortSignal.any([
          this.signal,
          AbortSignal.timeout(Math.min(10000, next.remainingMs)),
        ]),
      });
    } catch {
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_UNAVAILABLE');
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const value = await reader.read();
        if (value.done) break;
        size += value.value.byteLength;
        if (size > 400000)
          throw new RepositoryRemoteError('REPOSITORY_REMOTE_INVALID');
        chunks.push(value.value);
      }
      return Buffer.concat(chunks);
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}
