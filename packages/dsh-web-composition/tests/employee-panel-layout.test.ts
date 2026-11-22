import { build } from 'esbuild';
import { beforeAll, expect, it } from 'vitest';

let css: string;
const modules = new Map<string, Record<string, string>>();
beforeAll(async () => {
  // Same graph/options as the real component browser fixture, without opening
  // a server/browser. Keep child and parent styles in their actual output order.
  const result = await build({
    entryPoints: ['apps/web/test/employee-panel-data-page.tsx'],
    bundle: true,
    format: 'esm',
    splitting: true,
    platform: 'browser',
    write: false,
    outdir: '/unused-employee-panel-data',
    jsx: 'automatic',
    loader: {
      '.woff2': 'dataurl',
      '.woff': 'dataurl',
      '.ttf': 'dataurl',
      '.svg': 'dataurl',
    },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  css = result.outputFiles.find((file) =>
    file.path.endsWith('/employee-panel-data-page.css'),
  )!.text;
  const js = result.outputFiles.find((file) =>
    file.path.endsWith('/employee-panel-data-page.js'),
  )!.text;
  for (const match of js.matchAll(
    /\/\/ ([^\n]+\.module\.css)\nvar \w+ = \{([^}]+)\};/g,
  )) {
    modules.set(
      match[1]!,
      Object.fromEntries(
        [...match[2]!.matchAll(/"?([\w-]+)"?: "([^"]+)"/g)].map((entry) => [
          entry[1]!,
          entry[2]!,
        ]),
      ),
    );
  }
});

const exportsOf = (file: string) => modules.get(file)!;
it('keeps the employee picker at its approved 126px when shared SelectField CSS is emitted later', () => {
  const panel = exportsOf(
    'apps/web/app/chatflow/workbench-files-panel.module.css',
  );
  const select = exportsOf('apps/web/components/select-field.module.css');
  const applicable = [
    `.${panel.scopePicker}`,
    `.${panel.toolbar} .${panel.scopePicker}`,
    `.${select.field}`,
  ];
  const widths = [
    ...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ].flatMap((match) => {
    const selector = match[1]!.trim();
    const width = match[2]!.match(/(?:^|;)\s*width:\s*([^;]+);/);
    if (!applicable.includes(selector) || !width) return [];
    return [
      {
        selector,
        value: width[1],
        specificity: selector.split('.').length - 1,
        order: match.index!,
      },
    ];
  });
  // The regression used to pass a mere "126px exists" assertion: later 100%
  // had equal specificity and won, leaving no usable search input width.
  expect(widths.some((rule) => rule.value === '100%')).toBe(true);
  const winner = widths
    .sort((a, b) => a.specificity - b.specificity || a.order - b.order)
    .at(-1);
  expect(winner?.value).toBe('126px');
});

it('keeps both panel search styles and every fixture CSS-module export mapped to the actual stylesheet', () => {
  for (const file of [
    'apps/web/components/search-field.module.css',
    'apps/web/app/chatflow/workbench-files-panel.module.css',
    'apps/web/app/chatflow/enterprise-materials-panel.module.css',
  ])
    expect(modules.has(file), file).toBe(true);
  const missing: string[] = [];
  for (const [file, exports] of modules) {
    for (const names of Object.values(exports))
      for (const name of names.split(' ')) {
        // CSS Modules also export animation/container names, not only classes.
        if (
          !css.includes('.' + name) &&
          !css.includes('@keyframes ' + name) &&
          !css.includes('container-name: ' + name)
        )
          missing.push(file + ':' + name);
      }
  }
  expect(missing).toEqual([]);
});
