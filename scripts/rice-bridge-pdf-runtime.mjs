/** Locked PDF resources, shared by App and CLI; no runtime npm installation. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPdfRuntime } from './rice-bridge-pdf-loader.mjs';

export const pdfSeatbeltTemplate = `(version 1)
(deny default)
(deny network*)
(deny process-fork)
(allow process-exec (literal @CORE@))
(allow sysctl-read)
(allow file-read* (literal @CORE@) (literal @CWD@) (subpath @RESOURCES@)
  (subpath "/usr/lib") (subpath "/System/Library")
  (subpath "/System/Volumes/Preboot/Cryptexes/OS")
  (literal "/System/Volumes/Preboot/Cryptexes") (literal "/System/Volumes/Preboot")
  (literal "/System/Volumes") (literal "/System") (literal "/"))
(allow file-read-metadata @ANCESTORS@)
(allow file-write-data (literal "/dev/null"))
(allow mach-lookup (global-name "com.apple.system.logger"))
`;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Distribution integrity only. Device readiness still requires actual probes. */
export async function verifyPdfPackage(core, expected, run = execFileSync) {
  const manifestBytes = await readFile(`${core}.pdf-runtime/manifest.json`);
  if (digest(manifestBytes) !== expected.manifestChecksum)
    throw Error('PDF_RESOURCE_INTEGRITY_FAILED');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const result = verifyPdfRuntime(`${core}.pdf-runtime`, manifest, {
    platform: 'darwin',
    architecture: expected.architecture,
    nodeVersion: '22.23.2',
  });
  const guardian = `${core}.pdf-guardian`,
    stat = await lstat(guardian);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o022 ||
    !(stat.mode & 0o111) ||
    (await realpath(guardian)) !== resolve(guardian) ||
    digest(await readFile(guardian)) !== expected.guardianSha256
  )
    throw Error('PDF_GUARDIAN_INTEGRITY_FAILED');
  const architecture =
    expected.architecture === 'x64' ? 'x86_64' : expected.architecture;
  for (const path of [
    core,
    guardian,
    ...manifest.files
      .filter((file) => file.path.endsWith('.node'))
      .map((file) => join(`${core}.pdf-runtime`, file.path)),
  ]) {
    const actual = run('/usr/bin/lipo', ['-archs', path], { encoding: 'utf8' })
      .trim()
      .split(/\s+/);
    if (actual.length !== 1 || actual[0] !== architecture)
      throw Error('PDF_PACKAGE_ARCHITECTURE_MISMATCH');
  }
  return result.pins;
}

