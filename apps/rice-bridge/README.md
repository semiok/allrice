# Rice Bridge v0.2

## 2.0 P13 菜单栏 Dev 宿主

新增原生 `Rice Bridge.app`：菜单提供图形化配对、工作区选择、暂停并停止本地任务、恢复、有限诊断日志、撤销与安全退出；不再要求长期保持终端窗口。Swift/AppKit 仅负责界面及随包子进程，网络、凭证、授权、journal 和实际执行继续复用同一个 TypeScript core。

已有配对沿用原 Application Support 路径和 Keychain 服务，不复制或删除旧 journal。首次迁移前请正常退出旧终端版；新 CLI 和菜单栏版共享排他锁，不能同时运行。`status`、`sandbox status` 仍可只读查看；修改配对/授权/沙箱的 CLI 命令需先退出另一实例。新 core 的单实例锁需要 Node 22.13+，SEA 包自带对应运行时。

暂停会停止本地任务并保留执行证据、未回传结果；不会回滚已发生的文件修改，也不会在恢复时自动重启旧服务。退出等待实际停止，宿主失联走同一清理路径。不提供任意 Shell、公开管理端口或新的执行权限。

旧命令包打包入口保留。菜单栏 `.app` 采用独立入口 `node scripts/package-rice-bridge-app-macos.mjs NEW_OUTPUT_DIRECTORY`；仍为 ad-hoc Dev 包，**没有 Developer ID、公证或自动更新承诺**。完整边界、原生界面和两架构验收记录见 [P13 说明](../../docs/architecture/allrice-2.0/p13-desktop-bridge.md)。

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

凭证加固候选为每个新配对设备保存独立的来源记录，避免旧 Keychain 项与
文件回退串用；旧 token 文件只允许由原配对设备兼容读取，不自动迁移。
钥匙串调用有 5 秒上限；已有配对暂不可读不会被当作首次安装要求重配。
非本人或权限不安全的凭证文件会被拒绝使用，不会自动修改系统权限。
撤销后的“服务端授权失效”与“本机凭证完全清理”分别报告。
两架构已用隔离 GUI 启动验证真实 Keychain 保存、重开及清理；
旧凭证转存、默认身份无参数启动及正式签名不包含在该实测结论内。
`0.4.0-dev.2` 候选的具体发布状态、
范围、回滚限制见 [B4 凭证加固记录](../../docs/architecture/allrice-2.0/p13-credential-hardening.md)。

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

## 2.0 受控任务与文件恢复（默认关闭）

P05 增加经验证的专用 VM 中的结构化命令，P08 增加准确 Changeset 审批、逐文件应用及反向恢复。以上 v0.2 capability 列表和默认路径不变；新能力只能由新设备日志协议、服务端开关、员工冻结权限和精确审批共同启用，不是打开任意 Shell 或通用删除接口。
参见 [P05 边界与平台前置](../../docs/architecture/allrice-2.0/p05-local-command.md) 和 [P08 文件操作、未知结果与恢复](../../docs/architecture/allrice-2.0/p08-changesets.md)。新版源码存在不代表正式签名下载包或双芯片新能力已完成发布。

## 2.0 有限后台服务（默认关闭）

P09-c 在原精确审批后允许同一 Run 内启动有限后台服务，真实就绪后继续其他任务，并通过独立输入请求表单提交有限文本或 EOF。它不提供 PTY、任意 Shell、主机挂载或公开端口；容器内部就绪不代表浏览器已可访问。需要新 profile 的 `background_services` 和两端显式 `ALLRICE_LOCAL_SERVICE_ENABLED=1`，仍受既有执行/策略开关控制。Run 结束、授权消失或期限到达时停止；重启只核对旧执行，不自动继续或重放输入。详见 [P09-c 生命周期、输入协议与验证边界](../../docs/architecture/allrice-2.0/p09c-local-services.md)。
