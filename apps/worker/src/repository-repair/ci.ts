import { repositoryDigest, technicalDigest } from '@allrice/database';
import {
  RepositoryPublicationCiSchema,
  repositoryRequiredChecks,
  platformRepository,
} from '@allrice/database/technical-contracts';
import { readRepositoryCiArtifact } from './ci-artifact.js';
import type { RepositoryCiInspector } from './publisher.js';
type ObjectRow = Record<string, unknown>;
function row(value: unknown): ObjectRow {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('CI_REMOTE_IDENTITY');
  return value as ObjectRow;
}
function number(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw Error('CI_REMOTE_IDENTITY');
  return Number(value);
}
function validRun(
  run: ObjectRow,
  workflowId: number,
  head: string,
  branch: string,
) {
  if (
    run.workflow_id !== workflowId ||
    run.head_sha !== head ||
    run.head_branch !== branch ||
    run.event !== 'pull_request' ||
    run.path !== '.github/workflows/ci.yml' ||
    row(run.repository).id !== platformRepository.id ||
    row(run.head_repository).id !== platformRepository.id
  )
    throw Error('CI_REMOTE_IDENTITY');
  number(run.id);
  number(run.run_attempt);
}
export const inspectRepositoryCi: RepositoryCiInspector = async (
  github,
  action,
  signal,
) => {
  const metadata = action.metadata,
    remote = action.remote,
    source = action.source;
  let observation = RepositoryPublicationCiSchema.parse({
    state: 'unknown',
    observedAt: new Date().toISOString(),
    workflowRunId: null,
    runAttempt: null,
    headSha: metadata?.commit ?? null,
    checkoutSha: null,
    checkoutTree: null,
    materialDigest: null,
    checks: [],
    receipts: [],
  });
  const result = () => ({ observation, evidence: [] });
  if (!metadata || !remote) return result();
  try {
    signal.throwIfAborted();
    const branch = `allrice/repairs/${action.id}`;
    const workflow = await github.workflow();
    if (
      workflow.path !== '.github/workflows/ci.yml' ||
      workflow.state !== 'active'
    )
      return result();
    const workflowId = number(workflow.id),
      runs = await github.workflowRuns(metadata.commit);
    if (!runs.length) {
      observation.state = 'pending';
      return result();
    }
    for (const run of runs) validRun(run, workflowId, metadata.commit, branch);
    const newest = [...runs].sort((a, b) => number(b.id) - number(a.id))[0]!,
      run = await github.workflowRun(number(newest.id));
    validRun(run, workflowId, metadata.commit, branch);
    observation.workflowRunId = number(run.id);
    observation.runAttempt = number(run.run_attempt);
    const jobs = await github.workflowJobs(
      observation.workflowRunId,
      observation.runAttempt,
    );
    if (
      jobs.length !== 4 ||
      new Set(jobs.map((j) => j.name)).size !== 4 ||
      jobs.some(
        (j) =>
          !repositoryRequiredChecks.includes(
            j.name as (typeof repositoryRequiredChecks)[number],
          ),
      )
    )
      return result();
    observation.checks = repositoryRequiredChecks.map((name) => {
      const j = jobs.find((j) => j.name === name)!;
      return {
        name,
        id: number(j.id),
        conclusion:
          j.status !== 'completed'
            ? 'pending'
            : j.conclusion === 'success'
              ? 'success'
              : j.conclusion === 'cancelled'
                ? 'cancelled'
                : j.conclusion === 'skipped'
                  ? 'skipped'
                  : j.conclusion === 'failure' || j.conclusion === 'timed_out'
                    ? 'failure'
                    : 'unknown',
      };
    });
    if (
      run.status !== 'completed' ||
      observation.checks.some((c) => c.conclusion === 'pending')
    ) {
      observation.state = 'pending';
      return result();
    }
    if (
      run.conclusion !== 'success' ||
      observation.checks.some((c) => c.conclusion !== 'success')
    ) {
      observation.state = 'failed';
      return result();
    }
    for (const job of jobs) {
      if (
        !Array.isArray(job.steps) ||
        !job.steps.some(
          (s) =>
            row(s).name === 'Record complete original CI gate' &&
            row(s).conclusion === 'success',
        )
      )
        return result();
      if (
        job.name === 'validate' &&
        !job.steps.some(
          (s) =>
            row(s).name === 'Build all workspace production packages' &&
            row(s).conclusion === 'success',
        )
      )
        return result();
    }
    const artifacts = await github.workflowArtifacts(observation.workflowRunId),
      evidence = [];
    for (const name of repositoryRequiredChecks) {
      signal.throwIfAborted();
      const entries = artifacts.filter(
        (a) => a.name === `repository-ci-${name}-${observation.runAttempt}`,
      );
      if (entries.length !== 1) return result();
      const artifact = entries[0]!,
        owner = row(artifact.workflow_run),
        artifactId = number(artifact.id);
      if (
        artifact.expired !== false ||
        !Number.isSafeInteger(artifact.size_in_bytes) ||
        Number(artifact.size_in_bytes) > 400000 ||
        owner.id !== observation.workflowRunId ||
        owner.repository_id !== platformRepository.id ||
        owner.head_repository_id !== platformRepository.id ||
        owner.head_sha !== metadata.commit ||
        typeof artifact.digest !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
      )
        return result();
      const bytes = await github.downloadArtifact(artifactId);
      if (repositoryDigest(bytes) !== artifact.digest) return result();
      const receipt = await readRepositoryCiArtifact(bytes);
      if (
        receipt.job !== name ||
        receipt.workflowRunId !== observation.workflowRunId ||
        receipt.runAttempt !== observation.runAttempt ||
        receipt.event !== 'pull_request' ||
        receipt.pullRequest !== remote.number ||
        receipt.headSha !== metadata.commit ||
        receipt.baseSha !== source.baseSha ||
        receipt.workflowBlob !== metadata.workflowBlob
      )
        return result();
      if (
        receipt.checkoutTree !== metadata.tree ||
        receipt.materialDigest !== source.candidateMaterialDigest ||
        receipt.rootLockChecksum !== source.rootLockChecksum ||
        receipt.dependencyConfigurationDigest !==
          source.dependencyConfigurationDigest
      ) {
        observation.state = 'stale';
        return result();
      }
      if (
        evidence.length &&
        receipt.checkoutSha !== evidence[0]!.receipt.checkoutSha
      ) {
        observation.state = 'stale';
        return result();
      }
      evidence.push({ artifactId, archiveDigest: artifact.digest, receipt });
    }
    const after = await github.workflowRun(observation.workflowRunId),
      latest = await github.workflowRuns(metadata.commit);
    validRun(after, workflowId, metadata.commit, branch);
    if (
      after.run_attempt !== observation.runAttempt ||
      after.status !== 'completed' ||
      after.conclusion !== 'success' ||
      latest.some((r) => number(r.id) > observation.workflowRunId!)
    ) {
      observation.state = 'pending';
      return result();
    }
    const pulls = await github.pulls(branch),
      main = await github.main(),
      head = await github.branch(branch);
    if (
      pulls.length !== 1 ||
      pulls[0]!.number !== remote.number ||
      pulls[0]!.state !== 'open' ||
      pulls[0]!.headSha !== metadata.commit ||
      pulls[0]!.baseSha !== source.baseSha ||
      head !== metadata.commit ||
      main !== source.baseSha
    ) {
      observation.state = 'stale';
      return result();
    }
    const receipt = evidence[0]!.receipt;
    observation = {
      ...observation,
      state: 'passed',
      checkoutSha: receipt.checkoutSha,
      checkoutTree: receipt.checkoutTree,
      materialDigest: receipt.materialDigest,
      receipts: evidence.map((e) => ({
        name: e.receipt.job,
        artifactId: e.artifactId,
        archiveDigest: e.archiveDigest,
        receiptDigest: technicalDigest(e.receipt),
      })),
    };
    return {
      observation: RepositoryPublicationCiSchema.parse(observation),
      evidence,
    };
  } catch {
    signal.throwIfAborted();
    observation.state = 'unknown';
    observation.receipts = [];
    return result();
  }
};
