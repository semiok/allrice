import {
  readRepositoryAction,
  freezeRepositoryPublicationMetadata,
  startRepositoryPublicationStep,
  confirmRepositoryPublicationStep,
  recordRepositoryCiObservation,
  finishRepositoryAction,
  gitTreeForBlobs,
  gitBlobId,
  repositoryDigest,
  repositoryCommitIdentity,
  repositoryRequestGate,
  type RepositoryActionLease,
} from '@allrice/database';
import {
  platformRepository,
  type RepositoryPublicationStep,
} from '@allrice/database/technical-contracts';
import { FixedRepositoryGithub, RepositoryRemoteError } from './github.js';

export const repositoryPublicationStore = {
  read: readRepositoryAction,
  freeze: freezeRepositoryPublicationMetadata,
  start: startRepositoryPublicationStep,
  confirm: confirmRepositoryPublicationStep,
  observe: recordRepositoryCiObservation,
  finish: finishRepositoryAction,
};
type Store = typeof repositoryPublicationStore;
export type RepositoryCiInspector = (
  github: FixedRepositoryGithub,
  action: Pick<
    Awaited<ReturnType<Store['read']>>,
    'id' | 'source' | 'metadata' | 'remote'
  >,
  signal: AbortSignal,
) => Promise<{ observation: unknown; evidence: unknown[] }>;
const conflict = () => new RepositoryRemoteError('REPOSITORY_REMOTE_CONFLICT');

