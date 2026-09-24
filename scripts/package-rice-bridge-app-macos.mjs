/** Development is the default. Developer ID mode must pass every Apple gate;
 * signing a package alone never enables the not-yet-provisioned updater. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  assertBridgeSigningAvailable,
  bridgeSigningConfiguration,
  signAndNotarizeBridge,
  verifyPackagedBridge,
} from './rice-bridge-signing.mjs';

assert.equal(process.platform, 'darwin');
assert.ok(['x64', 'arm64'].includes(process.arch));
const signingConfig = bridgeSigningConfiguration();
assertBridgeSigningAvailable(signingConfig);
const targetArch = process.env.ALLRICE_BRIDGE_APP_ARCH ?? process.arch;
assert.ok(['x64', 'arm64'].includes(targetArch));
if (targetArch !== process.arch)
  assert.ok(
    process.env.ALLRICE_BRIDGE_NODE_BINARY,
    'Cross-builds require an explicit official target-architecture Node binary',
  );
const machoArch = targetArch === 'arm64' ? 'arm64' : 'x86_64';
const nodeArchitectures = execFileSync(
  '/usr/bin/lipo',
  ['-archs', process.env.ALLRICE_BRIDGE_NODE_BINARY ?? process.execPath],
  { encoding: 'utf8' },
)
  .trim()
  .split(/\s+/);
assert.ok(
  nodeArchitectures.includes(machoArch),
  'Target Node architecture mismatch',
);
assert.ok(process.argv[2], 'Provide a new output directory');
const output = resolve(process.argv[2]);
assert.notEqual(output, process.cwd());
await mkdir(output, { mode: 0o700 });
const app = join(output, 'Rice Bridge.app');
const contents = join(app, 'Contents');
const resources = join(contents, 'Resources');
const executable = join(contents, 'MacOS', 'RiceBridgeApp');
const browserLauncher = join(contents, 'MacOS', 'RiceBrowserLauncher');
await mkdir(resources, { recursive: true });
await mkdir(join(contents, 'MacOS'));
await copyFile(
  'apps/rice-bridge/macos/Info.plist',
  join(contents, 'Info.plist'),
);
const sourceVersion = (
  await readFile('apps/rice-bridge/src/version.ts', 'utf8')
).match(/bridgeVersion = '([^']+)'/)?.[1];
assert.ok(sourceVersion, 'Bridge version is required');
execFileSync('/usr/bin/plutil', [
  '-replace',
  'CFBundleShortVersionString',
  '-string',
  sourceVersion.split('-')[0],
  join(contents, 'Info.plist'),
]);
execFileSync('/usr/bin/plutil', [
  '-replace',
  'CFBundleVersion',
  '-string',
  sourceVersion.match(/-dev\.(\d+)$/)?.[1] ?? '1',
  join(contents, 'Info.plist'),
]);
const core = join(resources, 'RiceBridgeCore');
execFileSync(process.execPath, ['scripts/build-rice-bridge-sea.mjs', core], {
  stdio: 'inherit',
  env: { ...process.env, ALLRICE_BRIDGE_PUBLIC_BUILD: '1' },
});
execFileSync(
  '/usr/bin/xcrun',
  [
    'swiftc',
    '-target',
    `${machoArch}-apple-macosx13.0`,
    'apps/rice-bridge/macos/RiceBridgeApp.swift',
    '-o',
    executable,
  ],
  { stdio: 'inherit' },
);
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', core], {
  stdio: 'inherit',
});
execFileSync(
  '/usr/bin/xcrun',
  [
    'swiftc',
    '-O',
    '-target',
    `${machoArch}-apple-macosx13.0`,
    'apps/rice-bridge/native/BrowserLauncher.swift',
    '-o',
    browserLauncher,
  ],
  { stdio: 'inherit' },
);
assert.deepEqual(
  execFileSync('/usr/bin/lipo', ['-archs', browserLauncher], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/),
  [machoArch],
);
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', browserLauncher], {
  stdio: 'inherit',
});
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], {
  stdio: 'inherit',
});
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], {
  stdio: 'inherit',
});
const signingEvidence =
  signingConfig.mode === 'developer-id'
    ? signAndNotarizeBridge(signingConfig, app, output)
    : {
        signing: 'ad-hoc; not notarized',
        notarization: 'not-performed',
        teamId: null,
      };
const version =
  targetArch === process.arch
    ? execFileSync(core, ['--version'], { encoding: 'utf8' }).trim()
    : sourceVersion;
assert.equal(version, sourceVersion);
const digest = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const manifest = {
  version,
  platform: `macos-${targetArch}`,
  runtimeVersionVerifiedOnBuildHost: targetArch === process.arch,
  builtAt: new Date().toISOString(),
  appHostSha256: await digest(executable),
  coreSha256: await digest(core),
  browserLauncherSha256: await digest(browserLauncher),
  browserRuntimeManifestSha256: await digest(`${core}.runtime/manifest.json`),
  ...signingEvidence,
  trustedUpdatesEnabled: false,
  finalArchiveVerification: 'pending',
  credentialsEmbedded: false,
  sandboxDefault: 'auto-prepare; explicit pauses preserved',
  browserDefault:
    'auto-prepare after pairing; independent native Chromium sandbox; no personal profile',
  previewDefault:
    'auto-prepare; approved live container HTTP service only; no host port or public URL',
  sourceArchiveSha256: process.env.ALLRICE_BRIDGE_SOURCE_ARCHIVE_SHA256 ?? null,
};
await writeFile(
  join(output, 'release.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
await writeFile(
  join(output, '使用说明.txt'),
  '项目预览在配对后自动准备，独立浏览器和本地沙箱实际就绪后即可使用。只预览当前任务已批准的活动 HTTP 服务，不自动发布本机端口或公共网址；服务停止或断连后失效。目前不支持 WebSocket/热更新、上传下载或保留项目登录资料。主动关闭会停止本地任务；恢复不会自动重启旧服务。\n\n' +
    'Rice Bridge 菜单栏 Dev 版\n\n请先正常退出旧 Bridge，再打开 Rice Bridge.app。已有配对与目录授权保持原位，不需要删除或复制配置。菜单提供配对、工作区选择、暂停、诊断、独立浏览器开关与退出。\n暂停会停止本地任务，不撤销已经完成的文件修改。恢复不会重启旧服务。\n配对后自动检查并准备独立浏览器、文件和项目预览；网页使用关系自动建立，无需再勾选授权。用户主动关闭过的能力保持关闭，暂停状态跨重启保留。它使用本机已安装的受信任 Chrome 和独立 Chromium 沙箱，不使用个人 Chrome Profile，也不是 Linux VM。关闭浏览器开关会先停止本地任务；登录状态是否保留由网页授权决定，删除已保留登录状态请在网页撤销该授权并等待本机清理确认。\n包内固定版本运行资源和 RiceBrowserLauncher 必须完整保留，缺失或校验失败会拒绝运行。已有独立沙箱会自动恢复，缺少固定工具链时自动下载并验证镜像。未安装本地环境时，通用计算可由云端承接；缺少 Chrome 可从菜单打开官方下载页，再重新检查。\n此包为 ad-hoc 开发签名，尚未 Apple 公证，不含自动升级；不要关闭系统安全保护。旧命令包仍是独立可用分发入口。\n',
);
const zip = join(
  output,
  `RiceBridge-App-${targetArch === 'arm64' ? 'M' : 'Intel'}.zip`,
);
if (signingConfig.mode === 'developer-id') {
  const instructions = join(output, '使用说明.txt');
  await writeFile(
    instructions,
    (await readFile(instructions, 'utf8'))
      .replace('Rice Bridge 菜单栏 Dev 版', 'Rice Bridge 已签名候选版')
      .replace(
        '此包为 ad-hoc 开发签名，尚未 Apple 公证，不含自动升级；不要关闭系统安全保护。',
        '此候选通过 Developer ID 签名与 Apple 公证；可信升级还需要预置发布者公钥、已认证的双架构元数据及实际发布授权。请从菜单检查状态，不要关闭系统安全保护。',
      ),
  );
}
execFileSync('/usr/bin/ditto', [
  '-c',
  '-k',
  '--keepParent',
  '--norsrc',
  app,
  zip,
]);
if (signingConfig.mode === 'developer-id') {
  const verification = join(output, 'final-archive-verification');
  await mkdir(verification, { mode: 0o700 });
  execFileSync('/usr/bin/ditto', ['-x', '-k', zip, verification]);
  verifyPackagedBridge(signingConfig, join(verification, 'Rice Bridge.app'));
}
const zipSha256 = await digest(zip);
manifest.finalArchiveVerification =
  signingConfig.mode === 'developer-id'
    ? 'apple-signature-ticket-gatekeeper-verified'
    : 'development-not-notarized';
await writeFile(
  join(output, 'release.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
await writeFile(`${zip}.sha256`, `${zipSha256}  ${zip.split('/').at(-1)}\n`);
console.log(JSON.stringify({ ...manifest, app, zip, zipSha256 }));