export async function preparePdfRuntime(
  output,
  projectRoot = process.cwd(),
  architecture = process.env.ALLRICE_BRIDGE_APP_ARCH ?? process.arch,
) {
  if (!['x64', 'arm64'].includes(architecture))
    throw Error('PDF_ARCHITECTURE_UNSUPPORTED');
  const require = createRequire(
    join(resolve(projectRoot), 'packages/office-runtime/package.json'),
  );
  const entry = require.resolve('pdf-parse'),
    pdfRequire = createRequire(entry);
  const nativeName = `@napi-rs/canvas-darwin-${architecture}`;
  const nativeRoot = process.env.ALLRICE_BRIDGE_PDF_NATIVE_PACKAGE_DIR
    ? await realpath(resolve(process.env.ALLRICE_BRIDGE_PDF_NATIVE_PACKAGE_DIR))
    : dirname(pdfRequire.resolve(`${nativeName}/package.json`));
  const sources = [
    {
      name: 'pdf-parse',
      version: '2.4.5',
      root: resolve(dirname(entry), '../../..'),
      paths: ['package.json', 'LICENSE', 'dist/pdf-parse/cjs/index.cjs'],
    },
    {
      name: 'pdfjs-dist',
      version: '5.4.296',
      root: dirname(pdfRequire.resolve('pdfjs-dist/package.json')),
      paths: [
        'package.json',
        'LICENSE',
        'legacy/build/pdf.worker.mjs',
        'cmaps',
        'standard_fonts',
        'wasm',
      ],
    },
    {
      name: '@napi-rs/canvas',
      version: '0.1.80',
      root: dirname(pdfRequire.resolve('@napi-rs/canvas')),
      paths: [
        'package.json',
        'LICENSE',
        'index.js',
        'js-binding.js',
        'geometry.js',
        'load-image.js',
      ],
    },
    {
      name: nativeName,
      version: '0.1.80',
      root: nativeRoot,
      paths: ['package.json', `skia.darwin-${architecture}.node`],
    },
  ];
  const runtime = resolve(output) + '.pdf-runtime',
    files = [];
  await mkdir(runtime, { mode: 0o755 });
  async function copy(input, path) {
    const stat = await lstat(input);
    if (stat.isSymbolicLink()) throw Error('PDF_RESOURCE_SYMLINK');
    if (stat.isDirectory()) {
      for (const name of (await readdir(input)).sort())
        await copy(join(input, name), `${path}/${name}`);
    } else {
      if (!stat.isFile() || stat.size > 48 * 1024 * 1024)
        throw Error('PDF_RESOURCE_INVALID');
      const target = join(runtime, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await copyFile(input, target);
      await chmod(target, 0o644);
      if (
        path.endsWith('.node') &&
        process.env.ALLRICE_BRIDGE_SIGNING_MODE === 'developer-id'
      )
        execFileSync(
          '/usr/bin/codesign',
          [
            '--force',
            '--sign',
            process.env.ALLRICE_BRIDGE_SIGNING_IDENTITY,
            '--timestamp',
            '--options',
            'runtime',
            target,
          ],
          { stdio: 'inherit' },
        );
      const finalBytes = await readFile(target);
      files.push({
        path,
        sizeBytes: finalBytes.length,
        sha256: digest(finalBytes),
      });
    }
  }
  for (const source of sources) {
    const metadata = JSON.parse(
      await readFile(join(source.root, 'package.json'), 'utf8'),
    );
    if (metadata.name !== source.name || metadata.version !== source.version)
      throw Error('PDF_DEPENDENCY_NOT_LOCKED');
    source.license = metadata.license;
    for (const path of source.paths)
      await copy(
        join(source.root, path),
        `node_modules/${source.name}/${path}`,
      );
  }
  await copy(
    join(projectRoot, 'tests/fixtures/pdf/02-ruled-invoice-table.pdf'),
    'probe.pdf',
  );
  await copy(
    join(projectRoot, 'tests/fixtures/pdf/README.md'),
    'PROBE-SOURCE.md',
  );
  await copy(
    join(projectRoot, 'tests/fixtures/pdf/FONT-LICENSE.txt'),
    'PROBE-FONT-LICENSE.txt',
  );
  await writeFile(join(runtime, 'seatbelt.sb.in'), pdfSeatbeltTemplate, {
    flag: 'wx',
    mode: 0o644,
  });
  files.push({
    path: 'seatbelt.sb.in',
    sizeBytes: Buffer.byteLength(pdfSeatbeltTemplate),
    sha256: digest(pdfSeatbeltTemplate),
  });
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (
    files.length > 500 ||
    files.reduce((n, f) => n + f.sizeBytes, 0) > 96 * 1024 * 1024
  )
    throw Error('PDF_RESOURCE_BUDGET');
  const manifest = {
    contractVersion: 1,
    platform: `macos-${architecture}`,
    packages: sources.map(({ name, version, license }) => ({
      name,
      version,
      license,
    })),
    workerPath: 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    files,
  };
  const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(join(runtime, 'manifest.json'), manifestBytes, {
    flag: 'wx',
    mode: 0o644,
  });
  return {
    runtime,
    manifest,
    manifestSha256: digest(manifestBytes),
    policySha256: digest(pdfSeatbeltTemplate),
  };
}

export async function preparePdfGuardian(
  output,
  projectRoot = process.cwd(),
  architecture = process.env.ALLRICE_BRIDGE_APP_ARCH ?? process.arch,
) {
  const guardian = resolve(output) + '.pdf-guardian';
  const macho = architecture === 'arm64' ? 'arm64' : 'x86_64';
  execFileSync(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-O',
      '-target',
      `${macho}-apple-macosx13.0`,
      join(projectRoot, 'apps/rice-bridge/native/PdfGuardian.swift'),
      '-o',
      guardian,
    ],
    { stdio: 'inherit' },
  );
  execFileSync(
    '/usr/bin/codesign',
    [
      '--force',
      '--sign',
      process.env.ALLRICE_BRIDGE_SIGNING_MODE === 'developer-id'
        ? process.env.ALLRICE_BRIDGE_SIGNING_IDENTITY
        : '-',
      ...(process.env.ALLRICE_BRIDGE_SIGNING_MODE === 'developer-id'
        ? ['--timestamp', '--options', 'runtime']
        : []),
      guardian,
    ],
    { stdio: 'inherit' },
  );
  return { guardian, guardianSha256: digest(await readFile(guardian)) };
}

export function pdfSeaPlugin(manifest, guardianSha256) {
  const loader = fileURLToPath(
    new URL('./rice-bridge-pdf-loader.mjs', import.meta.url),
  );
  return {
    name: 'allrice-fixed-pdf-runtime',
    setup(build) {
      build.onResolve(
        { filter: /(?:^pdf-parse$|local-pdf-resources\.js$)/ },
        (args) => ({
          path: args.path === 'pdf-parse' ? 'parser' : 'resources',
          namespace: 'allrice-pdf',
        }),
      );
      build.onLoad({ filter: /.*/, namespace: 'allrice-pdf' }, (args) => ({
        contents: `const { inspectPdfRuntime, loadPdfRuntime } = require(${JSON.stringify(loader)}); const manifest=${JSON.stringify(manifest)}; const guardian=${JSON.stringify(guardianSha256)}; ${args.path === 'parser' ? 'module.exports=loadPdfRuntime(manifest,guardian);' : 'exports.inspectFixedPdfResources=()=>inspectPdfRuntime(manifest,guardian); exports.loadFixedPdfResources=()=>loadPdfRuntime(manifest,guardian);'}`,
        resolveDir: dirname(loader),
        loader: 'js',
      }));
    },
  };
}
