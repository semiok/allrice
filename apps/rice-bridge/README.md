# Rice Bridge v0.2

Rice Bridge 是 AllRice 的轻量本地受控执行端。DSH 仍在 SaaS 端负责理解、规划与工具选择，Bridge 只执行 Tool Broker 已授权的结构化本地命令。

v0.2 支持 Apple Silicon（M 芯片）和 Intel 64 位 macOS，且只提供：

- `local.fs.list`
- `local.fs.search`
- `local.fs.read`
- `local.fs.write`
- `local.fs.mkdir`
- `local.git.status`
- `local.git.diff`

它不提供 Shell、文件删除、Git 写操作、本地模型或本地聊天界面。覆盖已有文件必须携带最近一次读取返回的 SHA-256，避免覆盖并发修改。

## 开发安装

```bash
git clone --branch feat/met-89-rice-bridge-v01 --single-branch \
  https://github.com/semiok/allrice.git
cd allrice
pnpm install
pnpm --filter @allrice/rice-bridge... build
pnpm --filter @allrice/rice-bridge exec rice-bridge
```

## 配对 Mac

1. 登录当前租户的 AllRice，在左下角打开“本地电脑”。
2. 点击“生成配对码”。
3. 下载对应芯片版本并解压，直接打开 `RiceBridge`。
4. 首次打开会弹出配对窗口，输入网页显示的 8 位配对码。
5. 配对成功后保持 Bridge 运行，再回到网页点击“选择工作区”。

设备令牌优先保存在 macOS Keychain；Keychain 在受限启动环境不可写时，
会回退到权限为 `0600` 的本地凭证文件。配置保存在当前用户的 Application
Support 目录。以后直接打开 `RiceBridge` 会自动连接，不再要求配对码。
执行 `./RiceBridge revoke` 撤销设备后，下一次打开会重新进入首次配对。

配置文件只记录服务地址、设备 ID 与本机授权目录映射，权限为 `0600`。

## 其他命令

```bash
rice-bridge status
rice-bridge revoke
```

## 安全边界

- Bridge 只主动请求 AllRice HTTPS API，不监听公网入站端口。
- 服务端只保存授权目录的显示名与不可逆指纹，不保存本机绝对路径。
- 所有路径经过 `realpath` 校验；目录外路径和符号链接逃逸会被拒绝。
- `.env`、SSH/AWS/GPG/Codex 凭证目录及常见密钥文件默认不可读取。
- 本地写入只允许普通 UTF-8 文本文件；采用同目录临时文件与原子替换，禁止写入 `.git`、依赖和构建产物目录。
- Git 使用 `execFile` 与固定只读参数，不经过 Shell，也不接受任意子命令。

## v0.2 传输说明

CLI 验证阶段使用带设备 Bearer 凭证的 HTTPS 心跳与短轮询。命令已经采用持久化、租约和幂等契约；DMG/菜单栏版本会在不改变命令协议的前提下切换为 outbound WSS，降低空闲轮询开销。

## 2.0 设备执行日志（默认关闭）

P03-b 新增本地 SQLite journal 与结果 Outbox，防止连接中断后重复执行；这不是 WSS、Shell 或新能力发布。需在受控环境显式启用 `ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED=1`，并装配 P03-a/P04 服务端账本和真实授权检查。Node 22.13+ / 支持 SEA 的正式运行时是新路径前置。

日志位于配置路径旁的 `config.json.operation-journal/`。不要通过删除日志解决 unknown、冲突或满额；应先核实已有操作，否则会失去防重证据。旧路径默认不变。完整状态语义、实际测试与未验证项见 [P03-b 说明](../../docs/architecture/allrice-2.0/p03b-device-journal.md)。
