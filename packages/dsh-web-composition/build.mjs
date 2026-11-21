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
// All contributions share one CSS Modules renaming graph. Independent minified
// builds can assign the same short class to unrelated components in this page.
const result = await build({
  stdin: {
    contents: `export * as sidebar from './src/employee-sidebar.tsx';
export * as settings from './src/employee-settings.tsx';
export * as panels from './src/employee-panels.tsx';`,
    resolveDir: new URL('.', import.meta.url).pathname,
    sourcefile: 'allrice-employee-contributions.ts',
    loader: 'ts',
  },
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
const js = result.outputFiles.find((file) => file.path.endsWith('.js'))?.text;
const css = result.outputFiles.find((file) => file.path.endsWith('.css'))?.text;
if (!js || !css) throw new Error('Employee contributions bundle missing');
if (
  Object.keys(result.metafile.inputs).some((path) =>
    /\/(?:@shikijs\/|shiki\/|katex\/)|\.(?:woff2?|ttf)$/.test(path),
  )
)
  throw new Error('Native shared markdown/font code was bundled');
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
    const { sidebar, settings, panels } = (() => {
      const module = { exports: {} };
      const exports = module.exports;
${js}
      return module.exports;
    })();
    const baseApply = exports.apply;
    exports.apply = (ctx) => {
      baseApply(ctx);
      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.allriceEmployeeSidebar = '';
        style.textContent = ${JSON.stringify(css)};
        document.head.append(style);
        return () => style.remove();
      });
      sidebar.apply(ctx);
      settings.apply(ctx, {
        notifications: false,
        renderLauncher: sidebar.AllRiceSettingsLauncher,
      });
      panels.apply(ctx);
    };
    exports.ChatSidebarFrame = sidebar.ChatSidebarFrame;
    exports.EmployeeSidebarView = sidebar.EmployeeSidebarView;
    exports.SidebarSettingsTrigger = sidebar.SidebarSettingsTrigger;
    exports.bindEmployeeSidebar = sidebar.bindEmployeeSidebar;
    exports.bindEmployeeSettings = settings.bindEmployeeSettings;
    exports.bindEmployeePanels = panels.bindEmployeePanels;
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
      contributionJavaScriptBytes: Buffer.byteLength(js),
      contributionCssBytes: Buffer.byteLength(css),
      cssModules: 'single shared compilation',
      compression: 'none',
    },
    null,
    2,
  ),
);
