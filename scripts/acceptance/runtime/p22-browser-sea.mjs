/** Real SEA acceptance, or explicitly unexecuted cross-architecture fixture build. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  preparePlaywrightRuntime,
  playwrightSeaPlugin,
} from '../../rice-bridge-playwright-runtime.mjs';
const node = process.env.ALLRICE_BRIDGE_NODE_BINARY,
  postject = process.env.ALLRICE_POSTJECT_CLI;
assert(
  node && postject,
  'Verified offline Node and postject paths are required',
);
assert.equal(process.platform, 'darwin');
const targetArch = process.env.ALLRICE_BRIDGE_APP_ARCH ?? process.arch;
assert(['arm64', 'x64'].includes(targetArch), 'Supported target architecture');
const buildOnly = process.env.ALLRICE_BRIDGE_SEA_TEST_BUILD_ONLY === '1';
assert(
  targetArch === process.arch || buildOnly,
  'Cross-architecture fixture must explicitly remain unexecuted',
);
const blobNode = process.env.ALLRICE_BRIDGE_BLOB_NODE_BINARY ?? node;
const productionCore = process.env.ALLRICE_BRIDGE_PRODUCTION_SEA;
assert(
  execFileSync('/usr/bin/file', [node], { encoding: 'utf8' }).includes(
    targetArch === 'arm64' ? 'arm64' : 'x86_64',
  ),
  'Verified Node binary must match the target architecture',
);
const metadata = JSON.parse(
  await readFile(resolve(postject, '../../package.json'), 'utf8'),
);
assert.equal(metadata.name, 'postject');
assert.equal(metadata.version, '1.0.0-alpha.6');
const directory = await realpath(
  await mkdtemp(join(tmpdir(), 'allrice-p22-sea-')),
);
const binary = join(directory, 'SyntheticBrowserSEA'),
  bundle = join(directory, 'fixture.cjs'),
  blob = join(directory, 'fixture.blob');
const fixtureRoot = join(directory, 'profile');
await mkdir(fixtureRoot, { mode: 0o700 });
const require = createRequire(import.meta.url),
  esbuild = createRequire(require.resolve('tsx/package.json'))('esbuild');
const report = {
  directory,
  passed: false,
  buildPassed: false,
  runtimeExecuted: false,
  targetArch,
  hostArch: process.arch,
  sourceEntry: 'apps/rice-bridge/test/playwright-sea-worker.ts',
  modelCalls: 0,
  personalProfiles: false,
  nodeVersion:
    targetArch === process.arch
      ? execFileSync(node, ['--version'], { encoding: 'utf8' }).trim()
      : null,
  blobNodeVersion: execFileSync(blobNode, ['--version'], {
    encoding: 'utf8',
  }).trim(),
  nodeBinarySha256: createHash('sha256')
    .update(await readFile(node))
    .digest('hex'),
  sourceSha256: Object.fromEntries(
    await Promise.all(
      [
        'apps/rice-bridge/src/local-browser-driver.ts',
        'apps/rice-bridge/src/local-browser-supervisor.ts',
        'apps/rice-bridge/native/BrowserLauncher.swift',
        'apps/rice-bridge/test/playwright-sea-worker.ts',
      ].map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ]),
    ),
  ),
};
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 1024 * 1024,
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      TMPDIR: directory,
    },
    ...options,
  });
}
try {
  const runtime = await preparePlaywrightRuntime(binary);
  await esbuild.build({
    entryPoints: [resolve(report.sourceEntry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    plugins: [playwrightSeaPlugin(runtime.manifest)],
  });
  const config = join(directory, 'sea.json');
  await writeFile(
    config,
    JSON.stringify({
      main: bundle,
      output: blob,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
    }),
    { mode: 0o600 },
  );
  run(blobNode, ['--experimental-sea-config', config]);
  await copyFile(node, binary);
  await chmod(binary, 0o700);
  try {
    run('/usr/bin/codesign', ['--remove-signature', binary]);
  } catch {
    /* Official binary may be unsigned. */
  }
  run(process.execPath, [
    postject,
    binary,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    '--macho-segment-name',
    'NODE_SEA',
  ]);
  run('/usr/bin/codesign', ['--sign', '-', binary]);
  const helper = join(dirname(binary), 'RiceBrowserLauncher');
  run('/usr/bin/xcrun', [
    'swiftc',
    '-target',
    `${targetArch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx12.0`,
    'apps/rice-bridge/native/BrowserLauncher.swift',
    '-o',
    helper,
  ]);
  await chmod(helper, 0o755);
  run('/usr/bin/codesign', ['--sign', '-', helper]);
  report.runtimeManifestSha256 = runtime.manifestSha256;
  report.buildPassed = true;
  if (buildOnly) {
    report.artifacts = [binary, runtime.runtime, helper];
    report.executionRequired =
      'Copy all three artifacts unchanged to a private directory on the matching architecture, create a fresh 0700 fixture directory, then execute SyntheticBrowserSEA <fixture-directory>. This build receipt is not a runtime pass.';
  } else {
    report.runtimeExecuted = true;
    const result = JSON.parse(
      run(binary, [fixtureRoot]).trim().split('\n').at(-1),
    );
    assert.equal(result.passed, true);
    assert.equal(result.physicalStopConfirmed, true);
    report.result = result;
    // Repackage into the actual Resources/MacOS shape, archive and extract at a
    // different path. This exercises relocation without a source-tree fallback.
    const packageRoot = join(directory, 'package');
    const app = join(packageRoot, 'Synthetic Browser.app');
    const resources = join(app, 'Contents/Resources');
    const macos = join(app, 'Contents/MacOS');
    await mkdir(resources, { recursive: true });
    await mkdir(macos, { recursive: true });
    await copyFile(binary, join(resources, 'SyntheticBrowserSEA'));
    await cp(runtime.runtime, join(resources, 'SyntheticBrowserSEA.runtime'), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await copyFile(helper, join(macos, 'RiceBrowserLauncher'));
    if (productionCore) {
      await copyFile(productionCore, join(resources, 'RiceBridgeCore'));
      await cp(
        `${productionCore}.runtime`,
        join(resources, 'RiceBridgeCore.runtime'),
        {
          recursive: true,
          errorOnExist: true,
          force: false,
        },
      );
    }
    const archive = join(directory, 'synthetic-app.zip');
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, archive]);
    const extracted = join(directory, 'extracted');
    await mkdir(extracted);
    run('/usr/bin/ditto', ['-x', '-k', archive, extracted]);
    const relocatedBinary = join(
      extracted,
      'Synthetic Browser.app/Contents/Resources/SyntheticBrowserSEA',
    );
    const relocatedResult = JSON.parse(
      run(relocatedBinary, [fixtureRoot]).trim().split('\n').at(-1),
    );
    assert.equal(relocatedResult.passed, true);
    assert.equal(relocatedResult.physicalStopConfirmed, true);
    report.extractedAppLayout = relocatedResult;
    if (productionCore) {
      const core = join(dirname(relocatedBinary), 'RiceBridgeCore');
      const config = join(fixtureRoot, 'core-config.json');
      const configBytes = JSON.stringify({
        server: 'https://saas.example.com',
        deviceId: 'synthetic-sea-device',
        deviceName: 'Synthetic SEA device',
        grants: [],
      });
      await writeFile(config, configBytes, { mode: 0o600, flag: 'wx' });
      const coreRun = (args) =>
        run(core, args, {
          env: {
            PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
            TMPDIR: directory,
            ALLRICE_BRIDGE_CONFIG_PATH: config,
          },
        });
      const cli = (operation) =>
        JSON.parse(coreRun(['browser', operation]).trim());
      assert.equal(cli('status').enabled, false);
      assert.equal(await readFile(config, 'utf8'), configBytes);
      assert.equal(cli('enable').enabled, true);
      assert.equal(cli('status').enabled, true);
      assert.equal(cli('disable').enabled, false);
      assert.equal(cli('status').enabled, false);
      assert.equal(await readFile(config, 'utf8'), configBytes);
      for (const credentialPath of [
        `${config}.token`,
        `${config}.credentials`,
      ]) {
        await assert.rejects(lstat(credentialPath), { code: 'ENOENT' });
      }
      const savedRuntime = join(directory, 'core-runtime-unavailable');
      await rename(`${core}.runtime`, savedRuntime);
      try {
        assert.throws(
          () => coreRun(['browser', 'enable']),
          (error) =>
            String(error.stderr).includes(
              'BRIDGE_BROWSER_RUNTIME_INTEGRITY_FAILED',
            ),
        );
        // The disabled-state reader does not import a browser engine. Resource
        // failure must prevent enabling, not make the read-only setting unusable.
        assert.equal(cli('status').enabled, false);
      } finally {
        await rename(savedRuntime, `${core}.runtime`);
      }
      report.productionCore = {
        binarySha256: createHash('sha256')
          .update(await readFile(core))
          .digest('hex'),
        version: coreRun(['--version']).trim(),
        extractedAppLayout: true,
        browserStatusReadOnly: true,
        optInAndDisable: true,
        missingRuntimeDenied: true,
        syntheticConfigUnchanged: true,
        noCredentialFilesCreated: true,
        personalConfigOrKeychainAccess: false,
        scope:
          'Actual Core browser subcommands only, no global status/pair/start or token read',
      };
    }
    const movedRuntime = `${relocatedBinary}.runtime`;
    const unavailableRuntime = join(
      directory,
      'temporarily-unavailable-runtime',
    );
    await rename(movedRuntime, unavailableRuntime);
    try {
      let denied = false;
      try {
        run(relocatedBinary, [fixtureRoot]);
      } catch (error) {
        denied = String(error.stderr).includes(
          'BRIDGE_BROWSER_RUNTIME_INTEGRITY_FAILED',
        );
      }
      assert(
        denied,
        'Missing actual App runtime must reject before Chrome launch',
      );
    } finally {
      await rename(unavailableRuntime, movedRuntime);
    }
    report.missingAppRuntimeDenied = true;
    // Move one fixed copied asset, then assert the actual SEA fails closed before Chrome launch.
    const entry = join(runtime.runtime, 'playwright-core/index.js');
    const original = await readFile(entry);
    await writeFile(entry, 'throw Error("must never execute");');
    try {
      let rejected = false;
      try {
        run(binary, [fixtureRoot]);
      } catch (error) {
        rejected = String(error.stderr).includes(
          'BRIDGE_BROWSER_RUNTIME_INTEGRITY_FAILED',
        );
      }
      assert(
        rejected,
        'Tampered actual SEA runtime must reject before loading external code',
      );
    } finally {
      await writeFile(entry, original);
      await chmod(entry, 0o644);
    }
    assert((await lstat(binary)).isFile());
    report.tamperedSeaDenied = true;
    report.passed = true;
  }
} catch (error) {
  report.failure =
    error instanceof Error ? error.message.split('\n')[0] : 'FAILED';
  process.exitCode = 1;
} finally {
  await writeFile(
    join(directory, 'report.json'),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      report: join(directory, 'report.json'),
      passed: report.passed,
      buildPassed: report.buildPassed,
      runtimeExecuted: report.runtimeExecuted,
    }),
  );
}
