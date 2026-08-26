import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url);

function run(label, command, args) {
  process.stdout.write(`\n[MET-62] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with status ${result.status ?? 'unknown'}`,
    );
  }
}

async function assertHttp(baseUrl) {
  const checks = [
    ['/api/health/live', 200],
    ['/api/health/ready', 200],
    ['/chatflow', 200],
    ['/chatflow/employees', 200],
    ['/chatflow/admin', 200],
    ['/chatflow/governance', 200],
  ];
  for (const [path, status] of checks) {
    const response = await fetch(new URL(path, baseUrl), {
      redirect: 'manual',
    });
    if (response.status !== status) {
      throw new Error(
        `${path} returned ${response.status}, expected ${status}`,
      );
    }
    process.stdout.write(`[MET-62] HTTP ${path} ${response.status}\n`);
  }
}

run('DSH pinned-distribution governance', 'pnpm', ['dsh:verify']);
run('type contracts and application boundaries', 'pnpm', ['typecheck']);
run('security, routing, recovery and tenancy matrix', 'pnpm', [
  'exec',
  'vitest',
  'run',
  'packages/contracts/src/models.test.ts',
  'packages/contracts/src/runtime-contract.test.ts',
  'packages/database/src/model-pool.test.ts',
  'packages/database/src/model-governance.test.ts',
  'packages/database/src/employee-quality.test.ts',
  'packages/database/src/employeehub-redaction.test.ts',
  'packages/database/src/conversation-runtime.test.ts',
  'packages/database/src/conversation-checkpoint.test.ts',
  'packages/database/src/employee-capabilities.test.ts',
  'apps/worker/src/harness/router.test.ts',
  'apps/worker/src/harness/runtime-contract.test.ts',
  'apps/worker/src/harness/dsh-protocol-runtime.test.ts',
  'apps/worker/src/codex-auth-broker.test.ts',
  'apps/worker/src/model-cost.test.ts',
]);
if (process.env.ALLRICE_ACCEPTANCE_SKIP_BUILD !== '1') {
  run('production build', 'pnpm', ['build']);
}
if (process.env.ALLRICE_ACCEPTANCE_BASE_URL) {
  await assertHttp(process.env.ALLRICE_ACCEPTANCE_BASE_URL);
  if (process.env.DATABASE_URL) {
    run('authenticated roles, Eval Suites and Harness evidence', 'pnpm', [
      'met62:auth-smoke',
    ]);
  }
}
process.stdout.write('\n[MET-62] all required acceptance gates passed\n');
