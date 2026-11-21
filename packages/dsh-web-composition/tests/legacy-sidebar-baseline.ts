import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, type Loader, type Plugin } from 'esbuild';
import { createSidebarFixtureData } from './fixtures/sidebar-data.mjs';

export const sidebarBaselineHead = 'd8f6ed3fa01bdd6e5d72e55702eb703e5e670d00';
export const sidebarBaselineSources = {
  'apps/web/app/chatflow/chat-sidebar.tsx':
    '9eaf86ebb6c345340c7b3c08d8e444fa243afcf7167be3b2a66f5b412a3d8f08',
  'apps/web/app/chatflow/employee-sidebar.tsx':
    'd24037c79d951c08a2d09079cc9315a64a354b93e255017c1e46ca2b9bd31fb0',
  'apps/web/app/chatflow/sidebar-settings.tsx':
    '142c4faf51665b924437986fac17db21d1793968934fe24f5f195854c25b79d8',
};
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Preserve CSS module exports while reading the exact baseline source bytes. */
export function createLegacySidebarSnapshot(
  readBase: (path: string) => string,
): Plugin {
  return {
    name: 'pinned-allrice-sidebar-base',
    setup(plugin) {
      plugin.onLoad({ filter: /\.(?:[cm]?[jt]sx?|css)$/ }, ({ path }) => {
        const key = relative(repoRoot, path).replaceAll('\\', '/');
        if (!/^(?:apps\/web\/|packages\/(?:ui|contracts)\/)/.test(key)) return;
        return {
          contents: readBase(key),
          resolveDir: dirname(path),
          loader: path.endsWith('.module.css')
            ? 'local-css'
            : (extname(path)
                .slice(1)
                .replace(/^[cm](?=[jt]s$)/, '') as Loader),
        };
      });
    },
  };
}

/** Fail before replay if real sidebar class maps or their CSS selectors vanished. */
export function assertLegacySidebarCssClasses(html: string) {
  const js = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '';
  const css = html.match(/<style>([\s\S]*)<\/style>/)?.[1] ?? '';
  const classes: Record<string, string> = {};
  for (const key of ['sidebarCol', 'logoRow', 'employeeCard']) {
    const value = js.match(
      new RegExp(`(?:[,{])\\s*"?${key}"?\\s*:\\s*"([A-Za-z_][A-Za-z0-9_-]*)"`),
    )?.[1];
    if (
      !value ||
      !new RegExp(`\\.${value}(?![\\w-])`).test(css) ||
      !js.includes(`.${key}`)
    )
      throw new Error(`Legacy sidebar CSS module mapping missing: ${key}`);
    classes[key] = value;
  }
  return classes;
}

/** Replay the actual pre-extraction 3.x entry; never alias it to current Frame. */
export async function writeLegacySidebarBaseline(
  artifacts: string,
  prepared = process.env.ALLRICE_SIDEBAR_BASELINE_ARTIFACT_DIR,
) {
  if (prepared) {
    // Source-archive runners may receive this exact generator's credential-free
    // artifact from source preparation. Verify bytes/data/old entry identities;
    // never silently substitute current shared components when history is absent.
    const html = await readFile(
      join(prepared, 'legacy-base-entry.html'),
      'utf8',
    );
    const metadata = await readFile(
      join(prepared, 'legacy-base-sources.json'),
      'utf8',
    );
    const parsed = JSON.parse(metadata);
    const valid =
      parsed.head === sidebarBaselineHead &&
      parsed.htmlSha256 === sha256(html) &&
      parsed.fixtureDataSha256 ===
        sha256(JSON.stringify(createSidebarFixtureData())) &&
      Array.isArray(parsed.sources) &&
      Object.entries(sidebarBaselineSources).every(([path, hash]) =>
        parsed.sources.some(
          (source: { path: string; sha256: string }) =>
            source.path === path && source.sha256 === hash,
        ),
      );
    if (!valid)
      throw new Error('Prepared legacy baseline identity/hash mismatch');
    assertLegacySidebarCssClasses(html);
    await writeFile(join(artifacts, 'legacy-base-entry.html'), html);
    await writeFile(join(artifacts, 'legacy-base-sources.json'), metadata);
    return pathToFileURL(join(artifacts, 'legacy-base-entry.html')).href;
  }
  const files = new Map<string, string>();
  const readBase = (path: string) => {
    let text = files.get(path);
    if (text === undefined) {
      text = execFileSync('git', ['show', `${sidebarBaselineHead}:${path}`], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      });
      files.set(path, text);
    }
    return text;
  };
  const snapshot = createLegacySidebarSnapshot(readBase);
  const common = {
    absWorkingDir: repoRoot,
    nodePaths: [resolve(repoRoot, 'apps/web/node_modules')],
    bundle: true,
    write: false,
    minify: true,
    outdir: resolve(artifacts, 'legacy-assets'),
    plugins: [snapshot],
    loader: {
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl',
      '.svg': 'dataurl',
    } as Record<string, Loader>,
  };
  const entry = await build({
    ...common,
    entryPoints: [
      fileURLToPath(
        new URL('./fixtures/sidebar-base-entry.tsx', import.meta.url),
      ),
    ],
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const layout = readBase('apps/web/app/layout.tsx');
  const styles = [...layout.matchAll(/^import '([^']+\.css)';$/gm)]
    .map((match) => `@import '${match[1]}';`)
    .join('\n');
  if (!styles) throw new Error('Pinned base layout has no stylesheet imports');
  const globals = await build({
    ...common,
    stdin: {
      contents: styles,
      loader: 'css',
      resolveDir: resolve(repoRoot, 'apps/web/app'),
    },
  });
  const js = entry.outputFiles!.find((file) => file.path.endsWith('.js'))!.text;
  const css = entry.outputFiles!.find((file) =>
    file.path.endsWith('.css'),
  )!.text;
  const html = `<!doctype html><html lang="zh-CN" data-allrice-framework="v2"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${globals.outputFiles![0]!.text}\n${css}</style></head><body><div id="root"></div><script>${js.replaceAll('</script', '<\\/script')}</script></body></html>`;
  const cssModuleClasses = assertLegacySidebarCssClasses(html);
  const path = join(artifacts, 'legacy-base-entry.html');
  await writeFile(path, html);
  await writeFile(
    join(artifacts, 'legacy-base-sources.json'),
    JSON.stringify(
      {
        head: sidebarBaselineHead,
        entry: 'apps/web/app/chatflow/chat-sidebar.tsx',
        sourcePolicy:
          'All imported apps/web, packages/ui and packages/contracts source read using git show at this exact base; npm dependencies from pinned installed rc.2 lock context. No current Frame/View alias.',
        fixtureDataSha256: sha256(JSON.stringify(createSidebarFixtureData())),
        sources: [...files].map(([path, contents]) => ({
          path,
          sha256: sha256(contents),
        })),
        htmlSha256: sha256(html),
        cssModuleClasses,
      },
      null,
      2,
    ),
  );
  return pathToFileURL(path).href;
}
