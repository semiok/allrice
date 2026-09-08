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
  signing: 'ad-hoc; not notarized',
  credentialsEmbedded: false,
  sandboxDefault: 'disabled',
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
    '1. 先退出旧 Bridge，保留旧文件作为回退；不要删除“应用程序支持/Rice Bridge”中的配对配置。\n' +
    '2. 解压后双击“打开 RiceBridge.command”（或 RiceBridge），原有配对和目录授权继续使用。\n' +
    '3. 这是 Dev 测试包，使用 ad-hoc 签名，尚未 Apple 公证。只从可信 AllRice Dev 页面下载；若 macOS 拦截，请先核对 release.json 和发布说明，不要关闭系统安全保护。\n' +
    '4. 普通文件功能无需安装沙箱。可双击“检查沙箱.command”检查预先安装的独立 allrice-b2 Colima VM。应用不会自动下载安装 VM、镜像或修改 Docker 默认 context。\n' +
    '5. 沙箱需管理员完成安装和服务端启用后，再双击“启用沙箱.command”；成功后重启 Bridge。设置保存在本机并绑定当前配对，不会自动授权给新租户。\n' +
    '6. 本地执行是 Mac 内的原生架构 Linux 容器，不是 SaaS 云端，也不是 macOS 宿主 Shell。必须选择工作区、员工具备权限，并在网页逐次批准。临时写入不会直接覆盖源目录。\n' +
    '7. 任一检查失败就不可执行；不回退到宿主 Shell。服务端未启用时，启用命令会报错且不会保存设置。关闭沙箱后也请重启 Bridge。\n' +
    '8. 此包不含任何租户配对凭证或模型密钥。菜单栏、自更新和正式签名安装程序不在本次 Dev 包范围。\n',
);
const zip = join(
  output,
  process.arch === 'arm64' ? 'RiceBridge-M.zip' : 'RiceBridge-Intel.zip',
);
execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', folder, zip]);
const zipSha256 = sha256(await readFile(zip));
await writeFile(`${zip}.sha256`, `${zipSha256}  ${zip.split('/').at(-1)}\n`);
console.log(JSON.stringify({ ...manifest, zip, zipSha256 }));
