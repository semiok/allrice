import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  gitBlobId,
  gitTreeForBlobs,
  repositoryDigest,
} from '@allrice/database';
import {
  RepositoryPublicationSourceSchema,
  platformRepository,
  type RepositoryPublicationStep,
} from '@allrice/database/technical-contracts';
import { FixedRepositoryGithub } from './github.js';
import {
  publishRepositoryCandidate,
  type repositoryPublicationStore,
} from './publisher.js';

function fixture(
  lostAck?: RepositoryPublicationStep,
  maintenance = false,
  revokeAfter?: RepositoryPublicationStep,
) {
  const id = randomUUID(),
    before = Buffer.from('original'),
    after = Buffer.from('corrected');
  const files = [
    {
      path: 'packages/project-runtime/src/command-output.ts',
      mode: '100644',
      sha: gitBlobId(before),
    },
    {
      path: '.github/workflows/ci.yml',
      mode: '100644',
      sha: gitBlobId(Buffer.from('CI')),
    },
  ];
  const base = 'a'.repeat(40),
    baseTree = gitTreeForBlobs(files),
    tree = gitTreeForBlobs(
      files.map((f) =>
        f.path.endsWith('command-output.ts')
          ? { ...f, sha: gitBlobId(after) }
          : f,
      ),
    );
  const digest = repositoryDigest('fixture');
  const source = RepositoryPublicationSourceSchema.parse({
    version: maintenance ? 2 : 1,
    ...(maintenance
      ? {
          maintenance: {
            grantId: randomUUID(),
            grantDigest: digest,
            attemptId: randomUUID(),
            verificationPlanDigest: digest,
            manifestDigest: digest,
          },
        }
      : {}),
    repairTaskId: randomUUID(),
    repairRunId: randomUUID(),
    repairJobId: randomUUID(),
    baseSha: base,
    baseTree,
    baselineSourceDigest: digest,
    candidateChecksum: digest,
    candidateMaterialDigest: digest,
    reportDigest: digest,
    rootLockChecksum: digest,
    dependencyConfigurationDigest: digest,
    beforeChecksum: repositoryDigest(before),
    afterChecksum: repositoryDigest(after),
    beforeBlob: gitBlobId(before),
    afterBlob: gitBlobId(after),
    afterBase64: after.toString('base64'),
    path: files[0]!.path,
    mode: '100644',
  });
  let active = true,
    main = base,
    branch: string | null = null,
    pulls: unknown[] = [],
    gateCalls = 0;
  const remote = new Set<RepositoryPublicationStep>(),
    postCounts: Partial<Record<RepositoryPublicationStep, number>> = {};
  const action: Awaited<ReturnType<typeof repositoryPublicationStore.read>> = {
    ...(maintenance && source.version === 2
      ? {
          provenance: {
            version: 1 as const,
            companySlug: 'test-company',
            companyName: 'Synthetic company',
            deploymentName: 'Isolated test',
            deploymentId: randomUUID(),
            installedReleaseSha: base,
            reportId: randomUUID(),
            reportDigest: digest,
            diagnosisId: randomUUID(),
            diagnosisDigest: digest,
            defectId: randomUUID(),
            grantId: source.maintenance.grantId,
            grantDigest: digest,
            attemptId: source.maintenance.attemptId,
            targetSha: base,
            verificationPlanDigest: digest,
            githubBot: { revision: 1, login: 'rice-maintenance', userId: 10 },
          },
        }
      : {}),
    id,
    mode: 'publish',
    source,
    createdAt: '2026-10-06T01:00:00.000Z',
    metadata: null,
    steps: {},
    remote: null,
  };
  const lease = {
    workerId: randomUUID(),
    jobId: randomUUID(),
    leaseToken: randomUUID(),
    attempt: 1,
  };
  const gate = async (method: 'GET' | 'POST' | 'PUT' = 'POST') => {
    gateCalls++;
    if (!active && (!maintenance || method !== 'GET'))
      throw Error('AUTH_REVOKED');
    return { token: 'github_pat_SyntheticOnly', remainingMs: 120000 };
  };
  const store: typeof repositoryPublicationStore = {
    read: async () => {
      await gate('GET');
      return structuredClone(action);
    },
    freeze: async (_l, raw) => {
      await gate();
      action.metadata = raw as NonNullable<typeof action.metadata>;
      return action.metadata;
    },
    start: async (_l, step) => {
      await gate();
      if (action.steps[step]) return false;
      action.steps[step] = {
        state: 'started',
        intentDigest: digest,
        startedActionId: randomUUID(),
        startedAttempt: 1,
      };
      return true;
    },
    confirm: async (_l, step, raw) => {
      await gate('GET');
      action.steps[step]!.state = 'confirmed';
      if (step === 'pull') action.remote = raw as typeof action.remote;
    },
    observe: vi.fn(async () => {}),
    finish: async () => {
      await gate('GET');
      return { publicationId: id, action: action.mode };
    },
  };
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const labels = new Set<string>(['unrelated']);
  const namedLabels = new Set<string>();
  const fetcher = (async (input, init) => {
    const path = new URL(String(input)).pathname.replace(
      '/repos/semiok/allrice',
      '',
    );
    if (init?.method === 'POST') {
      const payload = JSON.parse(String(init.body));
      const step: RepositoryPublicationStep =
        path === '/labels'
          ? payload.name === 'allrice-maintenance'
            ? 'maintenance_label'
            : 'company_label'
          : path === '/issues/312/labels'
            ? 'labels'
            : path === '/git/blobs'
              ? 'blob'
              : path === '/git/trees'
                ? 'tree'
                : path === '/git/commits'
                  ? 'commit'
                  : path === '/git/refs'
                    ? 'branch'
                    : 'pull';
      postCounts[step] = (postCounts[step] ?? 0) + 1;
      remote.add(step);
      if (step === 'maintenance_label' || step === 'company_label')
        namedLabels.add(payload.name);
      if (step === 'labels')
        payload.labels.forEach((name: string) => labels.add(name));
      if (step === 'branch') branch = action.metadata!.commit;
      if (step === 'pull')
        pulls = [
          {
            ...(maintenance
              ? {
                  user: { id: 10, login: 'rice-maintenance' },
                  title: payload.title,
                  body: payload.body,
                }
              : {}),
            number: 312,
            html_url: 'https://github.com/semiok/allrice/pull/312',
            draft: true,
            state: 'open',
            head: {
              ref: `allrice/repairs/${id}`,
              sha: action.metadata!.commit,
              repo: { id: platformRepository.id },
            },
            base: {
              ref: 'main',
              sha: base,
              repo: { id: platformRepository.id },
            },
          },
        ];
      if (step === revokeAfter) active = false;
      if (step === lostAck) throw Error('response lost after remote commit');
      return json({});
    }
    if (path === '')
      return json({
        id: platformRepository.id,
        full_name: platformRepository.fullName,
      });
    if (path === '/user')
      return json({
        id: 10,
        login: maintenance ? 'rice-maintenance' : 'operator',
      });
    if (path.startsWith('/labels/')) {
      const name = decodeURIComponent(path.slice(8));
      return namedLabels.has(name) ? json({ name }) : json({}, 404);
    }
    if (path === '/issues/312/labels')
      return json([...labels].map((name) => ({ name })));
    if (path === '/git/ref/heads/main')
      return json({ ref: 'refs/heads/main', object: { sha: main } });
    if (path === `/git/commits/${base}`)
      return json({ sha: base, tree: { sha: baseTree }, parents: [] });
    if (path === `/git/blobs/${source.beforeBlob}`)
      return json({
        sha: source.beforeBlob,
        encoding: 'base64',
        size: before.length,
        content: before.toString('base64'),
      });
    if (path === `/git/blobs/${source.afterBlob}`)
      return remote.has('blob')
        ? json({
            sha: source.afterBlob,
            encoding: 'base64',
            size: after.length,
            content: after.toString('base64'),
          })
        : json({}, 404);
    if (path === `/git/trees/${baseTree}`)
      return json({
        sha: baseTree,
        truncated: false,
        tree: files.map((f) => ({ ...f, type: 'blob' })),
      });
    if (path === `/git/trees/${tree}`)
      return remote.has('tree')
        ? json({
            sha: tree,
            truncated: false,
            tree: files.map((f) => ({
              ...f,
              sha: f.path === source.path ? source.afterBlob : f.sha,
              type: 'blob',
            })),
          })
        : json({}, 404);
    if (path.startsWith('/git/commits/'))
      return remote.has('commit')
        ? json({
            sha: action.metadata!.commit,
            tree: { sha: tree },
            parents: [{ sha: base }],
          })
        : json({}, 404);
    if (path === `/git/ref/heads/allrice/repairs/${id}`)
      return branch
        ? json({
            ref: `refs/heads/allrice/repairs/${id}`,
            object: { sha: branch },
          })
        : json({}, 404);
    if (path === '/pulls') return json(pulls);
    throw Error('unexpected fixed endpoint');
  }) as typeof fetch;
  const github = new FixedRepositoryGithub(
    gate,
    new AbortController().signal,
    fetcher,
  );
  return {
    action,
    lease,
    store,
    github,
    postCounts,
    remote,
    files,
    labels,
    corruptPull: () => {
      (pulls[0] as Record<string, unknown>).user = {
        id: 999,
        login: 'foreign',
      };
    },
    run: () =>
      publishRepositoryCandidate(lease, new AbortController().signal, {
        github,
        store,
      }),
    revoke: () => {
      active = false;
    },
    setMain: (sha: string) => {
      main = sha;
    },
    setBranch: (sha: string) => {
      branch = sha;
    },
    gateCalls: () => gateCalls,
  };
}
describe('fixed candidate publication single-write recovery', () => {
  it.each(['blob', 'tree', 'commit', 'branch', 'pull'] as const)(
    'reads the exact %s after a lost response and never duplicates the PR',
    async (step) => {
      const f = fixture(step);
      await f.run();
      await f.run();
      expect(f.postCounts).toEqual({
        blob: 1,
        tree: 1,
        commit: 1,
        branch: 1,
        pull: 1,
      });
      expect(f.action.remote?.tree).toBe(f.action.metadata?.tree);
      expect(f.action.remote?.baseSha).toBe(f.action.source.baseSha);
      expect(f.gateCalls()).toBeGreaterThan(15);
    },
  );
  it('never resends a previous START when no remote object can be confirmed', async () => {
    const f = fixture();
    f.action.steps.blob = {
      state: 'started',
      intentDigest: repositoryDigest('fixture'),
      startedActionId: randomUUID(),
      startedAttempt: 1,
    };
    await expect(f.run()).rejects.toMatchObject({
      code: 'REPOSITORY_REMOTE_UNAVAILABLE',
    });
    expect(f.postCounts).toEqual({});
    f.action.mode = 'inspect';
    await f.run();
    expect(f.postCounts).toEqual({});
  });
  it('refuses a changed main and an existing foreign branch without overwriting', async () => {
    const f = fixture();
    f.setMain('b'.repeat(40));
    await expect(f.run()).rejects.toMatchObject({
      code: 'REPOSITORY_REMOTE_CONFLICT',
    });
    expect(f.postCounts).toEqual({});
    expect(f.store.observe).toHaveBeenCalledWith(
      f.lease,
      expect.objectContaining({ state: 'stale' }),
    );
    const g = fixture();
    g.action.steps.branch = {
      state: 'started',
      intentDigest: repositoryDigest('fixture'),
      startedActionId: randomUUID(),
      startedAttempt: 1,
    };
    g.setBranch('c'.repeat(40));
    await expect(g.run()).rejects.toMatchObject({
      code: 'REPOSITORY_REMOTE_CONFLICT',
    });
    expect(g.postCounts.branch).toBeUndefined();
    expect(g.postCounts.pull).toBeUndefined();
    expect(g.store.observe).toHaveBeenCalledWith(
      g.lease,
      expect.objectContaining({ state: 'stale' }),
    );
    g.action.mode = 'inspect';
    await g.run();
    expect(g.store.observe).toHaveBeenLastCalledWith(
      g.lease,
      expect.objectContaining({ state: 'stale' }),
    );
  });
  it('stops immediately when current authority is revoked and inspect never writes', async () => {
    const f = fixture();
    const confirm = f.store.confirm;
    f.store.confirm = async (...args) => {
      await confirm(...args);
      f.revoke();
    };
    await expect(f.run()).rejects.toBeDefined();
    expect(f.postCounts).toEqual({ blob: 1 });
    const g = fixture();
    g.action.mode = 'inspect';
    await g.run();
    expect(g.postCounts).toEqual({});
  });
});

