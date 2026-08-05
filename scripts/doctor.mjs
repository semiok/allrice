import {
  commandWorks,
  loadDevelopmentEnvironment,
  pnpmCommand,
} from './dev-environment.mjs';

loadDevelopmentEnvironment();

const checks = [];
const nodeMajor = Number(process.versions.node.split('.')[0]);
checks.push({
  ok: nodeMajor >= 22,
  label: `Node.js ${process.versions.node}`,
  fix: 'Install Node.js 22 or newer.',
});
checks.push({
  ok: commandWorks(pnpmCommand, ['--version']),
  label: 'pnpm is available',
  fix: 'Run `corepack enable`, then retry.',
});

if (process.env.DATABASE_URL) {
  checks.push({
    ok: true,
    label: 'DATABASE_URL is configured; pnpm dev will use that database',
  });
} else {
  const composeAvailable = commandWorks('docker', ['compose', 'version']);
  checks.push({
    ok: composeAvailable,
    label: 'Docker Compose is available for the isolated development database',
    fix: 'Install and start Docker Desktop, or configure DATABASE_URL in .env.',
  });
  if (composeAvailable) {
    checks.push({
      ok: commandWorks('docker', ['info']),
      label: 'Docker engine is running',
      fix: 'Start Docker Desktop (or your Docker service), then retry.',
    });
  }
}

for (const check of checks) {
  console.info(`${check.ok ? '✓' : '✗'} ${check.label}`);
  if (!check.ok) console.info(`  Fix: ${check.fix}`);
}

if (checks.some((check) => !check.ok)) {
  process.exitCode = 1;
} else {
  console.info('All required development tools are ready.');
}
