import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const gates = [
  'validate',
  'developer-bootstrap',
  'tenant-workbench-browser',
  'compose-smoke',
];
const collectionGates = gates.filter((gate) => gate !== 'compose-smoke');
const save = (path, data) =>
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
const checksum = (bytes) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
const logFormats = new Map([
  ['Run existing tests and retain their original evidence', 'node-tap'],
  [
    'Unit-test the M1 monitor (standard-library Python, no services)',
    'python-unittest',
  ],
]);

export function logFailures(job, log) {
  const failures = [];
  for (const [index, line] of log.text.split('\n').entries()) {
    const stamped = line.match(/^(\d{4}-\d\d-\d\dT\S+Z) (.*)$/);
    if (!stamped) continue;
    const time = Date.parse(stamped[1]);
    const step = job.steps.find(
      (item) =>
        item.conclusion === 'failure' &&
        logFormats.has(item.name) &&
        time >= Date.parse(item.started_at) &&
        time < Date.parse(item.completed_at) + 1000,
    );
    const format = logFormats.get(step?.name);
    const tap =
      format === 'node-tap' && stamped[2].match(/^\s*not ok \d+ - (.+)$/);
    const python =
      format === 'python-unittest' &&
      stamped[2].match(/^(?:FAIL|ERROR): (\S+ \(.+\)(?: .*)?)$/);
    const name = tap?.[1] ?? python?.[1];
    if (!name || (tap && /\s+# (?:TODO|SKIP)(?:\s|$)/i.test(name))) continue;
    failures.push({
      gate: job.name,
      file: null,
      name,
      provenance: 'job-log',
      format,
      evidence: log.evidence,
      line: index + 1,
      url: `${job.html_url}#step:${step.number}:1`,
    });
  }
  return failures;
}

// Only GitHub API metadata and original evidence are read. Artifact code is never run.
export function summarize({
  repository,
  trigger,
  run,
  jobs = [],
  originals = [],
  logs = [],
  errors = [],
}) {
  const problems = [...errors];
  const runUrl = `${trigger.html_url}/attempts/1`;
  const validRun =
    run?.id === trigger.id &&
    run?.run_attempt === 1 &&
    run?.repository?.full_name === repository &&
    run?.head_repository?.full_name === repository &&
    run?.head_sha === trigger.head_sha &&
    run?.head_branch === 'main' &&
    run?.event === 'schedule' &&
    run?.name === 'CI' &&
    run?.path === '.github/workflows/ci.yml' &&
    run?.status === 'completed';
  if (!validRun)
    problems.push(
      'Original scheduled main CI identity is missing or mismatched',
    );
  const failedTests = [];
  const failedSteps = [];
  const results = gates.map((gate) => {
    const matches = jobs.filter(
      (job) => job.name === gate && job.run_attempt === 1,
    );
    const job = matches.length === 1 ? matches[0] : null;
    if (!job || job.run_id !== trigger.id || job.head_sha !== trigger.head_sha)
      problems.push(`${gate}: missing or mismatched original job`);
    for (const step of job?.steps ?? []) {
      if (!['failure', 'cancelled', 'timed_out'].includes(step.conclusion))
        continue;
      failedSteps.push({
        gate,
        name: step.name,
        conclusion: step.conclusion,
        completedAt: step.completed_at ?? step.started_at,
        url: `${job.html_url}#step:${step.number}:1`,
      });
    }
    const log = logs.find(
      (item) =>
        item.jobId === job?.id &&
        item.runId === trigger.id &&
        item.runAttempt === 1 &&
        item.headSha === trigger.head_sha,
    );
    if (log && job) failedTests.push(...logFailures(job, log));
    else if (
      job?.steps?.some(
        (step) => step.conclusion === 'failure' && logFormats.has(step.name),
      )
    )
      problems.push(`${gate}: original runner job log unavailable`);
    const artifact = originals.find(
      (item) => item.name === `repository-ci-${gate}-1`,
    );
    const receipt = artifact?.files['receipt.json'];
    const validReceipt =
      receipt?.scope === 'allrice.repository-nightly-ci.v1' &&
      receipt.version === 1 &&
      receipt.repository === repository &&
      receipt.repositoryId === run?.repository?.id &&
      receipt.workflowRunId === trigger.id &&
      receipt.runAttempt === 1 &&
      receipt.job === gate &&
      receipt.event === 'schedule' &&
      receipt.workflowPath === '.github/workflows/ci.yml' &&
      receipt.checkoutSha === trigger.head_sha &&
      /^[a-f0-9]{40}$/.test(receipt.checkoutTree ?? '');
    if (!validReceipt)
      problems.push(
        `${gate}: original complete gate receipt missing or mismatched`,
      );
    if (collectionGates.includes(gate)) {
      const collection = originals.find(
        (item) => item.name === `integration-collection-${gate}-1`,
      );
      const batches = Object.keys(collection?.files ?? {}).filter((path) =>
        path.endsWith('/batch.json'),
      );
      if (!batches.length)
        problems.push(`${gate}: original test batches missing`);
      for (const path of batches) {
        const prefix = path.slice(0, -'batch.json'.length);
        const batch = collection.files[path];
        const batchReceipt = collection.files[prefix + 'receipt.json'];
        const report = collection.files[prefix + 'vitest.json'];
        const instances =
          collection.files[prefix + 'batch.json.instances.json'];
        if (
          batch?.head !== trigger.head_sha ||
          batchReceipt?.head !== trigger.head_sha
        ) {
          problems.push(`${gate}/${prefix}: test source identity mismatch`);
          continue;
        }
        if (
          !batchReceipt?.complete ||
          batchReceipt?.exitCode !== 0 ||
          report?.success !== true ||
          instances?.complete !== true ||
          !Array.isArray(instances?.errors) ||
          instances.errors.length
        )
          problems.push(
            `${gate}/${prefix}: test evidence incomplete or unsuccessful`,
          );
        if (!Array.isArray(report?.testResults)) {
          problems.push(`${gate}/${prefix}: original Vitest report missing`);
          continue;
        }
        for (const file of report.testResults) {
          if (!Array.isArray(file?.assertionResults)) {
            problems.push(`${gate}/${prefix}: invalid original assertions`);
            continue;
          }
          for (const test of file.assertionResults) {
            if (test?.status !== 'failed') continue;
            if (
              typeof test.fullName !== 'string' ||
              typeof file.name !== 'string'
            )
              problems.push(
                `${gate}/${prefix}: failed assertion identity missing`,
              );
            else
              failedTests.push({
                gate,
                file: file.name,
                name: test.fullName,
                provenance: 'vitest-json',
                evidence: `${collection.name}/${prefix}vitest.json`,
                url: job?.html_url ?? runUrl,
              });
          }
        }
      }
    }
    return {
      gate,
      conclusion: job?.conclusion ?? 'unknown',
      url: job?.html_url ?? runUrl,
      receiptVerified: !!validReceipt,
    };
  });
  failedSteps.sort((a, b) =>
    (a.completedAt ?? '').localeCompare(b.completedAt ?? ''),
  );
  const success =
    validRun &&
    run.conclusion === 'success' &&
    results.every(
      (job) => job.conclusion === 'success' && job.receiptVerified,
    ) &&
    !problems.length &&
    !failedTests.length;
  return {
    version: 1,
    status: success ? 'success' : 'failure',
    repository,
    workflow: 'CI',
    event: 'schedule',
    branch: 'main',
    headSha: trigger.head_sha,
    runId: trigger.id,
    runAttempt: 1,
    triggerAttempt: trigger.run_attempt,
    sourceConclusion: validRun ? run.conclusion : 'unknown',
    sourceUrl: runUrl,
    evidenceComplete: !problems.length,
    failureKind: success
      ? null
      : run?.conclusion === 'cancelled'
        ? 'cancelled'
        : failedTests.length
          ? 'tests'
          : failedSteps.length
            ? 'steps'
            : 'evidence',
    firstFailureUrl: success
      ? null
      : (failedSteps[0]?.url ??
        results.find((job) => job.conclusion !== 'success')?.url ??
        runUrl),
    jobs: results,
    failedTests,
    failedSteps,
    evidenceProblems: problems,
    originals: originals.map(({ name, id, digest }) => ({ name, id, digest })),
    logs: logs.map((log) => ({ ...log, text: undefined })),
  };
}

const gh = (args, binary = false) =>
  execFileSync('gh', args, {
    encoding: binary ? undefined : 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
const api = (path) => JSON.parse(gh(['api', path]));
function pages(path, key) {
  const items = [];
  for (let page = 1; ; page++) {
    const result = api(`${path}?per_page=100&page=${page}`)[key];
    items.push(...result);
    if (result.length < 100) return items;
  }
}
export function readOriginal(artifact, directory, trigger, repositoryId) {
  if (
    artifact.expired ||
    artifact.workflow_run?.id !== trigger.id ||
    artifact.workflow_run?.head_sha !== trigger.head_sha ||
    artifact.workflow_run?.repository_id !== repositoryId
  )
    throw Error(
      `${artifact.name}: artifact source identity mismatch or expired`,
    );
  const bytes = gh(
    [
      'api',
      `repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifact.id}/zip`,
    ],
    true,
  );
  if (
    bytes.length !== artifact.size_in_bytes ||
    checksum(bytes) !== artifact.digest
  )
    throw Error(`${artifact.name}: original archive size/digest mismatch`);
  const archive = resolve(directory, `${artifact.id}.zip`);
  writeFileSync(archive, bytes, { flag: 'wx' });
  // unzip -p reads named JSON members without extracting paths or executing them.
  const members = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
    .trim()
    .split('\n');
  const files = {};
  for (const member of members.filter((name) =>
    /(?:^|\/)(?:(?:receipt|batch|vitest)\.json|batch\.json\.instances\.json)$/.test(
      name,
    ),
  )) {
    if (
      member.startsWith('/') ||
      member.split('/').includes('..') ||
      files[member]
    )
      throw Error(`${artifact.name}: duplicate or invalid JSON member`);
    files[member] = JSON.parse(
      execFileSync('unzip', ['-p', archive, member], {
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
      }),
    );
  }
  return {
    name: artifact.name,
    id: artifact.id,
    digest: artifact.digest,
    files,
  };
}

export function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const trigger = event.workflow_run;
  const repository = process.env.GITHUB_REPOSITORY;
  const directory = resolve('.local/nightly-ci');
  mkdirSync(directory, { recursive: true });
  const data = { repository, trigger, originals: [], logs: [], errors: [] };
  try {
    if (
      event.action !== 'completed' ||
      trigger.event !== 'schedule' ||
      trigger.head_branch !== 'main' ||
      trigger.head_repository?.full_name !== repository ||
      trigger.path !== '.github/workflows/ci.yml' ||
      !Number.isSafeInteger(trigger.id)
    )
      throw Error('Unexpected workflow_run source');
    const base = `repos/${repository}/actions/runs/${trigger.id}`;
    data.run = api(`${base}/attempts/1`);
    data.jobs = pages(`${base}/attempts/1/jobs`, 'jobs');
    save(resolve(directory, 'source-api.json'), {
      run: data.run,
      jobs: data.jobs,
    });
    for (const job of data.jobs.filter(
      (item) =>
        gates.includes(item.name) &&
        item.run_id === trigger.id &&
        item.run_attempt === 1 &&
        item.head_sha === trigger.head_sha &&
        ['failure', 'cancelled', 'timed_out'].includes(item.conclusion),
    )) {
      try {
        const text = gh([
          'api',
          `repos/${repository}/actions/jobs/${job.id}/logs`,
        ]);
        const evidence = `job-logs/${job.id}.log`;
        mkdirSync(resolve(directory, 'job-logs'), { recursive: true });
        writeFileSync(resolve(directory, evidence), text, { flag: 'wx' });
        data.logs.push({
          jobId: job.id,
          gate: job.name,
          runId: trigger.id,
          runAttempt: 1,
          headSha: trigger.head_sha,
          evidence,
          digest: checksum(text),
          text,
        });
      } catch (error) {
        data.errors.push(
          `${job.name}: original job log unavailable: ${error.message}`,
        );
      }
    }
    const artifacts = pages(`${base}/artifacts`, 'artifacts');
    save(resolve(directory, 'source-api.json'), {
      run: data.run,
      jobs: data.jobs,
      artifacts,
    });
    const expected = [
      ...gates.map((gate) => `repository-ci-${gate}-1`),
      ...collectionGates.map((gate) => `integration-collection-${gate}-1`),
    ];
    for (const name of expected) {
      const matches = artifacts.filter((artifact) => artifact.name === name);
      if (matches.length !== 1) {
        data.errors.push(`${name}: original artifact missing or duplicated`);
        continue;
      }
      try {
        data.originals.push(
          readOriginal(matches[0], directory, trigger, data.run.repository.id),
        );
      } catch (error) {
        data.errors.push(error.message);
      }
    }
  } catch (error) {
    data.errors.push(error.message);
  }
  const summary = summarize(data);
  save(resolve(directory, 'summary.json'), summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Nightly CI: **${summary.status}** · [original attempt 1](${summary.sourceUrl})\n\n` +
        `Head: \`${summary.headSha}\` · evidence complete: ${summary.evidenceComplete}\n\n` +
        (summary.firstFailureUrl
          ? `[First failure](${summary.firstFailureUrl})\n\n`
          : '') +
        `Failed test names from original JSON or runner logs: ${summary.failedTests.length}. Empty does not prove zero failures; inspect failedSteps/evidenceProblems.\n`,
    );
  console.log(
    `${summary.status}: ${summary.sourceUrl}; evidence: .local/nightly-ci/summary.json`,
  );
  if (summary.status !== 'success') process.exitCode = 1;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
