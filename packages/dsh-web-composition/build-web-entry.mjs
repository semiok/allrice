import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL('./', import.meta.url));
const workspace = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** @type {import('esbuild').BuildOptions} */
export const employeeWebKernelOptions = {
  bundle: true,
  platform: 'browser',
  alias: {
    'node:module': join(
      packageRoot,
      'src/employee-web-entry-node-unavailable.ts',
    ),
  },
  // rc.2 apps/web/vite.config.ts browserizes this same public kernel. Its
  // clientBuildEnvironmentDefines uses an empty env fallback; this kernel's
  // inputs contain no DSH_CLIENT_* reads. Never embed the build Host's env.
  define: {
    'process.env': '{}',
    'process.env.NODE_ENV': '"production"',
    'process.env.CORDIS_SHARED': 'undefined',
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
  },
  loader: {
    '.woff': 'file',
    '.woff2': 'file',
    '.ttf': 'file',
    '.svg': 'file',
    '.wasm': 'file',
  },
};

/** Run only inside the isolated build child, using the released launcher's
 * real application-readiness lifecycle. Never a SaaS Host or identity source. */
async function collectProfileArtifacts(outputDirectory) {
  const { loadProfileDirectory, loadLayeredEnv } =
    await import('@deepseek-ai/dsh-app-boot');
  const { runProfile } = await import('@deepseek-ai/dsh/profile-boot');
  const { bootInjections } = await import('@deepseek-ai/dsh-client-modules');
  const profileDir = join(process.env.DSH_HOME, 'profiles/allrice-web');
  await mkdir(join(profileDir, 'node_modules/@allrice'), { recursive: true });
  await symlink(
    packageRoot,
    join(profileDir, 'node_modules/@allrice/dsh-web-composition'),
    'dir',
  );
  await writeFile(
    join(profileDir, 'package.json'),
    await readFile(join(packageRoot, 'profiles/allrice-web/package.json')),
  );
  const overlay = join(profileDir, 'build-only.patch.yml');
  await writeFile(
    overlay,
    '- id: web-runtime\n  config:\n    openBrowser: false\n    printUrl: false\n    surfaceContext: true\n',
  );
  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json');
  const profile = loadProfileDirectory(
    'allrice-artifact',
    profileDir,
    installAnchor,
  );
  if (profile.skippedBundles.length)
    throw new Error('Profile bundle unavailable');
  // Installation-first may find an older workspace package's patch. Accept it
  // only when its complete patch bytes and dsh metadata equal this source.
  const ownMetadata = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  );
  const allriceLayer = profile.layers.find(
    (layer) => layer.packageName === ownMetadata.name,
  );
  if (
    !allriceLayer ||
    allriceLayer.patchPaths.length !== 1 ||
    !Buffer.from(await readFile(allriceLayer.patchPaths[0])).equals(
      await readFile(join(packageRoot, 'cordis.patch.yml')),
    ) ||
    JSON.stringify(
      JSON.parse(
        await readFile(join(allriceLayer.packageDir, 'package.json'), 'utf8'),
      ).dsh,
    ) !== JSON.stringify(ownMetadata.dsh)
  )
    throw new Error('Profile bundle differs from the current AllRice source');
  let root;
  try {
    ({ ctx: root } = await runProfile({
      profile: 'allrice-web',
      resolvedProfile: { profile, installAnchor },
      environment: loadLayeredEnv('allrice-artifact'),
      patchFiles: [overlay],
      args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
    }));
    const modules = root.get('clientModules');
    const web = root.get('webServer');
    if (!modules || !web)
      throw new Error('Public artifact services unavailable');
    if (
      (await realpath(modules.clientPath(ownMetadata.name))) !==
      (await realpath(join(packageRoot, 'dist/client.js')))
    )
      throw new Error('Profile did not select the source-built AllRice client');
    const graph = modules.graph();
    const rows = web.collectIndexInjections();
    const moduleRows = new Set(
      bootInjections(graph).map((row) => JSON.stringify(row)),
    );
    const files = [];
    const references = [
      ...new Set([...graph.entries, ...graph.batches].map((row) => row.url)),
    ];
    for (const reference of references) {
      const url = new URL(reference, 'http://127.0.0.1/');
      const response = await modules.fetchBundle(new globalThis.Request(url));
      if (!response.ok)
        throw new Error('Advertised profile bundle unavailable');
      const bytes = new Uint8Array(await response.arrayBuffer());
      const path = 'plugins/' + sha256(Buffer.from(reference)) + '.js';
      await writeFile(join(outputDirectory, path), bytes);
      files.push({
        reference,
        path,
        bytes: bytes.length,
        sha256: sha256(bytes),
      });
      const mapReference = Buffer.from(bytes)
        .toString('utf8')
        .match(/\/\/# sourceMappingURL=([^\r\n]+)\s*$/)?.[1];
      if (mapReference) {
        const mapUrl = new URL(mapReference.trim(), url);
        if (
          mapUrl.origin !== url.origin ||
          !mapUrl.pathname.startsWith('/plugins/')
        )
          throw new Error('Profile advertised an external source-map resource');
        const map = await modules.fetchBundle(new globalThis.Request(mapUrl));
        if (!map.ok)
          throw new Error('Advertised profile source map unavailable');
        const mapBytes = new Uint8Array(await map.arrayBuffer());
        const mapName = mapUrl.pathname.slice(1) + mapUrl.search;
        const mapPath = 'plugins/' + sha256(Buffer.from(mapName)) + '.map';
        await writeFile(join(outputDirectory, mapPath), mapBytes);
        files.push({
          reference: mapName,
          path: mapPath,
          bytes: mapBytes.length,
          sha256: sha256(mapBytes),
        });
      }
    }
    const result = {
      graph,
      files,
      // No collected values are emitted: owner:true and current configuration
      // must never become a release's replayable runtime identity/preferences.
      injectionInputs: rows.map((row) => ({
        kind: row.kind,
        name: row.kind === 'global' ? row.name : null,
        classification:
          row.kind === 'global' && row.name === '__DSH_REMOTE_ACCESS__'
            ? 'runtime-authority-unbound'
            : moduleRows.has(JSON.stringify(row))
              ? row.kind === 'script'
                ? 'release-code'
                : 'release-authority-unbound'
              : 'runtime-config-unbound',
        source: moduleRows.has(JSON.stringify(row))
          ? '@deepseek-ai/dsh-client-modules#bootInjections'
          : 'collectIndexInjections: current Host runtime input, not static release data',
      })),
      buildOwnerObserved: rows.some(
        (row) =>
          row.kind === 'global' &&
          row.name === '__DSH_REMOTE_ACCESS__' &&
          row.value?.owner === true,
      ),
      sourceBuiltClient: true,
    };
    await writeFile(
      join(outputDirectory, 'profile-code.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
  } finally {
    await root?.fiber.dispose();
  }
}

/** Enumerate only the release's publicly exported dist tree. This inventories
 * all lazy chunks/fonts/CSS, rather than equating graph scripts with closure. */
async function publicNativeFiles() {
  const cli = createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
  const web = createRequire(
    cli.resolve('@deepseek-ai/dsh-web-app/package.json'),
  );
  const name = '@deepseek-ai/dsh-web-frontend';
  const metadata = JSON.parse(
    await readFile(web.resolve(name + '/package.json'), 'utf8'),
  );
  if (metadata.version !== '0.2.1-rc.2')
    throw new Error('Native frontend release differs from the pinned profile');
  const root = dirname(web.resolve(name + '/dist/index.html'));
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const nameInDist = relative(root, path).split('\\').join('/');
        // Node enforces the package's public export for each copied resource.
        const exported = web.resolve(name + '/dist/' + nameInDist);
        files.push({
          path: await realpath(exported),
          output: 'native/' + nameInDist,
        });
      } else throw new Error('Unexpected non-file in the native release dist');
    }
  }
  await visit(root);
  return { name, version: metadata.version, files };
}

