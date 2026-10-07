import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { verifyDshPhysicalPatches } from './verify-dsh-physical-patches.mjs';

const folders = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'allrice-dsh-ledger-'));
  folders.push(root);
  await mkdir(join(root, 'patches'));
  const upstreamVersion = '0.1.5-rc.3';
  const ledger = {
    patches: [
      {
        id: 'migration',
        kind: 'upstream-source-patch',
        upstreamVersion,
        path: `patches/@deepseek-ai__dsh-session-format-v0-to-v1@${upstreamVersion}.patch`,
      },
      {
        id: 'client',
        kind: 'upstream-source-patch',
        upstreamVersion,
        path: `patches/@deepseek-ai__dsh-client-connection@${upstreamVersion}.patch`,
      },
      {
        id: 'adapter',
        kind: 'protocol-extension',
        upstreamVersion,
        path: 'adapter.mjs',
      },
    ],
    physicalPatches: [],
  };
  const workspace = {
    patchedDependencies: { 'next@16.2.1': 'patches/next@16.2.1.patch' },
  };
  const lock = {
    patchedDependencies: {
      'next@16.2.1': { path: 'patches/next@16.2.1.patch', hash: 'unrelated' },
    },
  };
  for (const [name, owner] of [
    ['session-format-v0-to-v1', 'migration'],
    ['session-persistence-jsonl', 'migration'],
    ['client-connection', 'client'],
  ]) {
    const pkg = '@deepseek-ai/dsh-' + name;
    const path = `patches/@deepseek-ai__dsh-${name}@${upstreamVersion}.patch`;
    const bytes = Buffer.from(`diff ${name}\n`);
    await writeFile(join(root, path), bytes);
    const key = `${pkg}@${upstreamVersion}`;
    workspace.patchedDependencies[key] = path;
    lock.patchedDependencies[key] = {
      path,
      hash: createHash('sha256').update(bytes).digest('hex'),
    };
    ledger.physicalPatches.push({
      package: pkg,
      version: upstreamVersion,
      path,
      responsibilityId: owner,
    });
  }
  return { root, upstreamVersion, ledger, workspace, lock };
}

describe('physical DSH patch governance', () => {
  it('verifies the checked-in files and separately counts responsibilities', async () => {
    const root = resolve(import.meta.dirname, '..');
    const ledger = JSON.parse(
      await readFile(join(root, 'apps/worker/dsh/patch-ledger.json'), 'utf8'),
    );
    const workspace = parse(
      await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'),
    );
    const lock = parse(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'));
    const upstream = JSON.parse(
      await readFile(join(root, 'apps/worker/dsh/upstream.json'), 'utf8'),
    );
    await expect(
      verifyDshPhysicalPatches({
        root,
        ledger,
        workspace,
        lock,
        upstreamVersion: upstream.version,
      }),
    ).resolves.toEqual({ physicalPatchCount: 5, ledgerEntryCount: 15 });
  });
  it('supports the paired migration owner without counting unrelated patches or adapters', async () => {
    await expect(verifyDshPhysicalPatches(await fixture())).resolves.toEqual({
      physicalPatchCount: 3,
      ledgerEntryCount: 3,
    });
  });
  it.each([
    ['missing mapping', (f) => f.ledger.physicalPatches.pop()],
    [
      'duplicate mapping',
      (f) => f.ledger.physicalPatches.push({ ...f.ledger.physicalPatches[0] }),
    ],
    [
      'conflicting ownership',
      (f) =>
        f.ledger.physicalPatches.push({
          ...f.ledger.physicalPatches[0],
          responsibilityId: 'client',
        }),
    ],
    [
      'unknown owner',
      (f) => {
        f.ledger.physicalPatches[0].responsibilityId = 'unknown';
      },
    ],
    [
      'duplicate owner ID',
      (f) => f.ledger.patches.push({ ...f.ledger.patches[0] }),
    ],
    [
      'package drift',
      (f) => {
        f.ledger.physicalPatches[0].package += '-unregistered';
      },
    ],
    [
      'version drift',
      (f) => {
        f.ledger.physicalPatches[0].version = '0.1.2';
      },
    ],
    [
      'path drift',
      (f) => {
        f.ledger.physicalPatches[0].path = f.ledger.physicalPatches[1].path;
      },
    ],
    [
      'dangling physical responsibility',
      (f) =>
        f.ledger.patches.push({
          id: 'unused',
          upstreamVersion: f.upstreamVersion,
          kind: 'upstream-source-patch',
          path: 'patches/unused.patch',
        }),
    ],
    [
      'unregistered workspace patch',
      (f) => {
        f.workspace.patchedDependencies[
          '@deepseek-ai/dsh-new@' + f.upstreamVersion
        ] = 'patches/new.patch';
      },
    ],
    [
      'unregistered lock patch',
      (f) => {
        f.lock.patchedDependencies[
          '@deepseek-ai/dsh-new@' + f.upstreamVersion
        ] = { path: 'patches/new.patch', hash: '0'.repeat(64) };
      },
    ],
    [
      'digest drift',
      (f) => {
        f.lock.patchedDependencies[
          Object.keys(f.lock.patchedDependencies)[1]
        ].hash = '0'.repeat(64);
      },
    ],
  ])('refuses %s', async (_name, mutate) => {
    const f = await fixture();
    mutate(f);
    await expect(verifyDshPhysicalPatches(f)).rejects.toThrow(
      'DSH physical patch:',
    );
  });
  it('refuses actual file byte changes and leftover DSH patch files', async () => {
    const f = await fixture();
    await writeFile(
      join(f.root, f.ledger.physicalPatches[0].path),
      'changed bytes',
    );
    await expect(verifyDshPhysicalPatches(f)).rejects.toThrow(
      'physical bytes do not match',
    );
    const other = await fixture();
    await writeFile(
      join(other.root, 'patches/@deepseek-ai__dsh-orphan@0.1.2.patch'),
      'orphan',
    );
    await expect(verifyDshPhysicalPatches(other)).rejects.toThrow(
      'files inventory differs',
    );
  });
});
