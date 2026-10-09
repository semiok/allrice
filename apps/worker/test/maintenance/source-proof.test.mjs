import process from 'node:process';
import { URL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it, expect } from 'vitest';
import { prepareMaintenanceSourceProof } from '../../scripts/maintenance-source-proof.mjs';
const source = fileURLToPath(new URL('../../../../', import.meta.url));
const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'allrice-source-proof-'));
  roots.push(root);
  for (const path of [
    'package.json',
    'tsconfig.base.json',
    'packages/project-runtime/tsconfig.json',
    'packages/project-runtime/tsconfig.build.json',
    'packages/project-runtime/package.json',
    'packages/project-runtime/src/command-output.ts',
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(source, path), join(root, path));
  }
  mkdirSync(join(root, 'packages/project-runtime/dist'), { recursive: true });
  // Build this tiny fixture with the actual TypeScript CLI. A fresh CI checkout
  // has no production dist; never use retained build bytes as test prerequisites.
  symlinkSync(join(source, 'node_modules'), join(root, 'node_modules'), 'dir');
  const tsc = createRequire(join(source, 'package.json')).resolve(
    'typescript/bin/tsc',
  );
  execFileSync(
    process.execPath,
    [tsc, '-p', join(root, 'packages/project-runtime/tsconfig.build.json')],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  writeFileSync(
    join(root, 'packages/project-runtime/dist/index.js'),
    "export {LocalCommandOutputFilter} from './command-output.js';\n",
  );
  mkdirSync(join(root, 'apps/worker/dist'), { recursive: true });
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe('actual independent source to production JS compilation mapping', () => {
  it('compiles the pure source and records actual export/module bytes; no Git tree stays unconfirmed', () => {
    const root = fixture(),
      proof = prepareMaintenanceSourceProof(root);
    expect(proof.sourceIndependentlyCompiled).toBe(true);
    expect(proof.sourceTree).toBeNull();
    expect(proof.outputChecksum).toMatch(/^sha256:/);
    expect(
      JSON.parse(
        readFileSync(
          join(root, 'apps/worker/dist/maintenance-source-proof.json'),
          'utf8',
        ),
      ),
    ).toEqual(proof);
  });
  it('rejects stale dist after a source change rather than labelling it with current source', () => {
    const root = fixture(),
      path = join(root, 'packages/project-runtime/src/command-output.ts');
    writeFileSync(
      path,
      readFileSync(path, 'utf8') + '\nexport const staleOutputProbe=1;\n',
    );
    expect(() => prepareMaintenanceSourceProof(root)).toThrow(
      'MAINTENANCE_SOURCE_DIST_MISMATCH',
    );
  });
  it('rejects tampered production JS with unchanged source', () => {
    const root = fixture();
    writeFileSync(
      join(root, 'packages/project-runtime/dist/command-output.js'),
      'export class LocalCommandOutputFilter{}',
    );
    expect(() => prepareMaintenanceSourceProof(root)).toThrow(
      'MAINTENANCE_SOURCE_DIST_MISMATCH',
    );
  });
  it('does not extend the single pure module mapping to imported implementations', () => {
    const root = fixture(),
      path = join(root, 'packages/project-runtime/src/command-output.ts');
    writeFileSync(
      path,
      "import './different-implementation.js';\n" + readFileSync(path, 'utf8'),
    );
    expect(() => prepareMaintenanceSourceProof(root)).toThrow(
      'MAINTENANCE_PURE_MODULE_CHANGED',
    );
  });
});
