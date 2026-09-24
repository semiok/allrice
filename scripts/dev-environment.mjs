import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
export const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export function loadDevelopmentEnvironment() {
  const envFile = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(envFile)) loadEnvFile(envFile);

  process.env.ALLRICE_ENV ||= 'development';
  process.env.ALLRICE_WEB_PORT ||= '3000';
  process.env.ALLRICE_WORKER_PORT ||= '3101';
  process.env.ALLRICE_WORKER_POLL_INTERVAL_MS ||= '1000';
  process.env.ALLRICE_WORKER_LEASE_MS ||= '30000';
  process.env.ALLRICE_WORKER_HEARTBEAT_MS ||= '10000';
  process.env.ALLRICE_WORKER_CONCURRENCY ||= '1';
  process.env.ALLRICE_EXECUTION_ROOT ||= fileURLToPath(
    new URL('../.local/executions', import.meta.url),
  );
  process.env.ALLRICE_STORAGE_ROOT ||= fileURLToPath(
    new URL('../.local/storage', import.meta.url),
  );

  return process.env;
}

export function getDevelopmentDatabaseUrl() {
  const database = process.env.POSTGRES_DB || 'allrice';
  const user = process.env.POSTGRES_USER || 'allrice';
  const password = process.env.POSTGRES_PASSWORD || 'allrice';
  const port = process.env.ALLRICE_DEV_DB_PORT || '54329';

  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
    ...options,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.status}`,
    );
  }
}

export function commandWorks(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'ignore',
  });
  return !result.error && result.status === 0;
}

export async function ensureStorageDirectory() {
  loadDevelopmentEnvironment();
  await mkdir(process.env.ALLRICE_STORAGE_ROOT, { recursive: true });
}

export async function prepareDevelopmentDatabase() {
  loadDevelopmentEnvironment();

  // Plain Node DSH subprocesses consume the same compiled Office contracts
  // as production. The Web/Worker tsx aliases do not apply in that process.
  console.info('[setup] Building shared runtime contracts...');
  run(pnpmCommand, ['--filter', '@allrice/contracts', 'build']);

  if (!process.env.DATABASE_URL) {
    if (!commandWorks('docker', ['compose', 'version'])) {
      throw new Error(
        [
          'Docker Compose is required when DATABASE_URL is not configured.',
          'Install Docker Desktop (or Docker Engine with Compose), start it, and retry.',
          'Alternatively, set DATABASE_URL in .env to an existing PostgreSQL 17 database with pgvector.',
        ].join('\n'),
      );
    }
    if (!commandWorks('docker', ['info'])) {
      throw new Error(
        'Docker is installed but its engine is not running. Start Docker Desktop (or your Docker service) and retry.',
      );
    }

    process.env.DATABASE_URL = getDevelopmentDatabaseUrl();
    console.info(
      '[setup] Starting the isolated AllRice development database...',
    );
    run('docker', [
      'compose',
      '--project-name',
      'allrice-dev',
      '--file',
      'compose.dev.yaml',
      'up',
      '--detach',
      '--wait',
      '--wait-timeout',
      '120',
      'postgres',
    ]);
  } else {
    console.info('[setup] Using DATABASE_URL from the environment or .env.');
  }

  console.info(
    '[setup] Preparing database schema and operational platform content...',
  );
  run(pnpmCommand, ['db:prepare']);
  console.info('[setup] Database is ready.');

  return process.env.DATABASE_URL;
}

export function spawnDevelopmentServices() {
  return spawn(pnpmCommand, ['dev:services'], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
  });
}

export async function prepareOfficeRenderer() {
  loadDevelopmentEnvironment();
  if (!process.env.ALLRICE_OFFICE_RENDERER_URL) {
    console.info('[setup] Starting Office preview and formula calculation...');
    run('docker', [
      'compose',
      '--project-name',
      'allrice-dev',
      '--file',
      'compose.dev.yaml',
      'up',
      '--detach',
      '--build',
      '--wait',
      '--wait-timeout',
      '120',
      'office-renderer',
    ]);
    process.env.ALLRICE_OFFICE_RENDERER_URL = 'http://127.0.0.1:3112';
  }
  const response = await fetch(
    new URL('/health', process.env.ALLRICE_OFFICE_RENDERER_URL),
    {
      signal: globalThis.AbortSignal.timeout(5000),
      redirect: 'error',
    },
  );
  if (!response.ok)
    throw new Error(
      'Office renderer is not ready. Check ALLRICE_OFFICE_RENDERER_URL.',
    );
}
