import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Loader, type PluginBuild } from 'esbuild';
import { panelsRev2Head, panelsRev2Sources } from './employee-panels-baseline';
import { createLegacySidebarSnapshot } from './legacy-sidebar-baseline';

export const panelsReferenceCarrierId = 'pinned-rev2-public-slot-v1';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const entry = new URL(
  './fixtures/employee-panels/reference.tsx',
  import.meta.url,
);
const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const files = {
  javascript: 'panels-reference-carrier.cjs',
  components: 'panels-reference-components.css',
  globals: 'panels-reference-globals.css',
} as const;
const replaySources = {
  'baseline.tsx':
    'fab7d7e1b73e94c191ce953ebea2c55265092810ea348fc225ca26ca8b0c6b99',
  'data.ts': '8cc21dc57ad71e6659ba3dc34e1d300a27c5c44e04d8fd26e67369ed07c365a1',
  'presentation.tsx':
    '6a10adaa1f9a34f62ab24978d1d9035fea8a8e39569b2f86c9968e520ec44264',
  'presentation.css':
    'b209e1053eb534644759f918dc7728bb5bb2b3fd3ce6e970e009c67893ebd236',
};
const externals = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
  'zod',
];
// The historical TS/CSS resolver did not record JSON. The new executable pins
// this additional actual input explicitly, without rewriting old metadata.
const additionalSources: Record<string, string> = {
  'apps/web/app/dsh-upstream/upstream.json':
    '364bf6701201ec7fded9903131371d482a1affb31b6997f501f58c7bf5e70fd0',
};
const sourceMap = (values: { path: string; sha256: string }[]) => {
  if (
    !Array.isArray(values) ||
    values.some(
      (item) =>
        typeof item.path !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256),
    ) ||
    new Set(values.map((item) => item.path)).size !== values.length
  )
    throw Error('Reference source map is missing, duplicate or malformed');
  return Object.fromEntries(values.map(({ path, sha256 }) => [path, sha256]));
};
const canonical = (value: Record<string, string>) =>
  JSON.stringify(
    Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

type Rect = { x: number; y: number; width: number; height: number };
export type NativePanelsHostBudget = {
  tab: Rect | null;
  panel: Rect | null;
  available: Rect;
  clips: { rect: Rect; css: string[] }[];
  mode: string | null;
  session: string | null;
  open: boolean;
};

/** Compare only native DOM outside either component wrapper. The wrapper's
 * copied replay dimensions are deliberately not an input to this guard. */
export function compareNativePanelsHostBudget(
  actual: NativePanelsHostBudget,
  expected: NativePanelsHostBudget,
) {
  const differences: string[] = [];
  const rect = (name: string, a: Rect | null, b: Rect | null) => {
    if (!a || !b) {
      differences.push(name + ' missing');
      return;
    }
    if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0)
      differences.push(name + ' empty');
    for (const key of ['x', 'y', 'width', 'height'] as const)
      if (
        !Number.isFinite(a[key]) ||
        !Number.isFinite(b[key]) ||
        Math.abs(a[key] - b[key]) > 0.5
      )
        differences.push(name + '.' + key);
  };
  for (const key of ['mode', 'session', 'open'] as const)
    if (actual[key] !== expected[key]) differences.push(key);
  rect('native tab', actual.tab, expected.tab);
  rect('native panel', actual.panel, expected.panel);
  rect('available clip', actual.available, expected.available);
  if (actual.clips.length !== expected.clips.length)
    differences.push('native clipping ancestor count');
  actual.clips.forEach((clip, index) => {
    const other = expected.clips[index];
    if (!other) return;
    rect(`native clipping ancestor ${index}`, clip.rect, other.rect);
    if (JSON.stringify(clip.css) !== JSON.stringify(other.css))
      differences.push(`native clipping ancestor ${index} CSS`);
  });
  return differences;
}

/** Historical bytes remain a separate authority; this does not execute or
 * rewrite the old IIFE. The full 283-source map is fixed, not only six leaves. */
export function referenceAuthority(html: string, metadata: string) {
  const old = JSON.parse(metadata),
    sources = sourceMap(old.sources);
  const replay = sourceMap(
    old.replaySources.map((item: { name: string; sha256: string }) => ({
      path: item.name,
      sha256: item.sha256,
    })),
  );
  if (
    old.head !== panelsRev2Head ||
    hash(html) !==
      '695b2e17b965f778fefa68331d957f267dafa56e3d8510cb8a41d8527ca25539' ||
    old.htmlSha256 !== hash(html) ||
    hash(canonical(sources)) !==
      'f7d5800ff3c85175e07b7771b9cc7f3cdd836d4795482589e4a9958f202c183c' ||
    canonical(replay) !== canonical(replaySources)
  )
    throw Error('Historical reference authority mismatch');
  return {
    head: old.head as string,
    htmlSha256: hash(html),
    metadataSha256: hash(metadata),
    sources,
    replaySources: replay,
  };
}
type Authority = ReturnType<typeof referenceAuthority>;
type Contents = Record<keyof typeof files, string>;
type CarrierMetadata = {
  id: string;
  head: string;
  entrySha256: string;
  lockSha256: string;
  historical: { htmlSha256: string; metadataSha256: string };
  replaySources: Record<string, string>;
  sources: { path: string; sha256: string }[];
  inputs: { path: string; origin: string; sha256: string }[];
  externals: string[];
  artifacts: Record<keyof typeof files, { file: string; sha256: string }>;
  cssScope: string;
};

