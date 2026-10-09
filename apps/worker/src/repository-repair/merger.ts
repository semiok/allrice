import {
  readRepositoryMergeAction,
  startRepositoryMergeEffect,
  finishRepositoryMergeAction,
  repositoryMergeRequestGate,
  technicalDigest,
  validateRepositoryCiEvidence,
  type RepositoryActionLease,
  assertMaintenanceWriteAction,
} from '@allrice/database';
import { FixedRepositoryGithub } from './github.js';
import { inspectRepositoryCi } from './ci.js';
import { strictRepositoryMergePolicy } from './merge-policy.js';
export const repositoryMergeStore = {
  read: readRepositoryMergeAction,
  start: startRepositoryMergeEffect,
  finish: finishRepositoryMergeAction,
};
type Store = typeof repositoryMergeStore;
function fail(code: string): never {
  throw Error(code);
}
/** One exact candidate, one immutable intent per external write, no retries.
 * Reconciliation has fresh canonical authorization but only issues GETs. */
export async function mergeRepositoryCandidate(
  lease: RepositoryActionLease,
  signal: AbortSignal,
  options: {
    github?: FixedRepositoryGithub;
    store?: Store;
    inspectCi?: typeof inspectRepositoryCi;
  } = {},
) {
  const store = options.store ?? repositoryMergeStore,
    a = await store.read(lease),
    m = a.review.material;
  if (a.mode !== 'reconcile') assertMaintenanceWriteAction('merge');
  const github =
    options.github ??
    new FixedRepositoryGithub(
      () => repositoryMergeRequestGate(lease),
      signal,
      fetch,
      a.mode === 'reconcile',
    );
  await github.repository();
  const read = async () => {
    const pull = await github.mergePull(m.remote.number, m.remote.branch);
    if (pull.headSha !== m.metadata.commit) fail('REPOSITORY_MERGE_STALE');
    if (!pull.merged) return null;
    if (!a.mergeStarted && !a.receipt) fail('REPOSITORY_MERGE_EXTERNAL');
    const commit = await github.commit(pull.mergeSha!);
    if (
      !commit ||
      commit.tree !== m.metadata.tree ||
      commit.parents.length !== 2 ||
      commit.parents[0] !== m.source.baseSha ||
      commit.parents[1] !== m.metadata.commit
    )
      fail('REPOSITORY_MERGE_STALE');
    const main = await github.main();
    if (!(await github.mainContains(commit.sha, main)))
      fail('REPOSITORY_MERGE_STALE');
    return store.finish(lease, {
      version: 1,
      publicationId: m.publicationId,
      pullNumber: m.remote.number,
      subjectDigest: m.subjectDigest,
      baseSha: m.source.baseSha,
      headSha: m.metadata.commit,
      mergeSha: commit.sha,
      mergeTree: commit.tree,
      observedMainSha: main,
      observedAt: new Date().toISOString(),
    });
  };
  const prior = await read();
  if (prior) return prior;
  if (a.mode === 'reconcile' || a.mergeStarted)
    fail('REPOSITORY_MERGE_RESULT_UNKNOWN');
  async function preflight() {
    signal.throwIfAborted();
    const policy = strictRepositoryMergePolicy(await github.mainProtection());
    const pull = await github.mergePull(m.remote.number, m.remote.branch);
    if (
      pull.merged ||
      pull.state !== 'open' ||
      pull.headSha !== m.metadata.commit ||
      pull.baseSha !== m.source.baseSha ||
      (await github.main()) !== m.source.baseSha ||
      (await github.branch(m.remote.branch)) !== m.metadata.commit
    )
      fail('REPOSITORY_MERGE_STALE');
    const observed = await (options.inspectCi ?? inspectRepositoryCi)(
      github,
      {
        id: m.publicationId,
        source: m.source,
        metadata: m.metadata,
        remote: m.remote,
      },
      signal,
    );
    const { ci, evidence } = validateRepositoryCiEvidence(
      observed.observation,
      observed.evidence,
      m.source,
      m.metadata,
      m.remote,
    );
    const stable = (value: typeof ci) => ({
      ...value,
      observedAt: null,
      checks: [...value.checks].sort((a, b) =>
        a.name.localeCompare(b.name, 'en'),
      ),
      receipts: [...value.receipts].sort((a, b) =>
        a.name.localeCompare(b.name, 'en'),
      ),
    });
    if (
      ci.state !== 'passed' ||
      technicalDigest(stable(ci)) !== technicalDigest(stable(m.ci)) ||
      technicalDigest({
        sourceReportDigest: m.source.reportDigest,
        evidence: [...evidence].sort((a, b) =>
          a.receipt.job.localeCompare(b.receipt.job, 'en'),
        ),
      }) !== m.evidenceDigest
    )
      fail('REPOSITORY_MERGE_CURRENT_CI_REQUIRED');
    // Recheck after original artifact reads; no network occurs under DB locks.
    const finalPolicy = strictRepositoryMergePolicy(
      await github.mainProtection(),
    );
    if (
      finalPolicy.digest !== policy.digest ||
      (await github.main()) !== m.source.baseSha
    )
      fail('REPOSITORY_MERGE_STALE');
    return { policy, ci, pull };
  }
  let proof = await preflight();
  if (proof.pull.draft) {
    const first = await store.start(lease, 'ready', proof);
    if (first)
      try {
        await github.readyPull(
          m.remote.number,
          m.remote.branch,
          proof.pull.nodeId,
        );
      } catch {
        signal.throwIfAborted();
      }
    // A started but unacknowledged ready write is never replayed.
    const ready = await github.mergePull(m.remote.number, m.remote.branch);
    if (
      ready.draft ||
      ready.state !== 'open' ||
      ready.headSha !== m.metadata.commit
    )
      fail('REPOSITORY_READY_RESULT_UNKNOWN');
    proof = await preflight();
  }
  const first = await store.start(lease, 'merge', proof);
  a.mergeStarted = true;
  if (first)
    try {
      await github.mergeExactPull(m.remote.number, m.metadata.commit);
    } catch {
      signal.throwIfAborted();
    }
  const receipt = await read();
  if (!receipt) fail('REPOSITORY_MERGE_RESULT_UNKNOWN');
  return receipt;
}
