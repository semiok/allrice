# Rice Bridge（AllRice 助手）

## 名称与下载（MET-214）

- 用户看到的名字是「AllRice 助手」：访达、Dock、启动台、显示简介、配对和报错弹窗、网页下载按钮和说明。电脑顶部菜单栏只显示「AllRice」（状态栏文字和 `CFBundleName`）。
- 磁盘上的 `Rice Bridge.app`、应用标识 `xyz.bplabs.rice-bridge`、内部程序名（RiceBridgeApp、RiceBridgeCore）、接口路径 `/api/v1/bridge…`、Application Support 和 Keychain 用到的名字、更新安装目录 `~/Applications/AllRice Bridge` 都不变，已配对的设备不用重新配对。新配对设备的默认名是「电脑名 · AllRice 助手」。
- 显示名靠 `Info.plist` 的 `LSHasLocalizedDisplayName` 加 `macos/zh-Hans.lproj`、`macos/en.lproj` 里的 `InfoPlist.strings` 实现。`Info.plist` 里的 `CFBundleDisplayName` 必须等于文件名 `Rice Bridge`，否则访达改回显示文件名；用户手动改了 `.app` 文件名时也显示文件名。中文和英文系统都显示「AllRice 助手」。
- 只出 Apple 芯片版：`node scripts/package-rice-bridge-app-macos.mjs NEW_OUTPUT_DIRECTORY` 产出 `AllRice-Assistant.zip` 和 `release.json`（`zip` 字段同名）。Web 用 `ALLRICE_BRIDGE_MACOS_ARM64_PATH` 指向这个 zip，下载文件名是 `AllRice-Assistant.zip`；Intel 下载接口已删除。

## 2.0 B5 候选：独立浏览器与本地项目预览

`0.5.0-dev.1` 为 B5 Dev 候选，源码与候选包不代表已部署；实际发布以执行总表和下载清单为准。保留 v0.2 文件能力和已有配对，新权限默认关闭。

- `browser status|enable|disable`：本机显式同意后，仍需网页授予精确站点及员工新 Run 冻结工具。独立 Chromium 原生沙箱，不是个人 Chrome，也不是 Linux VM。默认不保存登录；显式保留的是本机私有未加密状态文件，不是 Keychain。撤销需等待设备实际清理。
- `preview status|enable|disable`：须同时具备浏览器与受控 VM，另行同意预览当前 Run 已批准的活动 HTTP 服务。菜单切换先停止本地任务；关闭/断连/服务到期不重启旧任务。
- 预览只在固定容器内转发 HTTP，不发布宿主端口、不产生公网隧道、不继承 SaaS 身份。第一版不支持 WebSocket/热更新、文件上传下载、Cookie 登录或 Service Worker；页面是独立浏览器截图与受控操作，不向 SaaS 页面注入项目 HTML。
- 固定的 `RiceBrowserLauncher` 与版本锁定的 Playwright 运行资源必须随包保留。无自动下载安装 Chrome/VM，无宿主 Shell，无第二个 Agent Loop。

详见 [P22 端侧边界](../../docs/architecture/allrice-2.0/p22-local-browser-runner.md) 与 [P23 权威](../../docs/architecture/allrice-2.0/p23-local-preview-authority.md)。

## 2.0 P13 菜单栏 Dev 宿主

新增原生 `Rice Bridge.app`：菜单提供图形化配对、工作区选择、暂停并停止本地任务、恢复、有限诊断日志、撤销与安全退出；不再要求长期保持终端窗口。Swift/AppKit 仅负责界面及随包子进程，网络、凭证、授权、journal 和实际执行继续复用同一个 TypeScript core。

已有配对沿用原 Application Support 路径和 Keychain 服务，不复制或删除旧 journal。首次迁移前请正常退出旧终端版；新 CLI 和菜单栏版共享排他锁，不能同时运行。`status`、`sandbox status` 仍可只读查看；修改配对/授权/沙箱的 CLI 命令需先退出另一实例。新 core 的单实例锁需要 Node 22.13+，SEA 包自带对应运行时。

暂停会停止本地任务并保留执行证据、未回传结果；不会回滚已发生的文件修改，也不会在恢复时自动重启旧服务。退出等待实际停止，宿主失联走同一清理路径。不提供任意 Shell、公开管理端口或新的执行权限。

退出时，状态和诊断会记录前台任务、浏览器、环境准备、心跳、文件夹监听、本地服务、沙箱、回执及执行日志的收尾阶段。收尾期间仍可读取状态和诊断，其他修改请求会被拒绝；重复退出只观察同一次收尾，不重复执行或重置计时。菜单栏单次等待上限为 60 秒：这是界面恢复边界，覆盖正常 30 秒 VM 停止和浏览器、网络收尾的余量，**不是工具任务时限，也不代表所有任务都能在 60 秒内确认停止**。超过边界不释放日志锁、不假报成功，也不自动杀进程；菜单恢复操作入口，原收尾继续等待真实完成。

「退出恢复…」可继续等待，或由用户明确选择「强制退出并保留记录」。后者只终止本宿主持有的 Core，3 秒未退出时才升级为强制终止，并等待实际进程退出；不杀全局同名进程、不撤销配对、不删除 journal、不宣称沙箱或工具已停止。重新启动仍走原有恢复与对账。Core 不回应时，诊断在 2 秒后退回带状态年龄的宿主缓存快照，明确标记不可视为当前停止确认。原生故障注入验收入口为 `python3 scripts/acceptance/runtime/bridge-quit-recovery.py /path/to/Rice\ Bridge.app`，使用隔离 bundle 与合成 Core；真实 Core 退出另由 `bridge-desktop-core.mjs` 验证。

旧命令包打包入口保留。菜单栏 `.app` 采用独立入口 `node scripts/package-rice-bridge-app-macos.mjs NEW_OUTPUT_DIRECTORY`（只出 Apple 芯片版）；仍为 ad-hoc Dev 包，**没有 Developer ID、公证或自动更新承诺**。完整边界、原生界面和两架构验收记录见 [P13 说明](../../docs/architecture/allrice-2.0/p13-desktop-bridge.md)。

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

1. 登录当前租户的 AllRice，打开「设置 → 我的电脑」。
2. 点击“生成配对码”。
3. 下载 AllRice 助手（Apple 芯片）并解压，打开“AllRice 助手”。
4. 在菜单栏「AllRice」里选择“配对设备…”，输入网页显示的 8 位配对码。
5. 配对成功后保持 AllRice 助手运行，再回到网页选择文件夹。

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
