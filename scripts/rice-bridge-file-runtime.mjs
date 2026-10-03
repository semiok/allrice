import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export async function prepareFileGuardian(
  output,
  projectRoot = process.cwd(),
  architecture = process.env.ALLRICE_BRIDGE_APP_ARCH ?? process.arch,
) {
  if (!['x64', 'arm64'].includes(architecture))
    throw Error('FILE_PLATFORM_UNSUPPORTED');
  const guardian = resolve(output) + '.file-guardian';
  execFileSync(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-O',
      '-target',
      `${architecture === 'x64' ? 'x86_64' : 'arm64'}-apple-macosx13.0`,
      join(projectRoot, 'apps/rice-bridge/native/FileGuardian.swift'),
      '-o',
      guardian,
    ],
    { stdio: 'inherit' },
  );
  execFileSync(
    '/usr/bin/codesign',
    [
      '--force',
      '--sign',
      process.env.ALLRICE_BRIDGE_SIGNING_MODE === 'developer-id'
        ? process.env.ALLRICE_BRIDGE_SIGNING_IDENTITY
        : '-',
      ...(process.env.ALLRICE_BRIDGE_SIGNING_MODE === 'developer-id'
        ? ['--timestamp', '--options', 'runtime']
        : []),
      guardian,
    ],
    { stdio: 'inherit' },
  );
  return {
    guardian,
    sha256: createHash('sha256')
      .update(await readFile(guardian))
      .digest('hex'),
    architecture,
  };
}

/** The helper's expected bytes come from this build, never a mutable runtime manifest. */
export function fileSeaPlugin(pin) {
  return {
    name: 'allrice-fixed-file-guardian',
    setup(build) {
      build.onResolve({ filter: /file-guardian-resources\.js$/ }, () => ({
        path: 'resources',
        namespace: 'allrice-files',
      }));
      build.onLoad({ filter: /.*/, namespace: 'allrice-files' }, () => ({
        loader: 'js',
        contents: `
      const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
      exports.inspectFixedFileGuardian=()=>{
        if(!require('node:sea').isSea()||process.platform!=='darwin'||process.arch!==${JSON.stringify(pin.architecture)})throw Error('FILE_PLATFORM_UNSUPPORTED');
        const file=process.execPath+'.file-guardian',s=fs.lstatSync(file);
        if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o022)||!(s.mode&0o111)||(s.uid!==0&&s.uid!==process.getuid())||fs.realpathSync(file)!==path.resolve(file)||crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==${JSON.stringify(pin.sha256)})throw Error('FILE_GUARDIAN_INTEGRITY_FAILED');
        return file;
      };
      exports.fileGuardianReady=()=>{try{exports.inspectFixedFileGuardian();return true;}catch{return false;}};
    `,
      }));
    },
  };
}

export async function verifyFileGuardianPackage(core, expected) {
  const guardian = resolve(core) + '.file-guardian';
  const checksum = createHash('sha256')
    .update(await readFile(guardian))
    .digest('hex');
  if (checksum !== expected.sha256)
    throw Error('FILE_GUARDIAN_PACKAGE_CHANGED');
  const architectures = execFileSync('/usr/bin/lipo', ['-archs', guardian], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/);
  if (
    architectures.length !== 1 ||
    architectures[0] !== (expected.architecture === 'x64' ? 'x86_64' : 'arm64')
  )
    throw Error('FILE_GUARDIAN_ARCHITECTURE_CHANGED');
  const team =
    expected.signing?.mode === 'developer-id'
      ? [
          '-R',
          `anchor apple generic and certificate leaf[subject.OU] = "${expected.signing.teamId}"`,
        ]
      : [];
  execFileSync(
    '/usr/bin/codesign',
    ['--verify', '--strict', ...team, guardian],
    { stdio: 'ignore' },
  );
}
