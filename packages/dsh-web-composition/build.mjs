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
/** Bundle one AllRice contribution against the native public module table.
 * @param {string} entry
 */
async function contribution(entry) {
  const result = await build({
    entryPoints: [new URL(entry, import.meta.url).pathname],
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
  const css = result.outputFiles.find((file) =>
    file.path.endsWith('.css'),
  )?.text;
  if (!js || !css)
    throw new Error('Employee contribution bundle missing: ' + entry);
  if (
    Object.keys(result.metafile.inputs).some((path) =>
      /\/(?:@shikijs\/|shiki\/|katex\/)|\.(?:woff2?|ttf)$/.test(path),
    )
  )
    throw new Error('Native shared markdown/font code was bundled: ' + entry);
  return { js, css };
}
const sidebar = await contribution('./src/employee-sidebar.tsx');
const settings = await contribution('./src/employee-settings.tsx');
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
${sidebar.js}
      return module.exports;
    })();
    const settings = (() => {
      const module = { exports: {} };
      const exports = module.exports;
${settings.js}
      return module.exports;
    })();
    const baseApply = exports.apply;
    exports.apply = (ctx) => {
      baseApply(ctx);
      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.allriceEmployeeSidebar = '';
        style.textContent = ${JSON.stringify(sidebar.css + '\n' + settings.css)};
        document.head.append(style);
        return () => style.remove();
      });
      sidebar.apply(ctx);
      settings.apply(ctx, {
        notifications: false,
        renderLauncher: sidebar.AllRiceSettingsLauncher,
      });
    };
    exports.ChatSidebarFrame = sidebar.ChatSidebarFrame;
    exports.EmployeeSidebarView = sidebar.EmployeeSidebarView;
    exports.SidebarSettingsTrigger = sidebar.SidebarSettingsTrigger;
    exports.bindEmployeeSidebar = sidebar.bindEmployeeSidebar;
    exports.bindEmployeeSettings = settings.bindEmployeeSettings;
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
      sidebarJavaScriptBytes: Buffer.byteLength(sidebar.js),
      sidebarCssBytes: Buffer.byteLength(sidebar.css),
      settingsJavaScriptBytes: Buffer.byteLength(settings.js),
      settingsCssBytes: Buffer.byteLength(settings.css),
      compression: 'none',
    },
    null,
    2,
  ),
);