/** Codec checks are also used before copying prepared bytes in shallow archives. */
export function validateReferenceCarrier(
  metadata: CarrierMetadata,
  contents: Contents,
  authority: Authority,
  entrySha256: string,
  lockSha256: string,
) {
  const sources = sourceMap(metadata.sources);
  if (
    metadata.id !== panelsReferenceCarrierId ||
    metadata.head !== panelsRev2Head ||
    metadata.entrySha256 !== entrySha256 ||
    metadata.lockSha256 !== lockSha256 ||
    metadata.historical.htmlSha256 !== authority.htmlSha256 ||
    metadata.historical.metadataSha256 !== authority.metadataSha256 ||
    canonical(metadata.replaySources) !== canonical(authority.replaySources) ||
    JSON.stringify(metadata.externals) !== JSON.stringify(externals)
  )
    throw Error('Reference carrier identity mismatch');
  for (const [name, sha256] of Object.entries(panelsRev2Sources))
    if (sources['apps/web/app/chatflow/' + name] !== sha256)
      throw Error('Reference component identity mismatch');
  if (
    !sources['apps/web/app/layout.tsx'] ||
    Object.entries(sources).some(
      ([path, sha256]) =>
        (authority.sources[path] ?? additionalSources[path]) !== sha256,
    ) ||
    Object.entries(additionalSources).some(
      ([path, sha256]) => sources[path] !== sha256,
    )
  )
    throw Error('Reference source closure mismatch');
  const inputs = sourceMap(metadata.inputs);
  const badInputs = metadata.inputs.filter(
    (input) =>
      !['git-rev2', 'reference-fixture', 'locked-npm'].includes(input.origin) ||
      /src\/employee-panels\.tsx$|chatflow-client\.tsx$/.test(input.path) ||
      (input.origin === 'git-rev2' && sources[input.path] !== input.sha256) ||
      (input.origin === 'locked-npm' &&
        !input.path.includes('node_modules/')) ||
      (input.origin === 'reference-fixture' &&
        input.sha256 !==
          (input.path.endsWith('/reference.tsx')
            ? entrySha256
            : authority.replaySources[input.path.split('/').at(-1)!])),
  );
  const missingSources = Object.entries(sources).filter(
    ([path, sha256]) => inputs[path] !== sha256,
  );
  if (
    badInputs.length ||
    missingSources.length ||
    inputs[
      'packages/dsh-web-composition/tests/fixtures/employee-panels/reference.tsx'
    ] !== entrySha256
  )
    throw Error(
      'Reference input closure mismatch: ' +
        JSON.stringify({ badInputs, missingSources }),
    );
  for (const key of Object.keys(files) as (keyof typeof files)[])
    if (
      metadata.artifacts[key]?.file !== files[key] ||
      metadata.artifacts[key]?.sha256 !== hash(contents[key])
    )
      throw Error('Reference carrier artifact hash mismatch');
  return metadata;
}

/** New callable executable, separately identified from the immutable old HTML.
 * Prepared outputs are mandatory when history is unavailable; never current aliases. */
