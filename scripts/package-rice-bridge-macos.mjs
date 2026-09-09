/** Public, credential-free native macOS Dev distribution. No signing-identity claims. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';

assert.equal(process.platform, 'darwin');
assert.ok(['arm64', 'x64'].includes(process.arch));
const output = resolve(process.argv[2] ?? '');
assert.ok(
  process.argv[2] && output !== process.cwd(),
  'Provide a new output directory',
);
await mkdir(output, { mode: 0o700 }); // Never replace an earlier release.
const folder = join(output, 'RiceBridge');
await mkdir(folder);
const binary = join(folder, 'RiceBridge');
const browserLauncher = join(folder, 'RiceBrowserLauncher');
const machoArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
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
execFileSync(process.execPath, ['scripts/build-rice-bridge-sea.mjs', binary], {
  stdio: 'inherit',
  env: { ...process.env, ALLRICE_BRIDGE_PUBLIC_BUILD: '1' },
});
const version = execFileSync(binary, ['--version'], {
  encoding: 'utf8',
}).trim();
assert.match(version, /^\d+\.\d+\.\d+-dev\.\d+$/);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = {
  version,
  platform: `macos-${process.arch}`,
  builtAt: new Date().toISOString(),
  nodeVersion: process.version,
  sourceArchiveSha256: process.env.ALLRICE_BRIDGE_SOURCE_ARCHIVE_SHA256 ?? null,
  binarySha256: sha256(await readFile(binary)),
  browserLauncherSha256: sha256(await readFile(browserLauncher)),
  browserRuntimeManifestSha256: sha256(
    await readFile(`${binary}.runtime/manifest.json`),
  ),
  signing: 'ad-hoc; not notarized',
  credentialsEmbedded: false,
  sandboxDefault: 'disabled',
  browserDefault:
    'disabled; independent native Chromium sandbox; no personal profile',
  previewDefault:
    'disabled; approved live container HTTP service only; no host port or public URL',
};
await writeFile(
  join(folder, 'release.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
for (const [name, action] of [
  ['打开 RiceBridge.command', ''],
  ['检查沙箱.command', 'sandbox status'],
  ['启用沙箱.command', 'sandbox enable'],
  ['关闭沙箱.command', 'sandbox disable'],
  ['启用独立浏览器.command', 'browser enable'],
  ['关闭独立浏览器.command', 'browser disable'],
  ['启用项目预览.command', 'preview enable'],
  ['关闭项目预览.command', 'preview disable'],
]) {
  const path = join(folder, name);
  await writeFile(
    path,
    '#!/bin/sh\ncd -- "$(dirname -- "$0")" || exit 1\n./RiceBridge ' +
      action +
      '\nresult=$?\nprintf "\\n按回车关闭此窗口…"\nread -r answer\nexit "$result"\n',
  );
  await chmod(path, 0o755);
}
await writeFile(
  join(folder, '升级与沙箱说明.txt'),
  `Rice Bridge ${version} · ${process.arch}\n\n` +
    'B5 项目预览默认关闭，需先启用受控浏览器与独立沙箱，再执行 preview enable。只预览当前 Run 已批准的活动 HTTP 服务，不开放本机端口或公共网址，不支持 WebSocket/热更新、上传下载或保留项目登录资料。preview disable 可随时关闭，不自动重启旧服务。\n\n' +
    '1. 先退出旧 Bridge，保留旧文件作为回退；不要删除“应用程序支持/Rice Bridge”中的配对配置。\n' +
    '2. 解压后双击“打开 RiceBridge.command”（或 RiceBridge），原有配对和目录授权继续使用。\n' +
    '3. 这是 Dev 测试包，使用 ad-hoc 签名，尚未 Apple 公证。只从可信 AllRice Dev 页面下载；若 macOS 拦截，请先核对 release.json 和发布说明，不要关闭系统安全保护。\n' +
    '4. 普通文件功能无需安装沙箱。可双击“检查沙箱.command”检查预先安装的独立 allrice-b2 Colima VM。应用不会自动下载安装 VM、镜像或修改 Docker 默认 context。\n' +
    '5. 沙箱需管理员完成安装和服务端启用后，再双击“启用沙箱.command”；成功后重启 Bridge。设置保存在本机并绑定当前配对，不会自动授权给新租户。\n' +
    '6. 本地执行是 Mac 内的原生架构 Linux 容器，不是 SaaS 云端，也不是 macOS 宿主 Shell。必须选择工作区、员工具备权限，并在网页逐次批准。临时写入不会直接覆盖源目录。\n' +
    '7. 任一检查失败就不可执行；不回退到宿主 Shell。服务端未启用时，启用命令会报错且不会保存设置。关闭沙箱后也请重启 Bridge。\n' +
    '8. 独立浏览器默认关闭，可显式执行 browser enable（或双击对应命令文件）；重启 Bridge 后仍需网页站点授权和员工具备工具权限，不会自动控制浏览器。它使用本机已安装的受信任 Chrome、独立 Profile 和 Chromium 沙箱，不使用个人浏览器 Profile，也不是 Linux VM。\n' +
    '9. 关闭独立浏览器后请重启 Bridge；删除保留的登录状态需在网页撤销授权并等待本机清理确认。包内 RiceBrowserLauncher 和 RiceBridge.runtime 必须完整保留；资源缺失、被篡改或校验失败会拒绝运行。不会自动下载 Chrome。\n' +
    '10. 此包不含任何租户配对凭证或模型密钥。这是独立命令包，菜单栏 App 为另一分发入口；不含自更新和正式签名安装程序。\n',
);
const zip = join(
  output,
  process.arch === 'arm64' ? 'RiceBridge-M.zip' : 'RiceBridge-Intel.zip',
);
execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', folder, zip]);
const zipSha256 = sha256(await readFile(zip));
await writeFile(`${zip}.sha256`, `${zipSha256}  ${zip.split('/').at(-1)}\n`);
console.log(JSON.stringify({ ...manifest, zip, zipSha256 }));
