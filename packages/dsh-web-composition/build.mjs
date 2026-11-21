import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
import { build } from 'esbuild';

// The fixed rc.2 Web shell supplies these public baseline module-table faces.
// Requiring them shares the native atoms/CSS and avoids another Shiki/KaTeX copy.
const baselineExternals = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
  'zod',
];
const sidebar = await build({
  entryPoints: [
    new URL('./src/employee-sidebar.tsx', import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  format: 'cjs',
  minify: true,
  platform: 'browser',
  jsx: 'automatic',
  outdir: new URL('./dist/', import.meta.url).pathname,
  external: baselineExternals,
  metafile: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: {
    '.woff': 'dataurl',
    '.woff2': 'dataurl',
    '.ttf': 'dataurl',
    '.svg': 'dataurl',
  },
});
const sidebarJs = sidebar.outputFiles.find((file) =>
  file.path.endsWith('.js'),
)?.text;
const sidebarCss = sidebar.outputFiles.find((file) =>
  file.path.endsWith('.css'),
)?.text;
if (!sidebarJs || !sidebarCss)
  throw new Error('Employee sidebar bundle missing');
if (
  Object.keys(sidebar.metafile.inputs).some((path) =>
    /\/(?:@shikijs\/|shiki\/|katex\/)|\.(?:woff2?|ttf)$/.test(path),
  )
)
  throw new Error('Native shared markdown/font code was bundled into sidebar');
const source = await readFile(
  new URL('./src/client.cjs', import.meta.url),
  'utf8',
);
const manifest = JSON.parse(
  await readFile(new URL('./package.json', import.meta.url), 'utf8'),
);
const artifact = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(manifest.name)},
  factory: (require) => {
    const exports = {};
${source}
    const sidebar = (() => {
      const module = { exports: {} };
      const exports = module.exports;
${sidebarJs}
      return module.exports;
    })();
    const baseApply = exports.apply;
    exports.apply = (ctx) => {
      baseApply(ctx);
      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.allriceEmployeeSidebar = '';
        style.textContent = ${JSON.stringify(sidebarCss)};
        document.head.append(style);
        return () => style.remove();
      });
      sidebar.apply(ctx);
    };
    exports.ChatSidebarFrame = sidebar.ChatSidebarFrame;
    exports.EmployeeSidebarView = sidebar.EmployeeSidebarView;
    exports.SidebarSettingsTrigger = sidebar.SidebarSettingsTrigger;
    exports.bindEmployeeSidebar = sidebar.bindEmployeeSidebar;
    exports.EmployeeClientNavigation = sidebar.EmployeeClientNavigation;
    return exports;
  },
});
`;
await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
await writeFile(new URL('./dist/client.js', import.meta.url), artifact);
await writeFile(
  new URL('./dist/build-stats.json', import.meta.url),
  JSON.stringify(
    {
      artifactBytes: Buffer.byteLength(artifact),
      sidebarJavaScriptBytes: Buffer.byteLength(sidebarJs),
      sidebarCssBytes: Buffer.byteLength(sidebarCss),
      compression: 'none',
    },
    null,
    2,
  ),
);
