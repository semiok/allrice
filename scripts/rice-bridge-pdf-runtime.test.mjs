import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  realpath,
  chmod,
  rm,
  symlink,
  readFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyPdfRuntime } from './rice-bridge-pdf-loader.mjs';
import {
  pdfSeatbeltTemplate,
  verifyPdfPackage,
} from './rice-bridge-pdf-runtime.mjs';

const owned = [];
afterEach(async () => {
  for (const dir of owned.splice(0))
    await rm(dir, { recursive: true, force: true });
});
const host = {
  platform: 'darwin',
  architecture: 'x64',
  nodeVersion: '22.23.2',
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-pdf-sidecar-')),
  );
  owned.push(dir);
  const root = join(dir, 'Bridge.pdf-runtime');
  await mkdir(root);
  const files = [];
  for (const [path, bytes] of [
    ['seatbelt.sb.in', Buffer.from(pdfSeatbeltTemplate)],
    [
      'LICENSE',
      Buffer.from('synthetic package-integrity fixture; no native execution'),
    ],
  ]) {
    await writeFile(join(root, path), bytes, { mode: 0o644 });
    files.push({ path, sizeBytes: bytes.length, sha256: hash(bytes) });
  }
  const manifest = {
    contractVersion: 1,
    platform: 'macos-x64',
    packages: [
      { name: 'pdf-parse', version: '2.4.5' },
      { name: 'pdfjs-dist', version: '5.4.296' },
      { name: '@napi-rs/canvas', version: '0.1.80' },
      { name: '@napi-rs/canvas-darwin-x64', version: '0.1.80' },
    ],
    workerPath: 'worker.mjs',
    files,
  };
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  return { dir, root, manifest };
}
describe('PDF sidecar integrity (filesystem facts, not native readiness)', () => {
  it('checks exact bundled bytes and computes policy/resource pins without loading modules', async () => {
    const f = await fixture(),
      result = verifyPdfRuntime(f.root, f.manifest, host);
    expect(result.pins.resourceManifestChecksum).toBe(
      `sha256:${hash(await readFile(join(f.root, 'manifest.json')))}`,
    );
    expect(result.pins.policyChecksum).toBe(
      `sha256:${hash(pdfSeatbeltTemplate)}`,
    );
  });
  it.each(['changed', 'missing', 'extra', 'symlink', 'writable', 'manifest'])(
    'rejects %s resources before any parser code loads',
    async (mode) => {
      const f = await fixture(),
        path = join(f.root, 'LICENSE');
      if (mode === 'changed') await writeFile(path, 'modified');
      if (mode === 'missing') await rm(path);
      if (mode === 'extra')
        await writeFile(
          join(f.root, 'untrusted.js'),
          'throw Error("must never execute")',
        );
      if (mode === 'symlink') {
        await rm(path);
        await symlink(join(f.root, 'seatbelt.sb.in'), path);
      }
      if (mode === 'writable') await chmod(path, 0o666);
      if (mode === 'manifest')
        await writeFile(join(f.root, 'manifest.json'), '{}');
      expect(() => verifyPdfRuntime(f.root, f.manifest, host)).toThrow(
        'PDF_RESOURCE_INTEGRITY_FAILED',
      );
    },
  );
  it('refuses a different parser version, architecture, Node version and symlinked root', async () => {
    const f = await fixture();
    expect(() =>
      verifyPdfRuntime(f.root, f.manifest, { ...host, architecture: 'arm64' }),
    ).toThrow();
    expect(() =>
      verifyPdfRuntime(f.root, f.manifest, { ...host, nodeVersion: '22.13.0' }),
    ).toThrow();
    expect(() =>
      verifyPdfRuntime(
        f.root,
        {
          ...f.manifest,
          packages: f.manifest.packages.map((p) =>
            p.name === 'pdf-parse' ? { ...p, version: '9.0.0' } : p,
          ),
        },
        host,
      ),
    ).toThrow();
    const alias = join(f.dir, 'alias');
    await symlink(f.root, alias);
    expect(() => verifyPdfRuntime(alias, f.manifest, host)).toThrow();
  });
  it('checks the same packaged resources and guardian for App and CLI without claiming readiness', async () => {
    const f = await fixture(),
      core = join(f.dir, 'Bridge'),
      guardian = `${core}.pdf-guardian`;
    await writeFile(core, 'synthetic core');
    await writeFile(guardian, 'synthetic trusted guardian', { mode: 0o755 });
    const expected = {
      architecture: 'x64',
      manifestChecksum: hash(await readFile(join(f.root, 'manifest.json'))),
      guardianSha256: hash(await readFile(guardian)),
    };
    const paths = [];
    const pins = await verifyPdfPackage(core, expected, (_program, args) => {
      paths.push(args.at(-1));
      return 'x86_64\n';
    });
    expect(paths).toEqual([core, guardian]);
    expect(pins.resourceManifestChecksum).toBe(
      `sha256:${expected.manifestChecksum}`,
    );
    await expect(
      verifyPdfPackage(core, expected, () => 'arm64\n'),
    ).rejects.toThrow('PDF_PACKAGE_ARCHITECTURE_MISMATCH');
    await writeFile(guardian, 'changed');
    await expect(
      verifyPdfPackage(core, expected, () => 'x86_64\n'),
    ).rejects.toThrow('PDF_GUARDIAN_INTEGRITY_FAILED');
  });
});
