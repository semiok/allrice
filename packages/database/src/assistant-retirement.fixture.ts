/** Test-only, exact-before checkout. Never imported by a product entrypoint. */
import { createHash } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { parse as parseYaml } from 'yaml';
import { LocalStorageAdapter } from '../../storage/src/index.ts';
import { assertRuntimeFixtureDatabase } from './runtime-fixture-database.ts';

const exec = promisify(execFile);
const sha = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const pause = () => new Promise((done) => setTimeout(done, 50));
export interface RetirementDescriptor {
  beforeRef: string;
  schema: string;
  storageRoot: string;
  nativeRoot: string;
  migrations: { name: string; sha256: string }[];
  cohorts: Record<string, unknown>[];
  deletedObjects?: Record<string, unknown>[];
  retainedObjects?: Record<string, unknown>[];
  beforeEvidenceDigest: string;
}

export async function createRetirementUpgradeFixture(options: {
  beforeRef: string;
  beforeDriver: string | URL;
  migrationName?: '0229_retire_legacy_assistants.sql';
}) {
  if (!/^[a-f0-9]{40}$/.test(options.beforeRef))
    throw Error('Exact before SHA required');
  const databaseUrl = process.env.ALLRICE_TEST_DATABASE_URL;
  if (!databaseUrl) throw Error('Dedicated ALLRICE_TEST_DATABASE_URL required');
  assertRuntimeFixtureDatabase(new URL(databaseUrl));
  const repository = resolve(
    fileURLToPath(new URL('../../../', import.meta.url)),
  );
  const source =
    options.beforeDriver instanceof URL
      ? fileURLToPath(options.beforeDriver)
      : resolve(options.beforeDriver);
  const driverPath = relative(repository, source);
  if (
    driverPath.startsWith('..') ||
    !driverPath.startsWith('apps/worker/test/')
  )
    throw Error('Before driver must be a repository-owned Worker test');
  const temp = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-retirement-')),
  );
  const before = join(temp, 'before');
  await mkdir(before);
  let child: ChildProcess | undefined;
  let ended: Promise<number | null> | undefined;
  let exit: number | null | undefined;
  let db: ReturnType<typeof postgres> | undefined;
  let descriptor: RetirementDescriptor | undefined;
  const ready = join(temp, 'ready.json'),
    release = join(temp, 'release'),
    closed = join(temp, 'closed.json');
  const log: string[] = [];
  async function waitFor(path: string, timeoutMs = 120_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (
        await access(path).then(
          () => true,
          () => false,
        )
      )
        return;
      if (exit !== undefined)
        throw Error(
          `Before keeper exited ${exit}: ${log.join('').slice(-8000)}`,
        );
      await pause();
    }
    throw Error(
      `Before keeper did not produce ${relative(temp, path)}: ${log.join('').slice(-8000)}`,
    );
  }
  async function close() {
    await db?.end({ timeout: 5 });
    await writeFile(release, 'release');
    if (child && exit === undefined)
      await Promise.race([
        ended,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(Error('Before keeper cleanup timeout')),
            30_000,
          ),
        ),
      ]);
    const cleanup = await readFile(closed, 'utf8').then(JSON.parse);
    if (
      !cleanup.schemaRemoved ||
      !cleanup.storageRemoved ||
      !cleanup.databaseClosed ||
      !cleanup.adminClosed
    )
      throw Error('Before keeper cleanup unconfirmed');
    await rm(temp, { recursive: true, force: true });
    return cleanup;
  }
  try {
    const actual = (
      await exec('git', ['rev-parse', `${options.beforeRef}^{commit}`], {
        cwd: repository,
      })
    ).stdout.trim();
    if (actual !== options.beforeRef) throw Error('Before commit mismatch');
    const archive = join(temp, 'before.tar');
    await exec(
      'git',
      ['archive', '--format=tar', `--output=${archive}`, actual],
      { cwd: repository },
    );
    await exec('tar', ['-xf', archive, '-C', before]);
    await rm(archive);
    await mkdir(dirname(join(before, driverPath)), { recursive: true });
    await copyFile(source, join(before, driverPath));
    // Do not reuse candidate workspace package symlinks: old imports must resolve
    // to this exact checkout. The normal test store already contains the lockfile.
    // m5-test installs into an explicit shared store while Vitest can run with
    // a different HOME. Reuse this candidate's actual dependency store; do not
    // change host configuration or fetch a different dependency graph.
    const modules = parseYaml(
      await readFile(join(repository, 'node_modules/.modules.yaml'), 'utf8'),
    ) as { storeDir?: unknown };
    if (typeof modules.storeDir !== 'string')
      throw Error('Installed pnpm store metadata missing');
    try {
      await exec(
        'pnpm',
        [
          'install',
          '--offline',
          '--frozen-lockfile',
          '--store-dir',
          modules.storeDir,
        ],
        {
          cwd: before,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, CI: 'true' },
        },
      );
    } catch (error) {
      const output = error as { stdout?: string; stderr?: string };
      throw new Error(
        `Before dependency install failed: ${output.stdout ?? ''} ${output.stderr ?? ''}`,
        { cause: error },
      );
    }
    await exec('pnpm', ['--filter', '@allrice/contracts', 'build'], {
      cwd: before,
      maxBuffer: 10 * 1024 * 1024,
    });
    const keeperPath =
      'apps/worker/test/met210-retirement-keeper.integration.test.ts';
    const driverImport =
      './' + relative(dirname(keeperPath), driverPath).replaceAll('\\', '/');
    await writeFile(
      join(before, keeperPath),
      `
import { it } from 'vitest';
import { mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createAssistantFixtureDatabase, assistantFixtureStorage } from '../../../packages/database/src/assistant-runtime.fixture.ts';
import seed from ${JSON.stringify(driverImport)};
it('seeds actual pre-retirement APIs and stops all writers before handoff', async () => {
 const f = await createAssistantFixtureDatabase();
 try {
  const nativeRoot=${JSON.stringify(join(temp, 'native'))}; await mkdir(nativeRoot);
  const data=await seed({db:f.db,storage:assistantFixtureStorage(f.db),storageRoot:f.storageRoot,nativeRoot});
  const [identity]=await f.db\`select current_schema() as schema\`;
  const directory=new URL('../../../packages/database/migrations/',import.meta.url);
  const migrations=await Promise.all((await readdir(directory)).filter(n=>n.endsWith('.sql')).sort().map(async name=>({name,sha256:createHash('sha256').update(await readFile(new URL(name,directory))).digest('hex')})));
  // seed must have drained Host/Worker. Close the old data pool before READY;
  // only the fixture's idle admin connection retains cleanup ownership.
  await f.db.end({timeout:5});
  const descriptor={...data,beforeRef:${JSON.stringify(actual)},schema:identity.schema,storageRoot:f.storageRoot,nativeRoot,migrations};
  await writeFile(${JSON.stringify(ready)},JSON.stringify({...descriptor,beforeEvidenceDigest:createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')}));
  while (!(await access(${JSON.stringify(release)}).then(()=>true,()=>false))) await new Promise(done=>setTimeout(done,50));
 } finally {await writeFile(${JSON.stringify(closed)},JSON.stringify(await f.close()));}
},1200000);
`,
    );
    child = spawn(
      'pnpm',
      ['exec', 'vitest', 'run', '--maxWorkers=1', keeperPath],
      {
        cwd: before,
        env: { ...process.env, ALLRICE_RUN_DB_INTEGRATION: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout?.on('data', (chunk) => log.push(String(chunk)));
    child.stderr?.on('data', (chunk) => log.push(String(chunk)));
    ended = new Promise((done, reject) => {
      child!.once('error', reject);
      child!.once('exit', (code) => {
        exit = code;
        done(code);
      });
    });
    await waitFor(ready, 300_000);
    descriptor = JSON.parse(
      await readFile(ready, 'utf8'),
    ) as RetirementDescriptor;
    if (
      descriptor.beforeRef !== actual ||
      !/^p25_[a-f0-9]{32}$/.test(descriptor.schema) ||
      (await realpath(descriptor.storageRoot)) !== descriptor.storageRoot ||
      descriptor.nativeRoot !== join(temp, 'native')
    )
      throw Error('Invalid before ownership descriptor');
    for (const migration of descriptor.migrations) {
      const current = await readFile(
        new URL(`../migrations/${migration.name}`, import.meta.url),
      );
      if (sha(current) !== migration.sha256)
        throw Error(`Before migration bytes changed: ${migration.name}`);
    }
    const url = new URL(databaseUrl);
    // Normal API queries need public's pgvector type/operators. Every retired
    // relation assertion below is schema-qualified; the source schema is first.
    const searchPath = `${descriptor.schema},public`;
    url.searchParams.set('options', `-csearch_path=${searchPath}`);
    db = postgres(url.toString(), {
      max: 4,
      onnotice: () => {},
      connection: { application_name: `retirement-after-${descriptor.schema}` },
    });
    const [identity] =
      await db`select current_schema() as schema,current_setting('search_path') as path`;
    if (identity?.schema !== descriptor.schema || identity.path !== searchPath)
      throw Error('Upgrade schema continuity failed');
    const storage = new LocalStorageAdapter(descriptor.storageRoot);
    let applied = false;
    return {
      descriptor,
      db,
      storage,
      async applyRetirement() {
        if (applied) throw Error('Retirement already applied');
        const name =
          options.migrationName ?? '0229_retire_legacy_assistants.sql';
        const bytes = await readFile(
          new URL(`../migrations/${name}`, import.meta.url),
          'utf8',
        );
        await db!.begin((tx) => tx.unsafe(bytes));
        applied = true;
        return {
          name,
          sha256: sha(bytes),
          schema: descriptor!.schema,
          storageRoot: descriptor!.storageRoot,
        };
      },
      close,
    };
  } catch (error) {
    await writeFile(release, 'release').catch(() => {});
    await db?.end({ timeout: 5 }).catch(() => {});
    if (child && exit === undefined) {
      await Promise.race([
        ended,
        new Promise((done) => setTimeout(done, 10_000)),
      ]);
      if (exit === undefined) child.kill('SIGTERM');
    }
    // Preserve failed evidence if a keeper cannot prove its owned cleanup.
    if (
      !child ||
      (await access(closed).then(
        () => true,
        () => false,
      ))
    )
      await rm(temp, { recursive: true, force: true });
    throw error;
  }
}
