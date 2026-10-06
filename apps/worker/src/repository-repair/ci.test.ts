import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { describe, it, expect, vi } from 'vitest';
import { repositoryDigest } from '@allrice/database';
import {
  RepositoryPublicationSourceSchema,
  repositoryRequiredChecks,
  platformRepository,
} from '@allrice/database/technical-contracts';
import { inspectRepositoryCi } from './ci.js';
import { readRepositoryCiArtifact } from './ci-artifact.js';
import type { FixedRepositoryGithub } from './github.js';
import type { repositoryPublicationStore } from './publisher.js';

async function fixture() {
  const head = 'a'.repeat(40),
    base = 'b'.repeat(40),
    tree = 'c'.repeat(40),
    workflowBlob = 'd'.repeat(40),
    checkout = 'e'.repeat(40),
    digest = repositoryDigest('source');
  const id = randomUUID(),
    branch = 'allrice/repairs/' + id;
  const action: Awaited<ReturnType<typeof repositoryPublicationStore.read>> = {
    id,
    mode: 'inspect',
    createdAt: new Date().toISOString(),
    steps: {},
    metadata: {
      tree,
      commit: head,
      workflowBlob,
      author: {
        login: 'fixture',
        userId: 1,
        timestamp: '2026-10-06T01:00:00Z',
        message: 'fix',
      },
    },
    remote: {
      repositoryId: platformRepository.id,
      repository: platformRepository.fullName,
      branch,
      number: 312,
      url: 'https://github.com/semiok/allrice/pull/312',
      headSha: head,
      baseSha: base,
      tree,
    },
    source: RepositoryPublicationSourceSchema.parse({
      version: 1,
      repairTaskId: randomUUID(),
      repairRunId: randomUUID(),
      repairJobId: randomUUID(),
      baseSha: base,
      baseTree: base,
      baselineSourceDigest: digest,
      candidateChecksum: digest,
      candidateMaterialDigest: digest,
      reportDigest: digest,
      rootLockChecksum: digest,
      dependencyConfigurationDigest: digest,
      beforeChecksum: digest,
      afterChecksum: digest,
      beforeBlob: base,
      afterBlob: head,
      afterBase64: 'YQ==',
      path: 'packages/project-runtime/src/command-output.ts',
      mode: '100644',
    }),
  };
  const run = {
    id: 100,
    workflow_id: 50,
    path: '.github/workflows/ci.yml',
    event: 'pull_request',
    head_sha: head,
    head_branch: branch,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    repository: { id: platformRepository.id },
    head_repository: { id: platformRepository.id },
    pull_requests: [],
  };
  const jobs = repositoryRequiredChecks.map((name, i) => ({
    id: 200 + i,
    name,
    status: 'completed',
    conclusion: 'success',
    steps: [
      { name: 'Record complete original CI gate', conclusion: 'success' },
      {
        name: 'Build all workspace production packages',
        conclusion: 'success',
      },
    ],
  }));
  const receipts = repositoryRequiredChecks.map((job) => ({
    version: 1,
    scope: 'allrice.repository-ci.v1',
    repositoryId: platformRepository.id,
    repository: platformRepository.fullName,
    workflowPath: '.github/workflows/ci.yml',
    workflowBlob,
    workflowRunId: 100,
    runAttempt: 1,
    job,
    event: 'pull_request',
    pullRequest: 312,
    headSha: head,
    baseSha: base,
    checkoutSha: checkout,
    checkoutTree: tree,
    materialDigest: digest,
    rootLockChecksum: digest,
    dependencyConfigurationDigest: digest,
    nodeVersion: 'v22.23.2',
    runnerOs: 'Linux',
    runnerArch: 'X64',
    build:
      job === 'validate'
        ? {
            rootScript: 'pnpm -r --if-present run build',
            packages: [
              {
                name: '@allrice/worker',
                path: 'apps/worker',
                scriptChecksum: digest,
                outputDigest: digest,
                fileCount: 4,
                sizeBytes: 10,
              },
            ],
          }
        : null,
  }));
  const archives = await Promise.all(
    receipts.map(async (r) =>
      new JSZip()
        .file('receipt.json', JSON.stringify(r))
        .generateAsync({ type: 'nodebuffer' }),
    ),
  );
  const artifacts = receipts.map((r, i) => ({
    id: 300 + i,
    name: `repository-ci-${r.job}-1`,
    expired: false,
    size_in_bytes: archives[i]!.length,
    digest: repositoryDigest(archives[i]!),
    workflow_run: {
      id: 100,
      repository_id: platformRepository.id,
      head_repository_id: platformRepository.id,
      head_sha: head,
    },
  }));
  const methods = {
    workflow: vi.fn(async () => ({
      id: 50,
      path: '.github/workflows/ci.yml',
      state: 'active',
    })),
    workflowRuns: vi.fn(async () => [structuredClone(run)]),
    workflowRun: vi.fn(async () => structuredClone(run)),
    workflowJobs: vi.fn(async () => structuredClone(jobs)),
    workflowArtifacts: vi.fn(async () => structuredClone(artifacts)),
    downloadArtifact: vi.fn(async (id: number) => archives[id - 300]!),
    pulls: vi.fn(async () => [
      { number: 312, state: 'open', headSha: head, baseSha: base },
    ]),
    main: vi.fn(async () => base),
    branch: vi.fn(async () => head),
  };
  return {
    action,
    run,
    jobs,
    receipts,
    archives,
    artifacts,
    methods,
    inspect: () =>
      inspectRepositoryCi(
        methods as unknown as FixedRepositoryGithub,
        action,
        new AbortController().signal,
      ),
  };
}
describe('original CI identity and complete build receipts', () => {
  it('binds all four original gates and the actual merge checkout independently of an empty API PR list', async () => {
    const f = await fixture();
    expect(await readRepositoryCiArtifact(f.archives[0]!)).toMatchObject({
      job: 'validate',
    });
    const result = await f.inspect();
    expect(result.observation).toMatchObject({
      state: 'passed',
      checkoutSha: 'e'.repeat(40),
      headSha: 'a'.repeat(40),
      runAttempt: 1,
    });
    expect(result.evidence).toHaveLength(4);
  });
  it.each(['pending', 'failure', 'cancelled'] as const)(
    'does not pass a %s gate',
    async (state) => {
      const f = await fixture();
      f.jobs[2]!.status = state === 'pending' ? 'in_progress' : 'completed';
      f.jobs[2]!.conclusion = state;
      expect((await f.inspect()).observation).toMatchObject({
        state: state === 'pending' ? 'pending' : 'failed',
        receipts: [],
      });
    },
  );
  it.each(['repository', 'workflow', 'head', 'build', 'digest'] as const)(
    'refuses mismatched or missing %s proof',
    async (kind) => {
      const f = await fixture();
      if (kind === 'repository')
        f.run.repository = { id: 1 as typeof platformRepository.id };
      if (kind === 'workflow') f.run.workflow_id = 1;
      if (kind === 'head') f.run.head_sha = 'f'.repeat(40);
      if (kind === 'build') f.jobs[0]!.steps = f.jobs[0]!.steps.slice(0, 1);
      if (kind === 'digest')
        f.artifacts[0]!.digest = repositoryDigest('wrong archive');
      expect((await f.inspect()).observation).toMatchObject({
        state: 'unknown',
        receipts: [],
      });
    },
  );
  it('invalidates a changed main, and refuses evidence from an earlier run attempt', async () => {
    const f = await fixture();
    f.methods.main.mockResolvedValue('f'.repeat(40));
    expect((await f.inspect()).observation).toMatchObject({
      state: 'stale',
      receipts: [],
    });
    const g = await fixture();
    g.methods.workflowRun
      .mockResolvedValueOnce(structuredClone(g.run))
      .mockResolvedValueOnce({ ...g.run, run_attempt: 2 });
    expect((await g.inspect()).observation).toMatchObject({
      state: 'pending',
      receipts: [],
    });
  });
  it('invalidates a different tested tree and rejects a receipt missing the completed root build', async () => {
    const f = await fixture();
    f.receipts[0]!.checkoutTree = 'f'.repeat(40);
    f.archives[0] = await new JSZip()
      .file('receipt.json', JSON.stringify(f.receipts[0]))
      .generateAsync({ type: 'nodebuffer' });
    f.artifacts[0]!.digest = repositoryDigest(f.archives[0]!);
    expect((await f.inspect()).observation).toMatchObject({
      state: 'stale',
      receipts: [],
    });
    f.receipts[0]!.build = null;
    const missing = await new JSZip()
      .file('receipt.json', JSON.stringify(f.receipts[0]))
      .generateAsync({ type: 'nodebuffer' });
    await expect(readRepositoryCiArtifact(missing)).rejects.toMatchObject({
      code: 'REPOSITORY_REMOTE_INVALID',
    });
  });
  it('rejects extra ZIP entries and bounded decompression before parsing a receipt', async () => {
    const extra = await new JSZip()
      .file('receipt.json', '{}')
      .file('foreign.json', '{}')
      .generateAsync({ type: 'nodebuffer' });
    const oversized = await new JSZip()
      .file('receipt.json', 'x'.repeat(100001))
      .generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    for (const bytes of [extra, oversized])
      await expect(readRepositoryCiArtifact(bytes)).rejects.toMatchObject({
        code: 'REPOSITORY_REMOTE_INVALID',
      });
  });
});