export async function writeEmployeePanelsReferenceCarrier(
  artifacts: string,
  prepared = process.env.ALLRICE_PANELS_REV2_ARTIFACT_DIR,
) {
  const authority = referenceAuthority(
    await readFile(join(artifacts, 'panels-rev2.html'), 'utf8'),
    await readFile(join(artifacts, 'panels-rev2-sources.json'), 'utf8'),
  );
  for (const [name, expected] of Object.entries(replaySources))
    if (
      hash(
        await readFile(
          new URL('./fixtures/employee-panels/' + name, import.meta.url),
        ),
      ) !== expected
    )
      throw Error('Pinned replay source changed: ' + name);
  const entrySha256 = hash(await readFile(entry)),
    lockSha256 = hash(await readFile(join(root, 'pnpm-lock.yaml')));
  let contents: Contents, metadata: CarrierMetadata;
  let preparedMetadata: string | undefined;
  if (prepared) {
    contents = Object.fromEntries(
      await Promise.all(
        Object.entries(files).map(async ([key, file]) => [
          key,
          await readFile(join(prepared, file), 'utf8'),
        ]),
      ),
    ) as Contents;
    preparedMetadata = await readFile(
      join(prepared, 'panels-reference-carrier.json'),
      'utf8',
    );
    metadata = JSON.parse(preparedMetadata);
  } else {
    const sources = new Map<string, string>();
    const readBase = (path: string) => {
      if (!sources.has(path)) {
        const text = execFileSync(
          'git',
          ['show', `${panelsRev2Head}:${path}`],
          { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
        );
        if ((authority.sources[path] ?? additionalSources[path]) !== hash(text))
          throw Error('Unpinned reference import: ' + path);
        sources.set(path, text);
      }
      return sources.get(path)!;
    };
    for (const name of Object.keys(panelsRev2Sources))
      readBase('apps/web/app/chatflow/' + name);
    const styles = [
      ...readBase('apps/web/app/layout.tsx').matchAll(
        /^import '([^']+\.css)';$/gm,
      ),
    ]
      .map((match) => `@import '${match[1]}';`)
      .join('\n');
    if (!styles) throw Error('Pinned layout has no global CSS');
    const common = {
      absWorkingDir: root,
      nodePaths: [resolve(root, 'apps/web/node_modules')],
      bundle: true,
      write: false,
      minifyIdentifiers: false,
      minifySyntax: true,
      minifyWhitespace: true,
      metafile: true,
      outdir: join(artifacts, 'reference-assets'),
      plugins: [
        {
          name: 'pinned-reference-json',
          setup(plugin: PluginBuild) {
            plugin.onLoad({ filter: /\.json$/ }, ({ path }) => {
              const key = relative(root, path).replaceAll('\\', '/');
              if (!/^(apps\/web\/|packages\/(ui|contracts)\/)/.test(key))
                return;
              return {
                contents: readBase(key),
                loader: 'json',
                resolveDir: resolve(path, '..'),
              };
            });
          },
        },
        {
          ...createLegacySidebarSnapshot(readBase),
          name: 'pinned-rev2-reference-carrier',
        },
      ],
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
      format: 'cjs',
      platform: 'browser',
      jsx: 'automatic',
      external: externals,
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    const globals = await build({
      ...common,
      stdin: {
        contents: styles,
        loader: 'css',
        resolveDir: resolve(root, 'apps/web/app'),
      },
    });
    contents = {
      javascript: result.outputFiles!.find((file) => file.path.endsWith('.js'))!
        .text,
      components:
        result.outputFiles!.find((file) => file.path.endsWith('.css'))!.text +
        '\n.m0-before{height:100%;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      globals: globals.outputFiles![0]!.text,
    };
    const inputs = await Promise.all(
      [
        ...new Set([
          ...Object.keys(result.metafile!.inputs),
          ...Object.keys(globals.metafile!.inputs),
        ]),
      ]
        .filter((path) => path !== '<stdin>')
        .map(async (path) => {
          const text = sources.get(path);
          // pnpm may resolve through this task's audited cache links. Record
          // the locked package identity, independent of the donor/worktree
          // location; the bytes below still come from the actual input file.
          const npmPath = path.indexOf('node_modules/');
          return {
            path: npmPath < 0 ? path : path.slice(npmPath),
            origin:
              text !== undefined
                ? 'git-rev2'
                : path.startsWith(
                      'packages/dsh-web-composition/tests/fixtures/employee-panels/',
                    )
                  ? 'reference-fixture'
                  : 'locked-npm',
            sha256: hash(text ?? (await readFile(resolve(root, path)))),
          };
        }),
    );
    // Seed identities are part of the verified closure even if tree-shaken.
    for (const [path, text] of sources)
      if (!inputs.some((input) => input.path === path))
        inputs.push({ path, origin: 'git-rev2', sha256: hash(text) });
    metadata = {
      id: panelsReferenceCarrierId,
      head: panelsRev2Head,
      entrySha256,
      lockSha256,
      historical: {
        htmlSha256: authority.htmlSha256,
        metadataSha256: authority.metadataSha256,
      },
      replaySources: authority.replaySources,
      sources: [...sources]
        .map(([path, text]) => ({ path, sha256: hash(text) }))
        .sort((a, b) => a.path.localeCompare(b.path, 'en')),
      inputs: inputs.sort((a, b) => a.path.localeCompare(b.path, 'en')),
      externals,
      artifacts: Object.fromEntries(
        Object.entries(files).map(([key, file]) => [
          key,
          { file, sha256: hash(contents[key as keyof Contents]) },
        ]),
      ) as CarrierMetadata['artifacts'],
      cssScope:
        'Original pinned globals apply document-wide on reference page only, before native mount; component CSS has source-qualified names. Actual page receives neither. Host geometry/paint/full frames remain evidence and original gates stay strict.',
    };
  }
  validateReferenceCarrier(
    metadata,
    contents,
    authority,
    entrySha256,
    lockSha256,
  );
  for (const [key, file] of Object.entries(files))
    await writeFile(join(artifacts, file), contents[key as keyof Contents]);
  const metadataBytes =
    preparedMetadata ?? JSON.stringify(metadata, null, 2) + '\n';
  await writeFile(
    join(artifacts, 'panels-reference-carrier.json'),
    metadataBytes,
  );
  return {
    id: panelsReferenceCarrierId,
    ...contents,
    metadata,
    metadataSha256: hash(metadataBytes),
  };
}
