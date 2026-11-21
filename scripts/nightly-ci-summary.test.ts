import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';
import { gates, summarize } from './nightly-ci-summary.mjs';

const sha = 'a'.repeat(40);
const repository = 'semiok/allrice';
function fixture() {
  const trigger = {
    id: 42,
    head_sha: sha,
    run_attempt: 1,
    html_url: 'https://github.com/semiok/allrice/actions/runs/42',
    event: 'schedule',
    head_branch: 'main',
    path: '.github/workflows/ci.yml',
    head_repository: { full_name: repository },
  };
  const run = {
    ...trigger,
    repository: { full_name: repository, id: 12 },
    name: 'CI',
    status: 'completed',
    conclusion: 'success',
  };
  const jobs = gates.map((gate, i) => ({
    name: gate,
    id: i,
    run_id: 42,
    run_attempt: 1,
    head_sha: sha,
    conclusion: 'success',
    html_url: `${trigger.html_url}/job/${i}`,
    steps: [] as {
      name: string;
      number: number;
      conclusion: string;
      completed_at: string;
    }[],
  }));
  const originals = gates.flatMap((gate, i) => {
    const receipt = {
      name: `repository-ci-${gate}-1`,
      id: i,
      digest: 'sha256:fixture',
      files: {
        'receipt.json': {
          version: 1,
          scope: 'allrice.repository-nightly-ci.v1',
          repository,
          repositoryId: 12,
          workflowRunId: 42,
          runAttempt: 1,
          job: gate,
          event: 'schedule',
          workflowPath: '.github/workflows/ci.yml',
          checkoutSha: sha,
          checkoutTree: 'b'.repeat(40),
        },
      },
    };
    return gate === 'compose-smoke'
      ? [receipt]
      : [
          receipt,
          {
            name: `integration-collection-${gate}-1`,
            id: i + 10,
            digest: 'sha256:fixture',
            files: {
              'explicit-123/batch.json': { head: sha },
              'explicit-123/receipt.json': {
                head: sha,
                complete: true,
                exitCode: 0,
              },
              'explicit-123/batch.json.instances.json': {
                complete: true,
                errors: [],
              },
              'explicit-123/vitest.json': {
                success: true,
                testResults: [
                  {
                    name: 'test.ts',
                    assertionResults: [
                      { fullName: 'suite case', status: 'passed' },
                    ],
                  },
                ],
              },
            },
          },
        ];
  });
  return { repository, trigger, run, jobs, originals };
}

it('reports success only for the original four successful jobs and complete exact-head evidence', () => {
  expect(summarize(fixture())).toMatchObject({
    status: 'success',
    evidenceComplete: true,
    runId: 42,
    runAttempt: 1,
    headSha: sha,
    failedTests: [],
    firstFailureUrl: null,
  });
});

it('keeps the first failure link and takes failed names from original Vitest assertions', () => {
  const data = fixture();
  data.run.conclusion = 'failure';
  data.jobs[0].conclusion = 'failure';
  data.jobs[0].steps.push({
    name: 'Run tests',
    number: 5,
    conclusion: 'failure',
    completed_at: '2026-11-21T01:00:00Z',
  });
  data.jobs[1].steps.push({
    name: 'Later failure',
    number: 9,
    conclusion: 'failure',
    completed_at: '2026-11-21T01:01:00Z',
  });
  const collection = data.originals.find(
    (item) => item.name === 'integration-collection-validate-1',
  )!;
  Object.assign(collection.files['explicit-123/vitest.json'], {
    success: false,
    testResults: [
      {
        name: 'test.ts',
        assertionResults: [{ fullName: '真实失败名称', status: 'failed' }],
      },
    ],
  });
  expect(summarize(data)).toMatchObject({
    status: 'failure',
    evidenceComplete: false,
    failureKind: 'tests',
    firstFailureUrl: `${data.jobs[0].html_url}#step:5:1`,
    failedTests: [{ gate: 'validate', file: 'test.ts', name: '真实失败名称' }],
  });
});

it.each(['cancelled', 'timed_out', 'failure'])(
  'does not turn %s without structured names green',
  (conclusion) => {
    const data = fixture();
    data.run.conclusion = conclusion;
    data.jobs[0].conclusion = conclusion;
    data.jobs[0].steps.push({
      name: 'Install or unstructured test command',
      number: 3,
      conclusion,
      completed_at: '2026-11-21T01:00:00Z',
    });
    data.originals = data.originals.filter(
      (item) => !item.name.includes('validate'),
    );
    expect(summarize(data)).toMatchObject({
      status: 'failure',
      evidenceComplete: false,
      failureKind: conclusion === 'cancelled' ? 'cancelled' : 'steps',
      failedTests: [],
      firstFailureUrl: `${data.jobs[0].html_url}#step:3:1`,
    });
  },
);

it.each([
  'artifact',
  'job',
  'receipt',
  'batch',
  'report',
  'instances',
  'missing-name',
  'malformed',
])(
  'rejects missing or stale %s evidence even when the run API says success',
  (kind) => {
    const data = fixture();
    if (kind === 'artifact') data.originals.pop();
    if (kind === 'job') data.jobs[0].run_attempt = 2;
    if (kind === 'receipt')
      Object.assign(data.originals[0].files['receipt.json'], {
        workflowRunId: 99,
      });
    const collection = data.originals.find(
      (item) => item.name === 'integration-collection-validate-1',
    )!;
    if (kind === 'batch')
      Object.assign(collection.files['explicit-123/batch.json'], {
        head: 'c'.repeat(40),
      });
    if (kind === 'report') delete collection.files['explicit-123/vitest.json'];
    if (kind === 'instances')
      delete collection.files['explicit-123/batch.json.instances.json'];
    if (kind === 'missing-name')
      Object.assign(collection.files['explicit-123/vitest.json'], {
        testResults: [
          { name: 'test.ts', assertionResults: [{ status: 'failed' }] },
        ],
      });
    if (kind === 'malformed')
      Object.assign(collection.files['explicit-123/vitest.json'], {
        testResults: [null],
      });
    expect(summarize(data)).toMatchObject({
      status: 'failure',
      evidenceComplete: false,
    });
  },
);

