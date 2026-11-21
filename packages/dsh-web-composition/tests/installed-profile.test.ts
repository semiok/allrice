import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import {
  prepareInstalledProfileLock,
  runInstalledProfilePnpm,
} from './installed-profile';

const roots: string[] = [];
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it('offline-installs the actual tarball with native Host exports in an empty HOME without registry metadata', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-locked-profile-')),
  );
  roots.push(root);
  const profile = join(root, 'profile');
  const home = join(root, 'home');
  await mkdir(profile);
  await mkdir(home);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    COREPACK_ENABLE_NETWORK: '0',
    LANG: 'zh_CN.UTF-8',
    DO_NOT_TRACK: '1',
  };
  expect(
    (
      await runInstalledProfilePnpm(['--version'], packageRoot, env)
    ).stdout.trim(),
  ).toBe('10.33.3');
  await runInstalledProfilePnpm(
    ['pack', '--pack-destination', root],
    packageRoot,
    env,
    '10.33.3',
  );
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
  const installed = await runInstalledProfilePnpm(
    [
      'install',
      '--offline',
      '--ignore-scripts',
      '--frozen-lockfile',
      '--store-dir',
      store,
    ],
    profile,
    env,
    '10.33.3',
  );
  expect(installed.stdout).toContain('resolution step is skipped');
  const installedRoot = join(
    profile,
    'node_modules/@allrice/dsh-web-composition',
  );
  expect(await realpath(installedRoot)).not.toBe(await realpath(packageRoot));
  const installedRequire = createRequire(join(installedRoot, 'package.json'));
  for (const entry of [
    'plugin-manager',
    'settings-account',
    'settings-models',
  ]) {
    const native = await import(
      pathToFileURL(
        installedRequire.resolve('@allrice/dsh-web-composition/host/' + entry),
      ).href
    );
    if (entry === 'plugin-manager') {
      expect(typeof native.default, entry).toBe('function');
      expect(native.default.Config({})).toMatchObject({
        registryProbeEnabled: true,
        registryProbeTimeoutMs: 1500,
      });
    } else {
      expect(typeof native.apply, entry).toBe('function');
      expect(native.Config({})).toMatchObject(
        entry === 'settings-models'
          ? { credentialOnboarding: true }
          : { contactSource: '', bonusAckRetryDelayMs: 1000 },
      );
    }
  }
  expect(
    (await readdir(home, { recursive: true })).some((file) =>
      file.includes('metadata-v1.3'),
    ),
  ).toBe(false);
  console.info(
    'Credential-free offline tarball install (no Host started): ' +
      JSON.stringify({
        profile,
        store,
        stdout: installed.stdout,
        stderr: installed.stderr,
      }),
  );
});

it.each(['workspace:', 'link:', 'file:'])(
  'rejects unsupported %s dependencies in direct and transitive fixture graphs',
  async (protocol) => {
    const root = await mkdtemp(join(tmpdir(), 'allrice-local-profile-'));
    roots.push(root);
    const tarball = join(root, 'synthetic.tgz');
    await writeFile(tarball, 'synthetic tarball bytes; never installed');
    const original = await readFile(
      join(packageRoot, '../../pnpm-lock.yaml'),
      'utf8',
    );
    for (const direct of [true, false]) {
      const lock = parse(original);
      const dependencies =
        lock.importers['packages/dsh-web-composition'].dependencies;
      const name = '@deepseek-ai/dsh-client-ui-plugin-manager';
      if (direct) dependencies[name].specifier = protocol + '../synthetic';
      else
        lock.snapshots[`${name}@${dependencies[name].version}`].dependencies[
          'synthetic-local'
        ] = protocol + '../synthetic';
      await writeFile(join(root, 'pnpm-lock.yaml'), stringify(lock));
      await expect(
        prepareInstalledProfileLock(root, tarball, root),
      ).rejects.toThrow('Unsupported local installed profile dependency:');
    }
  },
);

it('preserves pnpm stdout, stderr and command metadata outside the removed profile root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'allrice-pnpm-diagnostic-'));
  roots.push(root);
  const profile = join(root, 'profile');
  const artifacts = join(root, 'evidence');
  await mkdir(profile);
  const cli = join(root, 'synthetic-pnpm.cjs');
  await writeFile(
    cli,
    `process.stdout.write('ERR_PNPM_NO_OFFLINE_META synthetic package metadata\\n');
process.stderr.write('synthetic stderr diagnostic\\n');
process.exit(17);\n`,
  );
  vi.stubEnv('npm_execpath', cli);
  vi.stubEnv('ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR', artifacts);
  const args = ['install', '--offline', '--ignore-scripts'];
  let error: Error | undefined;
  try {
    await runInstalledProfilePnpm(args, profile, { HOME: profile }, '10.33.3');
  } catch (cause) {
    error = cause as Error;
  }
  expect(error?.message).toContain('ERR_PNPM_NO_OFFLINE_META');
  expect(error?.message).toContain('synthetic stderr diagnostic');
  expect(error?.cause).toMatchObject({ code: 17 });
  await rm(profile, { recursive: true });
  const directories = await readdir(artifacts);
  expect(directories).toHaveLength(1);
  const evidence = join(
    artifacts,
    directories[0]!,
    'installed-profile-pnpm-failure.json',
  );
  expect(error?.message).toContain(evidence);
  expect(JSON.parse(await readFile(evidence, 'utf8'))).toEqual({
    executable: process.execPath,
    args: [cli, ...args],
    cwd: profile,
    nodeVersion: process.version,
    expectedPnpmVersion: '10.33.3',
    pnpmVersion: '10.33.3',
    code: 17,
    signal: null,
    killed: false,
    message: expect.stringContaining('Command failed:'),
    stdout: 'ERR_PNPM_NO_OFFLINE_META synthetic package metadata\n',
    stderr: 'synthetic stderr diagnostic\n',
  });
});
