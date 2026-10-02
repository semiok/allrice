// Included in SEA. Expected bytes are bundled, never accepted from disk/env.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { isSea } from 'node:sea';
import { pathToFileURL } from 'node:url';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function verifyPdfRuntime(
  root,
  manifest,
  host = {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.versions.node,
  },
) {
  try {
    if (
      manifest.contractVersion !== 1 ||
      manifest.platform !== `macos-${host.architecture}` ||
      host.platform !== 'darwin' ||
      host.nodeVersion !== '22.23.2'
    )
      throw Error();
    const packages = new Map(
      manifest.packages.map((item) => [item.name, item.version]),
    );
    if (
      packages.size !== 4 ||
      packages.get('pdf-parse') !== '2.4.5' ||
      packages.get('pdfjs-dist') !== '5.4.296' ||
      packages.get('@napi-rs/canvas') !== '0.1.80' ||
      packages.get(`@napi-rs/canvas-darwin-${host.architecture}`) !== '0.1.80'
    )
      throw Error();
    if (realpathSync(root) !== resolve(root)) throw Error();
    const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
    const wanted = new Map(manifest.files.map((file) => [file.path, file]));
    wanted.set('manifest.json', {
      sizeBytes: Buffer.byteLength(manifestBytes),
      sha256: digest(manifestBytes),
    });
    const dirs = new Set(['']),
      seen = new Set();
    for (const name of wanted.keys()) {
      if (
        name.startsWith('/') ||
        name.includes('\\') ||
        name.split('/').some((p) => !p || p === '.' || p === '..')
      )
        throw Error();
      for (let d = dirname(name); d !== '.'; d = dirname(d)) dirs.add(d);
    }
    const owner = process.getuid?.();
    function scan(path, relative = '') {
      const stat = lstatSync(path);
      if (
        stat.isSymbolicLink() ||
        (stat.mode & 0o022) !== 0 ||
        (stat.uid !== owner && stat.uid !== 0)
      )
        throw Error();
      if (stat.isDirectory()) {
        if (!dirs.has(relative)) throw Error();
        for (const name of readdirSync(path))
          scan(join(path, name), relative ? `${relative}/${name}` : name);
      } else {
        const file = wanted.get(relative);
        if (
          !file ||
          !stat.isFile() ||
          stat.size !== file.sizeBytes ||
          digest(readFileSync(path)) !== file.sha256
        )
          throw Error();
        seen.add(relative);
      }
    }
    scan(root);
    if (seen.size !== wanted.size) throw Error();
    return {
      root,
      platform: manifest.platform,
      pins: {
        nodeVersion: '22.23.2',
        parserVersion: '2.4.5',
        pdfJsVersion: '5.4.296',
        canvasVersion: '0.1.80',
        resourceManifestChecksum: `sha256:${digest(manifestBytes)}`,
        policyChecksum: `sha256:${wanted.get('seatbelt.sb.in').sha256}`,
      },
    };
  } catch {
    throw Error('PDF_RESOURCE_INTEGRITY_FAILED');
  }
}

export function inspectPdfRuntime(manifest, guardianSha256) {
  if (!isSea()) throw Error('PDF_FIXED_RUNTIME_REQUIRES_SEA');
  const result = verifyPdfRuntime(process.execPath + '.pdf-runtime', manifest);
  const guardian = process.execPath + '.pdf-guardian';
  const stat = lstatSync(guardian);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o022 ||
    !(stat.mode & 0o111) ||
    realpathSync(guardian) !== resolve(guardian) ||
    digest(readFileSync(guardian)) !== guardianSha256
  )
    throw Error('PDF_GUARDIAN_INTEGRITY_FAILED');
  return { ...result, guardian, core: process.execPath };
}

export function loadPdfRuntime(manifest) {
  if (!isSea()) throw Error('PDF_FIXED_RUNTIME_REQUIRES_SEA');
  const { root } = verifyPdfRuntime(
    process.execPath + '.pdf-runtime',
    manifest,
  );
  process.env.DISABLE_SYSTEM_FONTS_LOAD = '1';
  const entry = join(
    root,
    'node_modules/pdf-parse/dist/pdf-parse/cjs/index.cjs',
  );
  const { PDFParse } = createRequire(entry)(entry);
  PDFParse.setWorker(pathToFileURL(join(root, manifest.workerPath)).href);
  return {
    PDFParse,
    resourcesDirectory: join(root, 'node_modules/pdfjs-dist'),
    root,
  };
}