it('keeps attempt 1 separate when a later manual attempt triggers the summary', () => {
  const data = fixture();
  data.trigger.run_attempt = 2;
  data.run.conclusion = 'failure';
  expect(summarize(data)).toMatchObject({
    status: 'failure',
    runAttempt: 1,
    triggerAttempt: 2,
    sourceConclusion: 'failure',
  });
});

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
it.each(['success', 'digest', 'null-digest', 'api'])(
  'CLI writes a machine summary from original archives or %s failure without running gates',
  (mode) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'allrice-nightly-')));
    roots.push(root);
    const data = fixture();
    mkdirSync(join(root, 'bin'));
    const artifacts = data.originals.map((item) => {
      const content = join(root, `content-${item.id}`);
      mkdirSync(content);
      for (const [path, value] of Object.entries(item.files)) {
        mkdirSync(join(content, path, '..'), { recursive: true });
        writeFileSync(join(content, path), JSON.stringify(value));
      }
      const archive = join(root, `${item.id}.zip`);
      execFileSync('zip', ['-qr', archive, '.'], { cwd: content });
      const bytes = readFileSync(archive);
      return {
        id: item.id,
        name: item.name,
        expired: false,
        size_in_bytes: bytes.length,
        digest:
          mode === 'null-digest'
            ? null
            : mode === 'digest'
              ? 'sha256:wrong'
              : 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
        workflow_run: { id: 42, repository_id: 12, head_sha: sha },
      };
    });
    writeFileSync(
      join(root, 'api.json'),
      JSON.stringify({ run: data.run, jobs: data.jobs, artifacts }),
    );
    writeFileSync(
      join(root, 'event.json'),
      JSON.stringify({ action: 'completed', workflow_run: data.trigger }),
    );
    writeFileSync(
      join(root, 'bin/gh'),
      `#!${process.execPath}\n` +
        String.raw`
    const fs = require('fs'); const path = require('path');
    fs.appendFileSync('calls.jsonl', JSON.stringify(process.argv.slice(2)) + '\n');
    if (process.env.FAIL_API === '1') process.exit(1);
    const api = JSON.parse(fs.readFileSync('api.json', 'utf8'));
    const endpoint = process.argv[3];
    const match = endpoint.match(/artifacts\/(\d+)\/zip$/);
    if (match) process.stdout.write(fs.readFileSync(path.resolve(match[1] + '.zip')));
    else process.stdout.write(JSON.stringify(endpoint.includes('/jobs?') ? {jobs:api.jobs} : endpoint.includes('/artifacts?') ? {artifacts:api.artifacts} : api.run));
  `,
      { mode: 0o755 },
    );
    const child = spawnSync(
      process.execPath,
      [resolve('scripts/nightly-ci-summary.mjs')],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
          GITHUB_EVENT_PATH: join(root, 'event.json'),
          GITHUB_REPOSITORY: repository,
          FAIL_API: mode === 'api' ? '1' : '0',
        },
      },
    );
    expect(child.status, child.stderr).toBe(mode === 'success' ? 0 : 1);
    const result = JSON.parse(
      readFileSync(join(root, '.local/nightly-ci/summary.json'), 'utf8'),
    );
    expect(result.status).toBe(mode === 'success' ? 'success' : 'failure');
    expect(result.evidenceComplete).toBe(mode === 'success');
    const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls.every((call) => call[0] === 'api')).toBe(true);
    expect(
      calls.some((call) =>
        call.some((arg: string) => /rerun|dispatch/.test(arg)),
      ),
    ).toBe(false);
  },
);

it('schedules the same four jobs, preserves push/PR baselines, and always uploads the independent summary', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  expect(Object.keys(workflow.jobs).sort()).toEqual([...gates].sort());
  expect(workflow.on.schedule).toEqual([{ cron: '23 18 * * *' }]);
  expect(workflow.concurrency.group).toContain('github.event_name');
  expect(workflow.concurrency.group).toContain('github.run_id');
  expect(workflow.concurrency['cancel-in-progress']).toBe(
    "${{ github.event_name == 'pull_request' }}",
  );
  expect(workflow.jobs.validate.steps[0].with['fetch-depth']).toBe(2);
  for (const gate of ['validate', 'developer-bootstrap']) {
    const step = workflow.jobs[gate].steps.find((item: { run?: string }) =>
      item.run?.includes('git fetch --no-tags'),
    );
    expect(step.env.BASE).toBe(
      '${{ github.event.pull_request.base.sha || github.event.before }}',
    );
    expect(step.run).toContain('BASE="$(git rev-parse HEAD^)"');
  }
  const summary = parse(
    readFileSync('.github/workflows/nightly-ci-summary.yml', 'utf8'),
  );
  expect(summary.on.workflow_run).toEqual({
    workflows: ['CI'],
    types: ['completed'],
    branches: ['main'],
  });
  expect(summary.permissions).toEqual({ contents: 'read', actions: 'read' });
  expect(summary.jobs.summarize.if).toContain(
    "github.event.workflow_run.event == 'schedule'",
  );
  expect(summary.jobs.summarize.steps.at(-1).if).toBe('always()');
});
