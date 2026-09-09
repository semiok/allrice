import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  realpath,
  readFile,
  writeFile,
  chmod,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { preparePlaywrightRuntime } from './rice-bridge-playwright-runtime.mjs';
import { verifyPlaywrightRuntime } from './rice-bridge-playwright-loader.mjs';
const owned = [];
afterEach(async () => {
  for (const dir of owned.splice(0)) await rm(dir, { recursive: true });
});
async function fixture() {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-playwright-vendor-test-')),
  );
  owned.push(dir);
  return { dir, ...(await preparePlaywrightRuntime(join(dir, 'BridgeCore'))) };
}
describe('offline fixed Playwright SEA distribution', () => {
  it('copies complete locked runtime and licenses, with immutable embedded expectations', async () => {
    const f = await fixture();
    expect(f.manifest.package).toEqual({
      name: 'playwright-core',
      version: '1.62.1',
    });
    for (const path of [
      'package.json',
      'index.js',
      'browsers.json',
      'lib/coreBundle.js',
      'LICENSE',
      'NOTICE',
    ])
      expect(f.manifest.files.some((file) => file.path === path)).toBe(true);
    expect(
      f.manifest.files.some(
        (file) =>
          file.path.startsWith('node_modules/') || file.path.startsWith('.'),
      ),
    ).toBe(false);
    expect(
      createHash('sha256')
        .update(await readFile(join(f.runtime, 'manifest.json')))
        .digest('hex'),
    ).toBe(f.manifestSha256);
    expect(verifyPlaywrightRuntime(f.runtime, f.manifest)).toBe(
      join(f.runtime, 'playwright-core/index.js'),
    );
    await expect(
      preparePlaywrightRuntime(join(f.dir, 'BridgeCore')),
    ).rejects.toThrow();
    expect(verifyPlaywrightRuntime(f.runtime, f.manifest)).toBe(
      join(f.runtime, 'playwright-core/index.js'),
    );
  });
  it.each([
    'changed',
    'missing',
    'extra',
    'symlink',
    'unsafe-mode',
    'manifest',
  ])('rejects %s assets before loading any external module', async (mode) => {
    const f = await fixture(),
      entry = join(f.runtime, 'playwright-core/index.js');
    if (mode === 'changed')
      await writeFile(entry, 'throw Error("must never execute");');
    if (mode === 'missing') await rm(entry);
    if (mode === 'extra')
      await writeFile(
        join(f.runtime, 'playwright-core/extra.js'),
        'must never execute',
      );
    if (mode === 'symlink') {
      await rm(entry);
      await symlink(
        join(f.runtime, 'playwright-core/lib/coreBundle.js'),
        entry,
      );
    }
    if (mode === 'unsafe-mode') await chmod(entry, 0o666);
    if (mode === 'manifest')
      await writeFile(join(f.runtime, 'manifest.json'), '{}');
    expect(() => verifyPlaywrightRuntime(f.runtime, f.manifest)).toThrow(
      'BRIDGE_BROWSER_RUNTIME_INTEGRITY_FAILED',
    );
  });
  it('rejects a symlinked distribution root and never loads a substituted manifest version', async () => {
    const f = await fixture(),
      alias = join(f.dir, 'alias.runtime');
    await symlink(f.runtime, alias);
    expect(() => verifyPlaywrightRuntime(alias, f.manifest)).toThrow(
      'BRIDGE_BROWSER_RUNTIME_INTEGRITY_FAILED',
    );
    expect(() =>
      verifyPlaywrightRuntime(f.runtime, {
        ...f.manifest,
        package: { name: 'playwright-core', version: '999' },
      }),
    ).toThrow('BRIDGE_BROWSER_RUNTIME_INTEGRITY_FAILED');
  });
});