describe('maintenance bot company provenance and method-aware recovery', () => {
  it.each([
    'blob',
    'tree',
    'commit',
    'branch',
    'pull',
    'maintenance_label',
    'company_label',
    'labels',
  ] as const)(
    'confirms the exact %s after a lost acknowledgement and preserves company attribution without replay',
    async (lost) => {
      const f = fixture(lost, true);
      await f.run();
      await f.run();
      expect(f.postCounts).toEqual({
        blob: 1,
        tree: 1,
        commit: 1,
        branch: 1,
        pull: 1,
        maintenance_label: 1,
        company_label: 1,
        labels: 1,
      });
      expect(f.action.metadata?.author).toMatchObject({
        login: 'rice-maintenance',
        userId: 10,
        message: 'fix(test-company): redact command output credentials',
      });
      expect(f.action.metadata?.maintenance?.title).toContain('test-company');
      expect(f.action.metadata?.maintenance?.body).toContain(
        f.action.provenance!.reportId,
      );
      expect(f.labels).toEqual(
        new Set(['unrelated', 'allrice-maintenance', 'company:test-company']),
      );
      expect(JSON.stringify(f.action.metadata)).not.toContain('github_pat_');
    },
  );
  it('revocation permits exact GET reconciliation but prevents all later writes', async () => {
    const f = fixture('commit', true, 'commit');
    await expect(f.run()).rejects.toThrow('AUTH_REVOKED');
    expect(f.postCounts).toEqual({ blob: 1, tree: 1, commit: 1 });
    f.action.mode = 'inspect';
    await f.run();
    expect(f.postCounts).toEqual({ blob: 1, tree: 1, commit: 1 });
  });
  it('refuses a PR created by a different account instead of accepting title attribution alone', async () => {
    const f = fixture(undefined, true);
    await f.run();
    f.corruptPull();
    await expect(f.run()).rejects.toMatchObject({
      code: 'REPOSITORY_REMOTE_CONFLICT',
    });
    expect(Object.values(f.postCounts).every((n) => n === 1)).toBe(true);
  });
});
