/** P13 native Dev app; no Developer ID, notarization or updater claim. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

assert.equal(process.platform, 'darwin');
assert.ok(['x64', 'arm64'].includes(process.arch));
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
const sourceVersion = (
  await readFile('apps/rice-bridge/src/version.ts', 'utf8')
).match(/bridgeVersion = '([^']+)'/)?.[1];
assert.ok(sourceVersion, 'Bridge version is required');
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
  signing: 'ad-hoc; not notarized',
  credentialsEmbedded: false,
  sandboxDefault: 'disabled',
  browserDefault:
    'disabled; independent native Chromium sandbox; no personal profile',
  previewDefault:
    'disabled; approved live container HTTP service only; no host port or public URL',
  sourceArchiveSha256: process.env.ALLRICE_BRIDGE_SOURCE_ARCHIVE_SHA256 ?? null,
};
await writeFile(
  join(output, 'release.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
await writeFile(
  join(output, '使用说明.txt'),
  'B5 项目预览：菜单栏有独立开关；需先启用受控浏览器与已安装的独立沙箱。只预览当前 Run 已批准的活动 HTTP 服务，不自动发布本机端口或公共网址；服务停止或断连后失效。第一版不支持 WebSocket/热更新、上传下载或保留项目登录资料。关闭开关会先停止本地任务；恢复不会自动重启旧服务。\n\n' +
    'Rice Bridge 菜单栏 Dev 版\n\n请先正常退出旧 Bridge，再打开 Rice Bridge.app。已有配对与目录授权保持原位，不需要删除或复制配置。菜单提供配对、工作区选择、暂停、诊断、独立浏览器开关与退出。\n暂停会停止本地任务，不撤销已经完成的文件修改。恢复不会重启旧服务。\n独立浏览器默认关闭，需本机明确启用、网页站点授权和员工具备冻结的工具权限；启用开关本身不会启动浏览器或自动授权。它使用本机已安装的受信任 Chrome 和独立 Chromium 沙箱，不使用个人 Chrome Profile，也不是 Linux VM。关闭浏览器开关会先停止本地任务；登录状态是否保留由网页授权决定，删除已保留登录状态请在网页撤销该授权并等待本机清理确认。\n包内固定版本运行资源和 RiceBrowserLauncher 必须完整保留，缺失或校验失败会拒绝运行。应用不会自动安装 Chrome、VM 或镜像。\n此包为 ad-hoc 开发签名，尚未 Apple 公证，不含自动升级；不要关闭系统安全保护。旧命令包仍是独立可用分发入口。\n',
);
const zip = join(
  output,
  `RiceBridge-App-${targetArch === 'arm64' ? 'M' : 'Intel'}.zip`,
);
execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
const zipSha256 = await digest(zip);
await writeFile(`${zip}.sha256`, `${zipSha256}  ${zip.split('/').at(-1)}\n`);
console.log(JSON.stringify({ ...manifest, app, zip, zipSha256 }));
