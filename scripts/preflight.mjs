import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { pnpmCommand, repositoryRoot } from './dev-environment.mjs';

// Reuse the existing validators. This local check neither authorizes a release
// nor replaces the four original CI jobs, database/physical QA or Dev acceptance.
export const preflightSteps = [
  { id: 'dsh', args: ['dsh:verify'] },
  { id: 'dsh-ui', args: ['dsh-ui:verify'] },
  { id: 'format', args: ['format:check'] },
  { id: 'lint', args: ['lint'] },
  { id: 'types', args: ['typecheck'] },
  {
    id: 'wiring',
    args: [
      'test',
      '--maxWorkers=2',
      'infra/docker/workspace-manifests.test.ts',
      'packages/contracts/src/tool-manifest.test.ts',
      'apps/worker/src/tool-manifest.contract.test.ts',
      'apps/worker/src/tool-broker/registry.test.ts',
      'apps/worker/src/harness/dsh-office-native.test.ts',
      'apps/worker/src/jobs/platform-repair.native.test.ts',
      'packages/database/src/platform-content/catalog.test.ts',
      'scripts/acceptance/runtime/role-task-preflight.test.ts',
    ],
  },
  { id: 'production-build', args: ['build'] },
];

export function runPreflight({
  steps = preflightSteps,
  cwd = repositoryRoot,
  command = pnpmCommand,
  execute = spawnSync,
  log = console.info,
} = {}) {
  const results = [];
  for (const step of steps) {
    log(`\n[preflight:${step.id}] ${command} ${step.args.join(' ')}`);
    const started = Date.now();
    // No shell, arbitrary CLI command, .env loading, database startup or retry.
    // Keep going after a failure so one pass reveals all independent failures.
    let result;
    try {
      result = execute(command, step.args, { cwd, stdio: 'inherit' });
    } catch {
      result = { error: true, status: null };
    }
    results.push({
      id: step.id,
      passed: !result.error && result.status === 0,
      exitCode: result.status ?? null,
      executionFailed: !!result.error || result.status === null,
      elapsedMs: Date.now() - started,
    });
  }
  log('\nLocal preflight results:');
  for (const result of results)
    log(
      `${result.passed ? 'PASS' : 'FAIL'} ${result.id} (${result.elapsedMs}ms${result.executionFailed ? ', execution failed' : `, exit ${result.exitCode}`})`,
    );
  return {
    passed: results.length > 0 && results.every((result) => result.passed),
    results,
  };
}

export function main(args = process.argv.slice(2)) {
  if (args.some((arg) => !['--plan', '--quick'].includes(arg))) {
    console.error('Usage: pnpm preflight [--plan] [--quick]');
    return 1;
  }
  const quick = args.includes('--quick');
  const steps = preflightSteps.filter(
    (step) => !quick || step.id !== 'production-build',
  );
  if (args.includes('--plan')) {
    for (const step of steps)
      console.info(`${step.id}: ${pnpmCommand} ${step.args.join(' ')}`);
    console.info('Plan only; no checks have run.');
    return 0;
  }
  const result = runPreflight({ steps });
  if (quick)
    console.info(
      'Quick mode: production build NOT RUN. Run pnpm preflight before submitting runtime changes.',
    );
  console.info(
    'Full CI, affected database/browser/device checks and actual Dev acceptance remain required.',
  );
  return result.passed ? 0 : 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = main();
