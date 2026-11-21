import {
  execFile,
  spawn,
  type ChildProcess,
  type ExecFileException,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { parse, stringify } from 'yaml';
import { createBrowserArtifacts } from './browser-artifacts';
import { prepareNativeHistory } from './native-history.mjs';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = resolve(packageRoot, '../..');

/** Reuse the installed repository graph without reading a user's pnpm config. */
export async function prepareInstalledProfileLock(
  profile: string,
  tarball: string,
  repositoryRoot = repoRoot,
) {
  type Snapshot = {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const lock = parse(
    await readFile(join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8'),
  ) as {
    lockfileVersion: string;
    settings: object;
    importers: Record<
      string,
      { dependencies?: Record<string, { specifier: string; version: string }> }
    >;
    packages: Record<string, unknown>;
    snapshots: Record<string, Snapshot>;
  };
  const product = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  );
  const direct =
    lock.importers['packages/dsh-web-composition']!.dependencies ?? {};
  const rejectLocal = (name: string, value: string) => {
    if (
      ['workspace:', 'link:', 'file:'].some((prefix) =>
        value.startsWith(prefix),
      )
    )
      throw new Error(
        `Unsupported local installed profile dependency: ${name}@${value}`,
      );
  };
  for (const [name, { specifier }] of Object.entries(direct))
    rejectLocal(name, specifier);
  expect(
    Object.fromEntries(
      Object.entries(direct).map(([name, value]) => [name, value.specifier]),
    ),
  ).toEqual(product.dependencies ?? {});
  const dependencies = Object.fromEntries(
    Object.entries(direct).map(([name, value]) => [name, value.version]),
  );
  const specifier = `file:${tarball}`;
  const key = `${product.name}@${specifier}`;
  const packages: Record<string, unknown> = {
    [key]: {
      resolution: {
        integrity:
          'sha512-' +
          createHash('sha512')
            .update(await readFile(tarball))
            .digest('base64'),
        tarball: specifier,
      },
      version: product.version,
    },
  };
  const snapshots: Record<string, Snapshot> = { [key]: { dependencies } };
  const include = (name: string, version: string) => {
    rejectLocal(name, version);
    const id = `${name}@${version}`;
    if (snapshots[id]) return;
    const snapshot = lock.snapshots[id];
    const packageId = id.split('(')[0]!;
    if (!snapshot || !lock.packages[packageId])
      throw new Error(
        `Repository lock has no installed profile dependency: ${id}`,
      );
    const metadata = lock.packages[packageId] as {
      resolution?: { integrity?: string };
    };
    if (!metadata.resolution?.integrity)
      throw new Error(`Repository lock has no dependency integrity: ${id}`);
    snapshots[id] = snapshot;
    packages[packageId] = lock.packages[packageId];
    for (const [child, selected] of Object.entries({
      ...snapshot.dependencies,
      ...snapshot.optionalDependencies,
    }))
      include(child, selected);
  };
  for (const [name, version] of Object.entries(dependencies))
    include(name, version);
  await writeFile(
    join(profile, 'pnpm-lock.yaml'),
    stringify({
      lockfileVersion: lock.lockfileVersion,
      settings: lock.settings,
      importers: {
        '.': {
          dependencies: { [product.name]: { specifier, version: specifier } },
        },
      },
      packages,
      snapshots,
    }),
  );
  const modules = parse(
    await readFile(join(repositoryRoot, 'node_modules/.modules.yaml'), 'utf8'),
  ) as { storeDir: string };
  if (typeof modules.storeDir !== 'string' || !isAbsolute(modules.storeDir))
    throw new Error('Repository install has no absolute pnpm storeDir');
  return modules.storeDir;
}

/** Keep install failures readable after the credential-free Host root is removed. */
export async function runInstalledProfilePnpm(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  pnpmVersion?: string,
) {
  const cli = process.env.npm_execpath;
  const executable = cli ? process.execPath : 'pnpm';
  const commandArgs = cli ? [cli, ...args] : args;
  try {
    return await run(executable, commandArgs, { cwd, env });
  } catch (cause) {
    const error = cause as ExecFileException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const failure = {
      executable,
      args: commandArgs,
      cwd,
      nodeVersion: process.version,
      expectedPnpmVersion: '10.33.3',
      pnpmVersion: pnpmVersion ?? null,
      code: error.code ?? null,
      signal: error.signal ?? null,
      killed: error.killed ?? false,
      message: error.message,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    };
    let evidence: string | undefined;
    let evidenceError: string | undefined;
    try {
      evidence = join(
        await createBrowserArtifacts(),
        'installed-profile-pnpm-failure.json',
      );
      await writeFile(evidence, JSON.stringify(failure, null, 2) + '\n');
    } catch (error) {
      evidenceError = String(error);
    }
    throw new Error(
      `Installed profile pnpm failed: ${JSON.stringify({ ...failure, evidence, evidenceError })}`,
      { cause },
    );
  }
}

/** Installs a real product tarball into an isolated credential-free native Host. */
export async function startInstalledProfile(
  fixtureClient = new URL('./fixtures/client.js', import.meta.url),
  options: { fixtureGlobals?: Record<string, unknown> } = {},
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-composition-browser-')),
  );
  let child: ChildProcess | undefined;
  let exited: Promise<void> = Promise.resolve();
  const close = async () => {
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await Promise.race([exited, delay(5000)]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
  try {
    const home = join(root, 'home');
    const dshHome = join(root, 'dsh');
    const profile = join(dshHome, 'profiles/allrice-web');
    await mkdir(profile, { recursive: true });
    await mkdir(home, { recursive: true });
    // No inherited model/provider credentials, config HOME, API keys or proxies.
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      DSH_HOME: dshHome,
      DSH_AGENTS_HOME: join(root, 'agents'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'),
      LANG: 'zh_CN.UTF-8',
      DO_NOT_TRACK: '1',
      COREPACK_ENABLE_NETWORK: '0',
    };
    const pnpmVersion = (
      await runInstalledProfilePnpm(['--version'], repoRoot, env)
    ).stdout.trim();
    const pnpm = (args: string[], cwd: string) =>
      runInstalledProfilePnpm(args, cwd, env, pnpmVersion);
    expect(pnpmVersion).toBe('10.33.3');
    await pnpm(['pack', '--pack-destination', root], packageRoot);
    const manifest = JSON.parse(
      await readFile(
        join(packageRoot, 'profiles/allrice-web/package.json'),
        'utf8',
      ),
    );
    const tarball = join(root, 'allrice-dsh-web-composition-0.1.0.tgz');
    manifest.dependencies['@allrice/dsh-web-composition'] = `file:${tarball}`;
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest));
    const store = await prepareInstalledProfileLock(profile, tarball);
    await pnpm(
      [
        'install',
        '--offline',
        '--ignore-scripts',
        '--frozen-lockfile',
        '--store-dir',
        store,
      ],
      profile,
    );
    const installed = join(
      profile,
      'node_modules/@allrice/dsh-web-composition',
    );
    expect(await realpath(installed)).not.toBe(await realpath(packageRoot));
    expect(
      await readFile(join(installed, 'dist/client.js'), 'utf8'),
    ).not.toContain('__allriceCompositionTest');

    // Default is the repository's exact native dependency. An explicit override
    // may select an already cached same-generation Host for a local run.
    const hostRequire = createRequire(
      process.env.ALLRICE_DSH_WEB_HOST_ANCHOR
        ? resolve(process.env.ALLRICE_DSH_WEB_HOST_ANCHOR)
        : require.resolve('@deepseek-ai/dsh/package.json'),
    );
    expect(hostRequire('@deepseek-ai/dsh/package.json').version).toBe(
      '0.2.1-rc.2',
    );
    const history = await prepareNativeHistory(hostRequire, root);
    const fixture = join(root, 'fixture-plugin');
    await mkdir(fixture);
    await writeFile(
      join(fixture, 'package.json'),
      JSON.stringify({
        name: '@allrice/composition-test-fixture',
        version: '0.0.0',
        type: 'module',
        exports: {
          '.': './index.js',
          './client': './client.js',
          './package.json': './package.json',
        },
        engines: { dsh: '0.2.1-rc.2' },
        dsh: {
          manifestVersion: 1,
          client: {
            platform: 'web',
            inject: [
              '@deepseek-ai/dsh-api-session-controller',
              '@deepseek-ai/dsh-api-workspace-controller',
              '@deepseek-ai/dsh-client-ui-workspace',
              '@deepseek-ai/dsh-client-ui-theme',
              '@allrice/dsh-web-composition',
            ],
          },
        },
      }),
    );
    await writeFile(join(fixture, 'index.js'), 'export function apply() {}\n');
    const globals = Object.entries(options.fixtureGlobals ?? {})
      .map(
        ([key, value]) =>
          `window[${JSON.stringify(key)}]=${JSON.stringify(value)};`,
      )
      .join('\n');
    await writeFile(
      join(fixture, 'client.js'),
      `${globals}\n${await readFile(fixtureClient, 'utf8')}`,
    );
    await symlink(
      fixture,
      join(profile, 'node_modules/@allrice/composition-test-fixture'),
      'dir',
    );
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      JSON.stringify([
        {
          insert: [
            {
              id: 'composition-test-fixture',
              name: '@allrice/composition-test-fixture',
            },
          ],
        },
        {
          id: 'session-persistence-jsonl',
          config: { root: history.sessions, compression: 'none' },
        },
        {
          id: 'workspace-controller',
          config: { documentsDirectory: history.workspace },
        },
        { id: 'session-title-llm', disabled: true },
        { id: 'agent-instructions', disabled: true },
      ]),
    );
    await mkdir(join(dshHome, 'storages'), { recursive: true });
    await writeFile(
      join(dshHome, 'storages/workspace.json'),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: {
          initialized: true,
          workspaceIds: [],
          archivedSessionIds: [],
          pinnedSessionIds: [],
        },
        tables: { workspaces: {} },
      }),
    );
    const reservation = createServer();
    await new Promise<void>((res) => reservation.listen(0, '127.0.0.1', res));
    const address = reservation.address();
    if (!address || typeof address === 'string')
      throw new Error('No isolated test port');
    const port = address.port;
    await new Promise<void>((res, reject) =>
      reservation.close((error) => (error ? reject(error) : res())),
    );
    const origin = `http://localhost:${port}`;
    let output = '',
      exitCode: number | null | undefined;
    child = spawn(
      process.execPath,
      [
        hostRequire.resolve('@deepseek-ai/dsh/lib/bin.js'),
        '--profile',
        'allrice-web',
        '--no-open',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--public-url',
        origin,
        '--trusted-host',
        `localhost:${port}`,
      ],
      { cwd: history.workspace, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout?.on('data', (data) => {
      output += String(data);
    });
    child.stderr?.on('data', (data) => {
      output += String(data);
    });
    exited = new Promise<void>((res) => {
      child!.once('error', () => {
        exitCode = -1;
        res();
      });
      child!.once('exit', (code) => {
        exitCode = code;
        res();
      });
    });
    let authUrl: string | undefined;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (exitCode !== undefined)
        throw new Error(`Native test Host exited before ready (${exitCode})`);
      authUrl = [
        ...output
          .replaceAll(String.fromCharCode(27), ' ')
          .matchAll(/http:\/\/[^\s]+/g),
      ]
        .map((match) => match[0])
        .find(
          (url) =>
            url.startsWith(origin + '/') &&
            new URL(url).searchParams.has('token'),
        );
      if (authUrl) break;
      await delay(100);
    }
    if (!authUrl)
      throw new Error('Native test Host did not publish its own Web login URL');
    return { root, origin, authUrl, close };
  } catch (error) {
    await close();
    throw error;
  }
}
