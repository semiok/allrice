import { Buffer } from 'node:buffer';
import process from 'node:process';
import { URL } from 'node:url';
/** Independent source-to-production mapping for the registered pure probe.
 * This is build tooling, never an installation/model-supplied attestation. */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
export function prepareMaintenanceSourceProof(root) {
  const require = createRequire(join(root, 'package.json'));
  const ts = require('typescript');
  const sha = (x) => 'sha256:' + createHash('sha256').update(x).digest('hex');
  const sourcePath = 'packages/project-runtime/src/command-output.ts';
  const outputPath = 'packages/project-runtime/dist/command-output.js';
  const loaded = ts.readConfigFile(
    join(root, 'packages/project-runtime/tsconfig.build.json'),
    ts.sys.readFile,
  );
  if (loaded.error || ts.version !== '5.9.3')
    throw Error('MAINTENANCE_COMPILER_CHANGED');
  const config = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    join(root, 'packages/project-runtime'),
  );
  if (config.errors.length) throw Error('MAINTENANCE_COMPILER_CONFIG');
  const source = readFileSync(join(root, sourcePath));
  const syntax = ts.createSourceFile(
    sourcePath,
    source.toString('utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  if (
    syntax.statements.some(
      (s) =>
        ts.isExportDeclaration(s) ||
        (ts.isImportDeclaration(s) &&
          (!ts.isStringLiteral(s.moduleSpecifier) ||
            s.moduleSpecifier.text !== 'node:string_decoder' ||
            s.importClause?.name ||
            !s.importClause?.namedBindings ||
            !ts.isNamedImports(s.importClause.namedBindings) ||
            s.importClause.namedBindings.elements.length !== 1 ||
            s.importClause.namedBindings.elements[0].name.text !==
              'StringDecoder' ||
            s.importClause.namedBindings.elements[0].propertyName)),
    )
  )
    throw Error('MAINTENANCE_PURE_MODULE_CHANGED');
  const result = ts.transpileModule(source.toString('utf8'), {
    fileName: join(root, sourcePath),
    compilerOptions: {
      ...config.options,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
    reportDiagnostics: true,
  });
  const output = readFileSync(join(root, outputPath));
  if (
    result.diagnostics?.length ||
    !Buffer.from(result.outputText).equals(output)
  )
    throw Error('MAINTENANCE_SOURCE_DIST_MISMATCH');
  let sourceTree = null;
  try {
    // A dirty development build has no source attestation. The immutable
    // operator release repeats this inexpensive mapping after checkout.
    const dirty = execFileSync('git', ['diff', 'HEAD', '--name-only'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!dirty.trim())
      sourceTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
  } catch {
    /* Images without Git remain unconfirmed, rather than guessing. */
  }
  const configuration = [
    'tsconfig.base.json',
    'packages/project-runtime/tsconfig.json',
    'packages/project-runtime/tsconfig.build.json',
    'packages/project-runtime/package.json',
  ].map((path) => ({ path, checksum: sha(readFileSync(join(root, path))) }));
  const exportEntryPath = 'packages/project-runtime/dist/index.js';
  const proof = {
    version: 1,
    specId: 'command-output.credentials.v2',
    sourceTree,
    sourcePath,
    sourceChecksum: sha(source),
    outputPath,
    outputChecksum: sha(output),
    exportEntryPath,
    exportEntryChecksum: sha(readFileSync(join(root, exportEntryPath))),
    compilerVersion: ts.version,
    compilerChecksum: sha(readFileSync(require.resolve('typescript'))),
    configuration,
    sourceIndependentlyCompiled: true,
  };
  writeFileSync(
    join(root, 'apps/worker/dist/maintenance-source-proof.json'),
    JSON.stringify(proof, null, 2) + '\n',
  );
  return proof;
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  prepareMaintenanceSourceProof(
    fileURLToPath(new URL('../../../', import.meta.url)),
  );