/** Each POST has one persistent START; a lost response is resolved only by exact GETs. */
export async function publishRepositoryCandidate(
  lease: RepositoryActionLease,
  signal: AbortSignal,
  options: {
    github?: FixedRepositoryGithub;
    store?: Store;
    inspectCi?: RepositoryCiInspector;
  } = {},
) {
  const github =
      options.github ??
      new FixedRepositoryGithub(() => repositoryRequestGate(lease), signal),
    store = options.store ?? repositoryPublicationStore;
  const action = await store.read(lease),
    source = action.source,
    branch = `allrice/repairs/${action.id}`;
  async function observeUnknown(state: 'unknown' | 'stale' = 'unknown') {
    await store.observe(lease, {
      state,
      observedAt: new Date().toISOString(),
      workflowRunId: null,
      runAttempt: null,
      headSha: action.metadata?.commit ?? null,
      checkoutSha: null,
      checkoutTree: null,
      materialDigest: null,
      checks: [],
    });
  }
  async function finishUnknown(state: 'unknown' | 'stale' = 'unknown') {
    await observeUnknown(state);
    return store.finish(lease);
  }
  try {
    await github.repository();
    const currentBase = await github.main();
    if (action.mode === 'publish' && currentBase !== source.baseSha)
      throw conflict();
    const base = await github.commit(source.baseSha);
    if (!base || base.tree !== source.baseTree) throw conflict();
    const before = await github.blob(source.beforeBlob);
    if (
      !before ||
      gitBlobId(before) !== source.beforeBlob ||
      repositoryDigest(before) !== source.beforeChecksum
    )
      throw conflict();
    const files = await github.recursiveTree(source.baseTree);
    if (gitTreeForBlobs(files) !== source.baseTree) throw conflict();
    const original = files.find((f) => f.path === source.path);
    if (
      !original ||
      original.mode !== source.mode ||
      original.sha !== source.beforeBlob
    )
      throw conflict();
    const tree = gitTreeForBlobs(
      files.map((f) =>
        f.path === source.path ? { ...f, sha: source.afterBlob } : f,
      ),
    );
    const workflow = files.find((f) => f.path === '.github/workflows/ci.yml');
    if (!workflow) throw conflict();
    if (!action.metadata) {
      if (action.mode === 'inspect') return finishUnknown();
      const user = await github.user(),
        author = {
          login: user.login,
          userId: user.id,
          timestamp: action.createdAt.replace(/\.\d{3}Z$/, 'Z'),
          message: 'fix: redact command output credentials',
        };
      action.metadata = await store.freeze(lease, {
        tree,
        workflowBlob: workflow.sha,
        commit: repositoryCommitIdentity(tree, source.baseSha, author).sha,
        author,
      });
    }
    const metadata = action.metadata;
    if (
      metadata.tree !== tree ||
      metadata.workflowBlob !== workflow.sha ||
      repositoryCommitIdentity(tree, source.baseSha, metadata.author).sha !==
        metadata.commit
    )
      throw conflict();
    async function step(
      name: RepositoryPublicationStep,
      write: () => Promise<void>,
      read: () => Promise<string | Record<string, unknown> | null>,
    ) {
      signal.throwIfAborted();
      const previous = action.steps[name];
      if (action.mode === 'inspect' && !previous) return false;
      const first =
        action.mode === 'publish' && (await store.start(lease, name));
      if (first) {
        try {
          await write();
        } catch {
          // Even a timeout can mean committed remotely. Never retry this write.
          signal.throwIfAborted();
        }
      }
      const identity = await read();
      if (identity === null) {
        if (action.mode === 'publish')
          throw new RepositoryRemoteError('REPOSITORY_REMOTE_UNAVAILABLE');
        return false;
      }
      await store.confirm(lease, name, identity);
      return true;
    }
    const blob = await step(
      'blob',
      () => github.createBlob(source.afterBase64),
      async () => {
        const bytes = await github.blob(source.afterBlob);
        if (!bytes) return null;
        if (
          gitBlobId(bytes) !== source.afterBlob ||
          repositoryDigest(bytes) !== source.afterChecksum
        )
          throw conflict();
        return source.afterBlob;
      },
    );
    if (!blob) return finishUnknown();
    const treeDone = await step(
      'tree',
      () =>
        github.createTree(
          source.baseTree,
          source.path,
          source.mode,
          source.afterBlob,
        ),
      async () => {
        if (!(await github.tree(tree))) return null;
        const actual = await github.recursiveTree(tree);
        if (
          gitTreeForBlobs(actual) !== tree ||
          technicalTree(actual) !==
            technicalTree(
              files.map((f) =>
                f.path === source.path ? { ...f, sha: source.afterBlob } : f,
              ),
            )
        )
          throw conflict();
        return tree;
      },
    );
    if (!treeDone) return finishUnknown();
    const commitDone = await step(
      'commit',
      () =>
        github.createCommit(
          repositoryCommitIdentity(tree, source.baseSha, metadata.author)
            .payload,
        ),
      async () => {
        const commit = await github.commit(metadata.commit);
        if (!commit) return null;
        if (
          commit.tree !== tree ||
          commit.parents.length !== 1 ||
          commit.parents[0] !== source.baseSha
        )
          throw conflict();
        return metadata.commit;
      },
    );
    if (!commitDone) return finishUnknown();
    const branchDone = await step(
      'branch',
      () => github.createBranch(branch, metadata.commit),
      async () => {
        const actual = await github.branch(branch);
        if (actual && actual !== metadata.commit) throw conflict();
        return actual;
      },
    );
    if (!branchDone) return finishUnknown();
    if (action.mode === 'publish' && (await github.main()) !== source.baseSha)
      throw conflict();
    const pullDone = await step(
      'pull',
      () => github.createPull(branch, action.id),
      async () => {
        const rows = await github.pulls(branch);
        if (!rows.length) return null;
        if (rows.length !== 1) throw conflict();
        const pull = rows[0]!;
        if (
          pull.headSha !== metadata.commit ||
          pull.baseSha !== source.baseSha ||
          (action.mode === 'publish' && pull.state !== 'open')
        )
          throw conflict();
        return {
          repositoryId: platformRepository.id,
          repository: platformRepository.fullName,
          branch,
          number: pull.number,
          url: pull.url,
          headSha: metadata.commit,
          baseSha: source.baseSha,
          tree,
        };
      },
    );
    if (pullDone && options.inspectCi) {
      const current = await store.read(lease);
      const inspected = await options.inspectCi(github, current, signal);
      await store.observe(lease, inspected.observation, inspected.evidence);
    }
    if (!pullDone || (action.mode === 'inspect' && !options.inspectCi))
      return finishUnknown();
    return store.finish(lease);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof RepositoryRemoteError) {
      const state =
        error.code === 'REPOSITORY_REMOTE_CONFLICT' ? 'stale' : 'unknown';
      if (action.mode === 'inspect') return finishUnknown(state);
      await observeUnknown(state);
    }
    throw error;
  }
}
function technicalTree(
  files: Array<{ path: string; mode: string; sha: string }>,
) {
  return JSON.stringify(
    [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
}