/** Build code artifacts only. A code inventory never supplies production
 * principal, access baseline, graph events or authority to execute a document. */
export async function buildEmployeeWebArtifact(outputDirectory) {
  outputDirectory = resolve(outputDirectory);
  await mkdir(dirname(outputDirectory), { recursive: true });
  // A failed build must not leave an old success beside replaced new bytes.
  await mkdir(outputDirectory);
  // Always rebuild this checkout's contribution; never take donor/prebuilt UI.
  await execute(process.execPath, [join(packageRoot, 'build.mjs')], {
    cwd: packageRoot,
  });
  const compiled = await readFile(join(packageRoot, 'dist/client.js'));
  const inputs = JSON.parse(
    await readFile(join(packageRoot, 'dist/build-inputs.json'), 'utf8'),
  );
  const sourceFiles = [];
  for (const input of [
    ...Object.keys(inputs.inputs),
    'build.mjs',
    'src/client.cjs',
    'package.json',
  ]) {
    if (input === 'allrice-employee-contributions.ts') continue;
    const path = join(packageRoot, input);
    sourceFiles.push({
      path: relative(workspace, path),
      sha256: sha256(await readFile(path)),
    });
  }
  const native = await publicNativeFiles();
  const files = [];
  async function emit(output, bytes) {
    const path = join(outputDirectory, output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    files.push({ path: output, bytes: bytes.length, sha256: sha256(bytes) });
  }
  await emit('allrice/client.js', compiled);
  for (const file of native.files)
    await emit(file.output, await readFile(file.path));
  const managedDirectory = join(outputDirectory, 'managed');
  const kernel = await build({
    ...employeeWebKernelOptions,
    absWorkingDir: packageRoot,
    entryPoints: ['src/employee-web-entry.ts'],
    outdir: managedDirectory,
    entryNames: 'employee-web-entry',
    assetNames: 'assets/[name]-[hash]',
    write: false,
    splitting: true,
    format: 'esm',
    // Keep CSS module identifiers descriptive across the separate native
    // kernel and AllRice contribution compilations; short independent names
    // can collide even when each compilation has a consistent local graph.
    minifySyntax: true,
    minifyWhitespace: true,
    minifyIdentifiers: false,
    metafile: true,
  });
  for (const output of Object.values(kernel.metafile.outputs)) {
    if (
      output.imports.some(
        (item) => item.external && !item.path.startsWith('data:'),
      )
    )
      throw new Error(
        'Managed kernel has an unclosed external code/asset import',
      );
  }
  for (const output of kernel.outputFiles)
    await emit(relative(outputDirectory, output.path), output.contents);
  await writeFile(
    join(outputDirectory, 'kernel-inputs.json'),
    JSON.stringify(kernel.metafile, null, 2) + '\n',
  );
  await mkdir(join(outputDirectory, 'plugins'), { recursive: true });
  const state = await mkdtemp(join(outputDirectory, '.build-state-'));
  try {
    for (const name of ['home', 'dsh', 'agents', 'tmp', 'work'])
      await mkdir(join(state, name));
    const child = await execute(
      process.execPath,
      [
        '--max-old-space-size=512',
        fileURLToPath(import.meta.url),
        '--profile-artifacts',
        outputDirectory,
      ],
      {
        cwd: join(state, 'work'),
        timeout: 60000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: dirname(process.execPath) + ':/usr/bin:/bin',
          HOME: join(state, 'home'),
          DSH_HOME: join(state, 'dsh'),
          DSH_AGENTS_HOME: join(state, 'agents'),
          XDG_CONFIG_HOME: join(state, 'home/.config'),
          XDG_DATA_HOME: join(state, 'home/.local/share'),
          TMPDIR: join(state, 'tmp'),
          DSH_TELEMETRY_DISABLED: '1',
          DO_NOT_TRACK: '1',
        },
      },
    );
    await writeFile(
      join(outputDirectory, 'profile-startup.log'),
      child.stdout + child.stderr,
    );
  } finally {
    await rm(state, { recursive: true, force: true });
  }
  const profile = JSON.parse(
    await readFile(join(outputDirectory, 'profile-code.json'), 'utf8'),
  );
  files.push(...profile.files);
  const { stdout: head } = await execute('git', ['rev-parse', 'HEAD'], {
    cwd: workspace,
  });
  const { stdout: dirty } = await execute('git', ['status', '--porcelain'], {
    cwd: workspace,
  });
  const manifest = {
    format: 1,
    status: 'code-artifacts-only',
    source: {
      head: head.trim(),
      dirty: dirty !== '',
      contributionInputs: sourceFiles,
    },
    nativeRelease: { name: native.name, version: native.version },
    files,
    // Full-profile bundle graph and the managed entry are separate proof items.
    profile,
    managedEntry: 'managed/employee-web-entry.js',
    closure: {
      publicNativeDist: true,
      sourceBuiltContribution: true,
      profileScripts: true,
      managedEntry: true,
    },
    runtime: {
      principal: null,
      snapshotFor: null,
      follow: null,
      graphEventsAuthority: null,
      executableDocument: false,
    },
  };
  await writeFile(
    join(outputDirectory, 'artifact.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv[2] === '--profile-artifacts') {
    await collectProfileArtifacts(process.argv[3]);
  } else {
    const directory = process.argv[2] ?? join(packageRoot, 'dist/web-entry');
    const manifest = await buildEmployeeWebArtifact(directory);
    process.stdout.write(
      JSON.stringify({
        status: manifest.status,
        files: manifest.files.length,
        output: directory,
      }) + '\n',
    );
  }
}
