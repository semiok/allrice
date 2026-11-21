import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { createBrowserArtifacts } from './browser-artifacts';
import { createSidebarFixtureData } from './fixtures/sidebar-data.mjs';
import {
  sidebarBaselineHead,
  sidebarBaselineSources,
  createLegacySidebarSnapshot,
  assertLegacySidebarCssClasses,
  writeLegacySidebarBaseline,
} from './legacy-sidebar-baseline';

it('keeps default first-failure evidence after credential-root cleanup', async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), 'allrice-credential-test-'));
  const evidence = await createBrowserArtifacts(undefined);
  try {
    expect(relative(hostRoot, evidence).startsWith('..')).toBe(true);
    await writeFile(join(hostRoot, 'synthetic-token'), 'delete me');
    await writeFile(join(evidence, 'first-failure.json'), '{"original":true}');
    await rm(hostRoot, { recursive: true, force: true });
    expect(await readFile(join(evidence, 'first-failure.json'), 'utf8')).toBe(
      '{"original":true}',
    );
  } finally {
    await rm(hostRoot, { recursive: true, force: true });
    await rm(evidence, { recursive: true, force: true });
  }
});

it('rejects changed prepared baseline bytes or a current-entry identity before any browser opens', async () => {
  const prepared = await createBrowserArtifacts(),
    output = await createBrowserArtifacts();
  const hash = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  // Synthetic HTML exercises artifact validation only; it is never passed to a
  // visual test or represented as the real baseline generated from git show.
  const html =
    '<!doctype html><p>artifact codec fixture</p><style>.frame{}.logo{}.card{}</style><script>var f={sidebarCol:"frame"},s={logoRow:"logo"},e={employeeCard:"card"};console.log(f.sidebarCol,s.logoRow,e.employeeCard)</script>';
  const metadata = {
    head: sidebarBaselineHead,
    htmlSha256: hash(html),
    replayEntrySha256: hash(
      await readFile(
        new URL('./fixtures/sidebar-base-entry.tsx', import.meta.url),
        'utf8',
      ),
    ),
    fixtureDataSha256: hash(JSON.stringify(createSidebarFixtureData())),
    sources: Object.entries(sidebarBaselineSources).map(([path, sha256]) => ({
      path,
      sha256,
    })),
  };
  try {
    await writeFile(join(prepared, 'legacy-base-entry.html'), html);
    await writeFile(
      join(prepared, 'legacy-base-sources.json'),
      JSON.stringify(metadata),
    );
    await writeLegacySidebarBaseline(output, prepared);
    expect(await readFile(join(output, 'legacy-base-entry.html'), 'utf8')).toBe(
      html,
    );
    const replayHash = metadata.replayEntrySha256;
    metadata.replayEntrySha256 = 'stale-replay-entry';
    await writeFile(
      join(prepared, 'legacy-base-sources.json'),
      JSON.stringify(metadata),
    );
    await expect(writeLegacySidebarBaseline(output, prepared)).rejects.toThrow(
      'identity/hash mismatch',
    );
    metadata.replayEntrySha256 = replayHash;
    await writeFile(
      join(prepared, 'legacy-base-sources.json'),
      JSON.stringify(metadata),
    );
    await writeFile(
      join(prepared, 'legacy-base-entry.html'),
      html + '<!-- altered -->',
    );
    await expect(writeLegacySidebarBaseline(output, prepared)).rejects.toThrow(
      'identity/hash mismatch',
    );
    await writeFile(join(prepared, 'legacy-base-entry.html'), html);
    metadata.sources[0]!.path = 'apps/web/app/chatflow/chat-sidebar-frame.tsx';
    await writeFile(
      join(prepared, 'legacy-base-sources.json'),
      JSON.stringify(metadata),
    );
    await expect(writeLegacySidebarBaseline(output, prepared)).rejects.toThrow(
      'identity/hash mismatch',
    );
  } finally {
    await rm(prepared, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});

it('builds real sidebar CSS module exports and matches their consumed class tokens to stylesheet selectors', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const result = await build({
    stdin: {
      contents: `import f from './apps/web/app/chatflow/dsh-upstream/AppFrame.module.css';
import s from './apps/web/app/chatflow/dsh-upstream/SidebarRoot.module.css';
import e from './apps/web/app/chatflow/employee-sidebar.module.css';
console.log(f.sidebarCol,s.logoRow,e.employeeCard);`,
      resolveDir: root,
    },
    bundle: true,
    write: false,
    minify: true,
    outdir: '/fixture',
    plugins: [
      createLegacySidebarSnapshot((path) =>
        readFileSync(join(root, path), 'utf8'),
      ),
    ],
  });
  const js = result.outputFiles!.find((file) =>
    file.path.endsWith('.js'),
  )!.text;
  const css = result.outputFiles!.find((file) =>
    file.path.endsWith('.css'),
  )!.text;
  const html = `<style>${css}</style><script>${js}</script>`;
  expect(Object.keys(assertLegacySidebarCssClasses(html))).toEqual([
    'sidebarCol',
    'logoRow',
    'employeeCard',
  ]);
  expect(() =>
    assertLegacySidebarCssClasses(
      `<style>${css}</style><script>var f={},s={},e={};console.log(f.sidebarCol,s.logoRow,e.employeeCard)</script>`,
    ),
  ).toThrow('CSS module mapping missing');
});
