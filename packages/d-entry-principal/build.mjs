import { createHash } from 'node:crypto';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { build } from 'esbuild';
import { WorkspaceAnalyzer, FaceModelEmitter, writePackageArtifacts } from '@deepseek-ai/dsh-typert-generator';

const root = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(root, '../..');
const lib = resolve(root, 'lib');
const require = createRequire(import.meta.url);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const dshVersion = '0.2.1-rc.2';

// A partial generation/build is never a prepared artifact: remove the old
// receipt first and only publish the new receipt after all outputs validate.
await rm(resolve(lib, 'current-principal.manifest.json'), { force: true });
await mkdir(lib, { recursive: true });
const analysis = new WorkspaceAnalyzer({
  root: workspace,
  hostConfig: 'packages/d-entry-principal/tsconfig.typert.json',
  packages: [manifest.name], faces: ['host'], checkDiagnostics: true,
}).analyze();
const host = analysis.faces.find((face) => face.face === 'host');
if (!host) throw Error('PRINCIPAL_HOST_MODEL_MISSING');
const generated = new FaceModelEmitter(host).emit(manifest.name);
if (!generated.remote) throw Error('PRINCIPAL_REMOTE_MODEL_MISSING');
writePackageArtifacts(root, [{ ...generated, packageRoot: relative(workspace, root) }]);
await writeFile(resolve(lib, 'artifacts.js'), "export { TYPERT } from './typert.host.js';\nexport { TYPERT_REMOTE } from './typert.remote-client.js';\n");
await build({ absWorkingDir: root, entryPoints: { types: 'src/types.ts', policy: 'src/policy.ts' }, outdir: 'lib', bundle: true, platform: 'node', target: 'node22', format: 'esm', external: ['@deepseek-ai/*'] });

// Source, contracts, Zod and both generated contributions are one closure.
// Only public guest DSH/Cordis exports stay external so class/service identity
// is the actual Host's identity, resolved from its trusted CLI, not this tree.
const output = await build({
  absWorkingDir: root, entryPoints: ['src/host.ts'], bundle: true,
  platform: 'node', target: 'node22', format: 'cjs', write: false,
  metafile: true, external: ['@deepseek-ai/*', 'node:*'],
  tsconfig: 'tsconfig.json',
});
const compiled = output.outputFiles[0];
if (!compiled) throw Error('PRINCIPAL_HOST_BUILD_MISSING');
const publicImports = [...new Set(Object.values(output.metafile.outputs).flatMap((file) => file.imports.filter((entry) => entry.external && !entry.path.startsWith('node:')).map((entry) => entry.path)))].sort();
const modules = [];
for (const specifier of publicImports) {
  if (!specifier.startsWith('@deepseek-ai/') || specifier.includes('/src/') || specifier.endsWith('/internal')) throw Error('PRINCIPAL_PRIVATE_IMPORT');
  const packageName = specifier.split('/').slice(0, 2).join('/');
  const version = JSON.parse(await readFile(require.resolve(`${packageName}/package.json`), 'utf8')).version;
  if ((packageName === '@deepseek-ai/cordis' && version !== '4.0.5') || (packageName.startsWith('@deepseek-ai/dsh-') && version !== dshVersion)) throw Error('PRINCIPAL_MODULE_VERSION');
  modules.push({ specifier, version, sha256: digest(await readFile(require.resolve(specifier))) });
}
const source = `import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
export const name = 'allrice-current-principal';
export const inject = ['connection', 'remoteAccess', 'typertGateway', 'typert', 'sessionController'];
const expected = ${JSON.stringify(modules)};
export async function apply(ctx, config) {
  const resolve = createRequire(config.moduleBase);
  const modules = new Map();
  for (const entry of expected) {
    const name = entry.specifier.split('/').slice(0, 2).join('/');
    const manifest = JSON.parse(await readFile(resolve.resolve(name + '/package.json'), 'utf8'));
    const path = resolve.resolve(entry.specifier);
    const hash = createHash('sha256').update(await readFile(path)).digest('hex');
    if (manifest.version !== entry.version || hash !== entry.sha256) throw Error('PRINCIPAL_GUEST_ARTIFACT_MISMATCH');
    modules.set(entry.specifier, await import(pathToFileURL(path).href));
  }
  const module = { exports: {} };
  const require = (name) => {
    if (name.startsWith('node:')) return resolve(name);
    if (!modules.has(name)) throw Error('PRINCIPAL_UNSEALED_IMPORT');
    return modules.get(name);
  };
  ((require, module, exports) => {
${compiled.text}
  })(require, module, module.exports);
  if (typeof module.exports.apply !== 'function') throw Error('PRINCIPAL_PLUGIN_MISSING');
  return module.exports.apply(ctx, config);
}
`;
await writeFile(resolve(lib, 'host.js'), source);
const declarations = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.build.json')], { stdio: 'inherit' });
if (declarations.status !== 0) throw Error('PRINCIPAL_DECLARATIONS_FAILED');
const files = [];
for (const path of ['host.js', 'types.js', 'policy.js', 'artifacts.js', 'typert.host.js', 'typert.host.d.ts', 'typert.remote-client.js', 'typert.remote-client.d.ts', 'typert.remote-client.d.ts.map', 'types/host.d.ts', 'types/types.d.ts', 'types/policy.d.ts']) {
  files.push({ path, sha256: digest(await readFile(resolve(lib, path))) });
}
await writeFile(resolve(lib, 'current-principal.manifest.json'), `${JSON.stringify({ schema: 1, package: manifest.name, version: manifest.version, dshVersion, files, modules }, null, 2)}\n`);
