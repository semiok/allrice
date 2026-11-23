import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import {
  WorkspaceAnalyzer,
  FaceModelEmitter,
  writePackageArtifacts,
} from '@deepseek-ai/dsh-typert-generator';

const here = import.meta.dirname;
const root = resolve(here, '../..');
const require = createRequire(import.meta.url);
execFileSync(
  process.execPath,
  [
    require.resolve('typescript/bin/tsc'),
    '-p',
    resolve(here, 'tsconfig.build.json'),
  ],
  { stdio: 'inherit' },
);

// rc.2 recognizes Remote identity only from a registered protocol project.
// Use unchanged published public declaration bytes as analyzer-only sources;
// never author a protocol declaration/model/descriptor or alter native runtime.
const createdScratch = mkdtempSync(join(tmpdir(), 'allrice-history-typert-'));
try {
  const scratch = realpathSync(createdScratch);
  const protocol = dirname(
    require.resolve('@deepseek-ai/dsh-typert-protocol/package.json'),
  );
  const nativeRoot = join(scratch, 'packages/dsh-native-history-source');
  const protocolRoot = join(scratch, 'packages/protocol');
  cpSync(join(here, 'src'), join(nativeRoot, 'src'), {
    recursive: true,
    filter: (path) => !path.endsWith('.test.ts'),
  });
  cpSync(join(here, 'package.json'), join(nativeRoot, 'package.json'));
  const declared = join(protocol, 'lib/types');
  const source = join(protocolRoot, 'src');
  // The eight files are the public index/type export's relative declaration
  // closure in locked rc.2. Their contents remain byte-for-byte published.
  const names = readdirSync(declared)
    .filter((name) => name.endsWith('.d.ts'))
    .sort();
  if (
    names.join(',') !==
    'index.d.ts,json-value.d.ts,owned-value.d.ts,principal.d.ts,remote-access.d.ts,remote-error.d.ts,remote-info.d.ts,types.d.ts'
  )
    throw new Error('HISTORY_PROTOCOL_DECLARATIONS_CHANGED');
  mkdirSync(source, { recursive: true });
  cpSync(join(protocol, 'package.json'), join(protocolRoot, 'package.json'));
  for (const name of names) {
    const bytes = readFileSync(join(declared, name));
    writeFileSync(join(source, name.replace(/\.d\.ts$/, '.ts')), bytes);
  }
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  symlinkSync(
    join(here, 'node_modules'),
    join(nativeRoot, 'node_modules'),
    'dir',
  );
  symlinkSync(
    dirname(dirname(protocol)),
    join(protocolRoot, 'node_modules'),
    'dir',
  );
  const config = {
    extends: join(here, 'tsconfig.json'),
    compilerOptions: {
      paths: {
        '@deepseek-ai/dsh-typert-protocol': [
          join(protocolRoot, 'src/index.ts'),
        ],
      },
    },
    include: ['src/**/*.ts'],
  };
  for (const packageRoot of [nativeRoot, protocolRoot])
    writeFileSync(join(packageRoot, 'tsconfig.json'), JSON.stringify(config));
  writeFileSync(
    join(scratch, 'tsconfig.host.json'),
    JSON.stringify({
      ...config,
      include: [],
      files: [],
      references: [{ path: nativeRoot }, { path: protocolRoot }],
    }),
  );
  const workspace = new WorkspaceAnalyzer({
    root: scratch,
    faces: ['host'],
    packages: ['@allrice/dsh-native-history-source'],
    rejectBuildOutputs: true,
  }).analyze();
  const face = workspace.faces.find((face) => face.face === 'host');
  if (!face) throw new Error('HISTORY_SOURCE_HOST_FACE_MISSING');
  const artifact = new FaceModelEmitter(face).emit(
    '@allrice/dsh-native-history-source',
  );
  if (!artifact.remote) throw new Error('HISTORY_SOURCE_REMOTE_MISSING');
  writePackageArtifacts(here, [
    { ...artifact, packageRoot: 'packages/dsh-native-history-source' },
  ]);
} finally {
  rmSync(createdScratch, { recursive: true, force: true });
}
