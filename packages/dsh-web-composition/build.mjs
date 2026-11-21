import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

// Native client packages use this module-table artifact protocol. The body is
// only this package's CommonJS source; no upstream implementation is bundled.
const source = await readFile(
  new URL('./src/client.cjs', import.meta.url),
  'utf8',
);
const manifest = JSON.parse(
  await readFile(new URL('./package.json', import.meta.url), 'utf8'),
);
const artifact = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(manifest.name)},
  factory: () => {
    const exports = {};
${source}
    return exports;
  },
});
`;
await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
await writeFile(new URL('./dist/client.js', import.meta.url), artifact);
