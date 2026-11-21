import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, type Loader } from 'esbuild';
import { createLegacySidebarSnapshot } from './legacy-sidebar-baseline';

export const panelsRev2Head = '4c2e1069e087e645365100850756afe742c35e3d';
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const entry = new URL(
  './fixtures/employee-panels/baseline.tsx',
  import.meta.url,
);
const sha256 = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
export const panelsRev2Sources = {
  'enterprise-materials-panel.tsx':
    '635075ad3abc221177c20e3f700193d6d51c1a8431c0f474eb9c095eb09c8ae0',
  'workbench-files-panel.tsx':
    '879074fb28e61a436e9e064314c948016b1d322145b64220a386ee9ae72d14c5',
  'employee-memory-sidebar.tsx':
    '7f6773299dccff1824b0707ffbdc269bfd40cdc4dfc3ffa4ae3e6c2fc7c332b2',
  'employee-capabilities-panel.tsx':
    'd6a39b248f2018a11ef5789140ee1a4ab46432724e5a90dd706a74ce6edda331',
  'employee-capability-presentation.tsx':
    '8191f0d3800a05689a8950d1a3165ff31e961013667fbce461191efc9caf5981',
  'employee-skills-section.tsx':
    '38ea9dca82fc93d8536e7aa0cf45a27465c019f199bdbad788430d5602a90314',
};
const components = Object.keys(panelsRev2Sources);

/** Replay fixed rev2 app/UI/contracts source. In source-archive environments,
 * require this generator's prebuilt artifact with verified bytes and identities. */
export async function writeEmployeePanelsBaseline(
  artifacts: string,
  prepared = process.env.ALLRICE_PANELS_REV2_ARTIFACT_DIR,
) {
  const replaySources = await Promise.all(
    ['baseline.tsx', 'data.ts', 'presentation.tsx', 'presentation.css'].map(
      async (name) => ({
        name,
        sha256: sha256(
          await readFile(
            new URL('./fixtures/employee-panels/' + name, import.meta.url),
          ),
        ),
      }),
    ),
  );
  if (prepared) {
    const html = await readFile(join(prepared, 'panels-rev2.html'), 'utf8');
    const metadata = await readFile(
      join(prepared, 'panels-rev2-sources.json'),
      'utf8',
    );
    const parsed = JSON.parse(metadata);
    if (
      parsed.head !== panelsRev2Head ||
      parsed.htmlSha256 !== sha256(html) ||
      JSON.stringify(parsed.replaySources) !== JSON.stringify(replaySources) ||
      !components.every((name) =>
        parsed.sources?.some(
          (source: { path: string; sha256: string }) =>
            source.path === 'apps/web/app/chatflow/' + name &&
            source.sha256 ===
              panelsRev2Sources[name as keyof typeof panelsRev2Sources],
        ),
      )
    )
      throw Error('Prepared rev2 panels baseline identity/hash mismatch');
    await writeFile(join(artifacts, 'panels-rev2.html'), html);
    await writeFile(join(artifacts, 'panels-rev2-sources.json'), metadata);
    return pathToFileURL(join(artifacts, 'panels-rev2.html'));
  }
  const sources = new Map<string, string>();
  const readBase = (path: string) => {
    if (!sources.has(path))
      sources.set(
        path,
        execFileSync('git', ['show', `${panelsRev2Head}:${path}`], {
          cwd: repoRoot,
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024,
        }),
      );
    return sources.get(path)!;
  };
  // Seed the complete public real-component identities even when tree-shaken.
  for (const name of components) readBase('apps/web/app/chatflow/' + name);
  const snapshot = createLegacySidebarSnapshot(readBase);
  const common = {
    absWorkingDir: repoRoot,
    nodePaths: [resolve(repoRoot, 'apps/web/node_modules')],
    bundle: true,
    write: false,
    minify: true,
    outdir: join(artifacts, 'rev2-assets'),
    plugins: [{ ...snapshot, name: 'pinned-rev2-panels' }],
    loader: {
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl',
      '.svg': 'dataurl',
    } as Record<string, Loader>,
  };
  const result = await build({
    ...common,
    entryPoints: [fileURLToPath(entry)],
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const styles = [
    ...readBase('apps/web/app/layout.tsx').matchAll(
      /^import '([^']+\.css)';$/gm,
    ),
  ]
    .map((match) => `@import '${match[1]}';`)
    .join('\n');
  if (!styles) throw Error('Approved source has no global style imports');
  const globals = await build({
    ...common,
    stdin: {
      contents: styles,
      loader: 'css',
      resolveDir: resolve(repoRoot, 'apps/web/app'),
    },
  });
  const js = result.outputFiles!.find((file) =>
    file.path.endsWith('.js'),
  )!.text;
  const css = result.outputFiles!.find((file) =>
    file.path.endsWith('.css'),
  )!.text;
  // Exact rev2 .m0-before wrapper, not the illustrative Panel or its Dock.
  const wrapper =
    '.m0-before{height:100%;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}';
  const html = `<!doctype html><html lang="zh-CN" data-allrice-framework="v2"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${globals.outputFiles![0]!.text}\n${css}\n${wrapper}</style></head><body><div id="root"></div><script>${js.replaceAll('</script', '<\\/script')}</script></body></html>`;
  await writeFile(join(artifacts, 'panels-rev2.html'), html);
  await writeFile(
    join(artifacts, 'panels-rev2-sources.json'),
    JSON.stringify(
      {
        head: panelsRev2Head,
        approvedDesign: 'allrice40-panels-20261121/rev2 real Before components',
        sourcePolicy:
          'Every imported app/UI/contracts source is git-show pinned; real original global styles. Same synthetic props/data, no current product alias.',
        replaySources,
        sources: [...sources].map(([path, text]) => ({
          path,
          sha256: sha256(text),
        })),
        htmlSha256: sha256(html),
      },
      null,
      2,
    ),
  );
  return pathToFileURL(join(artifacts, 'panels-rev2.html'));
}
