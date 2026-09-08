# P13 / MET-128：菜单栏 Bridge 宿主

2026-09-08。B4 第一片实现；源分支 `codex/allrice-b4-integration`，固定前置基线 `b02d257b60d75243c414a87dd4ad7fcc6265a693`。本说明不代表已提交、合并、部署或向真实 Snow 启用执行权限。

## 交付与边界

追加的真实 PostgreSQL → 精确审批 → 桌面 core → 活跃 VM 任务 → 暂停/恢复回执验收与账本修复，见 [P13 补测记录](./p13-governed-desktop-acceptance.md)。该补测已通过，不改变下文 M5 AX、Keychain 与正式分发的未覆盖说明。

- 薄 Swift/AppKit `.app` 宿主，菜单栏与独立状态窗口；配对、工作区、暂停/恢复、有限诊断日志、撤销、安全退出。没有 Electron、WebView、第二套 Agent Loop 或新的运行时 npm 依赖。
- Node SEA 继续拥有 Keychain、config、HTTP/WSS、授权、Runner、SQLite journal、Outbox 和本实例有限进程管理。CLI 的实现提取到 `core.ts`，原命令包入口仍保留。
- 宿主仅用私有父子进程 stdin/stdout 管道，JSONL 白名单控制协议；没有 localhost 管理服务，更没有公网入站端口。任意命令、额外字段、协议版本不符、超长帧、重复请求均拒绝。
- AppKit 不是执行沙箱。既有 VM/container 隔离、服务端 Feature Flag、工作区授权、员工冻结权限和网页精确审批继续分别适用；本 PR 不提升权限。
- 新 `.app` 是 ad-hoc Dev 构建，尚未 Apple Developer ID 签名、公证或自动升级。P14/B6 的发布安全工作不计入 P13。
- 当前候选版本为 `0.4.0-dev.1`，仅保留构建产物；没有改 Dev 下载入口，没有操作真实 Snow 配对或授权目录。

## 用户动作的真实语义

| 动作            | 行为                                                                                     | 不会做什么                                                                        |
| --------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 配对            | 原生表单将 HTTPS origin 与 8 位 code 经私有管道交 core，复用原凭证持久化路径             | 宿主/core 配对 IPC 不把 code/token 放在启动 argv、事件或诊断，不把凭证塞进 bundle |
| 选工作区        | NSOpenPanel 返回路径，core realpath、目录校验、指纹与既有 grant API                      | 不由 UI 直接写 config，不授权包含 Bridge 状态文件的上级目录                       |
| 暂停            | 先禁止新领取，abort 本实例任务/后台服务；证据清理完成后才显示已暂停；宿主和 owner 锁保持 | 不使用 `Process.suspend()` 冻结续租；不回滚已完成写入，不删除 journal             |
| 恢复            | 重新读取当前配对/授权并 preflight，同一 journal 核对旧事实、投递未确认结果               | 不重做未知写入、不自动重启旧后台服务、不重放 stdin                                |
| 撤销            | 先停止，再由服务端确认 revoke，最后移除当前 token/config                                 | 离线/拒绝时不假报已撤销，旧 journal 和 Outbox 始终保留                            |
| 退出 / 宿主 EOF | 受控停止、有限 delivery-only 回传、保留未回传事实后关闭；AppKit 等待 core 真退出         | 不用固定几秒后的 SIGKILL 冒充安全完成，不留下隐藏常驻 agent                       |
| 诊断            | 版本、架构、连接/运行状态、数量和最多 100 条 allowlisted 事件代码                        | 不导出 device/lease token、code、完整路径、文件/命令输出或数据库副本              |

暂停时 core 不再发送设备心跳，服务端仍按原在线 TTL 过期；本 PR 没有增加服务端 pause 字段，不能宣称后台已实时区分暂停和网络离线。连接在线、选工作区、可用沙箱、获得执行权限是独立条件。

原 Keychain CLI 写入仍使用 `security add-generic-password -w token`，属于既有 argv 暴露风险；P13 不重构该安全存储接口、不宣称所有下游进程 argv 均不含 token。后续应单独评估原生安全存储 API，不能靠修改文案忽略此风险。

启动/停止抛错不能被 `halt` 覆盖成已暂停。core 回报 `DESKTOP_STOP_UNCONFIRMED` 并以非零码退出；宿主收到异常退出时不确认「安全退出成功」，保留错误提示和原证据。后台任务停止采用 settled 结果核对，不吞掉 journal/停止承诺的拒绝。

## 生命周期与数据兼容

- `BridgeInstanceLock` 用独立 0700 目录及 0600 SQLite 文件保留 OS 排他锁，覆盖新 `launch/start/desktop` 和修改配置的 CLI，包含 operation flag=0 的旧队列模式。它不是靠 PID 文件猜测；崩溃后 OS 释放，重开不删除执行证据。
- 相同 bundle 的 `NSRunningApplication` 检查只避免重复 UI；真正执行排他仍在 core。旧二进制不认识新锁，迁移需要用户先正常退出，不能按进程名扫描/盲杀。
- 已有 `BridgeConfig` 没有 `journalNamespace` 时，继续使用原 `config.json.operation-journal`。新配对写入与 device UUID 相同的 namespace，改用身份独立 journal 目录，原身份日志不改写、不删除。
- CLI `status` 和 `sandbox status` 是只读入口；其他配置修改需取得同一 owner 锁。菜单栏的授权切换会先停本地任务，再按原能力恢复。
- 新 core 的 owner 锁需要内建 `node:sqlite`（Node 22.13+）；分发包继续随 SEA 携带验证过的运行时。
- 普通 `.app` 保留 HOME，读取原 `config.json.sandbox.json` 并核对 deviceId/server；已 opt-in 时，即使没有 `ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED`，core 默认启用 operation 协议与原架构对应 Runner。未 opt-in 时继续旧文件能力。服务端 flags、冻结权限、审批和 VM preflight 仍分别决定能否执行。
- `ALLRICE_BRIDGE_WSS_ENABLED` 仍是独立 opt-in；普通 GUI 不继承该环境变量，因此默认 HTTP，不为菜单栏体验擅自开启已关闭的 WSS。HTTP 默认不等于禁用受控执行。

## 代码落点

- `apps/rice-bridge/src/core.ts`：复用的 CLI/API、生命周期、可取消等待、只读状态和原生 picker 注入。
- `desktop-controller.ts`、`desktop-protocol.ts`：有限动作、状态/诊断投影、上下游背压、EOF/退出流程。
- `instance-lock.ts`：每个配置的 OS owner 锁；独立于执行 journal 的文件描述符。
- `journal.ts` 的 `diagnosticCounts`、`local-process-manager.ts` 的只读 active count；UI 不直接持有执行对象。
- `macos/RiceBridgeApp.swift`、`Info.plist`：原生菜单、窗口、表单、目录选择与受控 core 子进程。
- `scripts/package-rice-bridge-app-macos.mjs`：新目录构建，分别核对宿主/core hash、ad-hoc 验签和 ZIP；可显式选择 ARM/Intel 目标并验证 Node Mach-O 架构。跨编译 manifest 不假报运行验证，必须到目标 Mac 执行。原 `package-rice-bridge-macos.mjs` 不改。
- `scripts/acceptance/runtime/bridge-desktop.mjs`：真实原生 UI 操作，合成身份与 loopback HTTP；明确不是 PG/真实租户验收。
- `scripts/acceptance/runtime/bridge-desktop-core.mjs`：已打包 SEA 的私有控制协议与实际 AppKit 宿主进程验证；区分原生窗口启动/退出与 Accessibility 菜单点击。

## 测试与未验证项

已验证内容（最终计数见批次证据）包括：

- 严格协议、输入白名单、错误消息不泄密；有/无横杠 code；新配对身份 namespace、凭证先落盘、失败不覆盖 config（pairing ports 测试不冒充 Keychain 实测）。
- 真实独立 CLI 子进程 + HTTP，既有配对启动、暂停 pending poll、恢复、EOF；两实例/CLI-GUI 竞争、SIGKILL 后 OS owner 重取。
- 真实 SQLite Outbox 在暂停/恢复后保留并只重传；原 tombstone 仍拦截重复 dispatch。start 前及 start ACK 后收到暂停均有 stopped 证据且不执行。
- 启动失败后暂停/退出不能假报成功；工作区与状态目录比较使用物理路径，含 symlink 配置父目录与 macOS `/var` 别名回归。
- Intel 专用 `allrice-b2` VM 的命令、有限后台服务、Changeset 回归，未使用默认 Docker context 或真实租户目录。
- Intel 原生 `.app`/SEA 构建与 ad-hoc 验签，System Events 实际点击菜单暂停/恢复、NSOpenPanel 取消、诊断弹窗、安全退出。保留旧配置，非无界 UI mock。
- Intel 原生首次配对表单输入、无横杠 code、随机合成凭证保存、在线撤销与清理；验收脚本分别记录 Keychain 或既有私有文件 fallback，不能只凭配对成功宣称 Keychain 成功。
- Swift/AppKit 宿主 Intel 与 ARM 双目标编译；M5 上已实际运行 ARM SEA 与 AppKit，而不是只做 ARM 跨编译。

### M5 隔离实测范围（2026-09-08）

仅使用 `/private/tmp/allrice-p13-m5.Kp1B28` 内的候选 `.app` 和新建的 `allrice-p13-core-*` 合成身份/config/工作区；没有读取日常 Bridge token、没有切换 AI-what、没有杀日常 Bridge。ARM 官方 Node `v22.23.2` 压缩包按官方 SHA-256 `5eff7a9011895aae3f29d06f167b84a62b028a591370c7cafb59103559fd26e1` 校验。

已通过：候选版本执行/ad-hoc 验签、已有配置兼容、新配对及身份独立 journal namespace、工作区授权、暂停期间不再轮询、暂停仍保留单实例锁、恢复、诊断不含路径/凭证、主动 stop/EOF、重复原生宿主退出、AppKit 真窗口 view render、父宿主退出后 core 释放 owner，以及新身份在线撤销。所有动作针对合成 fixture；不冒充真实租户/真实 PostgreSQL 联测。

**明确未覆盖**：M5 远程 `osascript` 被 macOS 拒绝辅助访问（`-1728`）；所以 M5 的真实点击配对表单、菜单、NSOpenPanel 和菜单安全退出未签字。不修改 TCC/辅助功能权限、不绕过系统限制。Intel 的同一套真实 Accessibility 交互已通过；不能以此替代 M5 的 UI 门禁。

最终候选的 Intel 与 M5 首次配对实测均记录 `credentialStore: private-file-fallback`：Keychain 在这些测试进程上下文中未成功使用，确实使用了原有 0600 私有 token 文件兼容路径，撤销后已移除合成凭证。**因此没有完成真实 Keychain 成功/迁移验收**，更没有将 fallback 伪称为加密存储；不擅自解锁或重配系统 Keychain。

已用每台机器新建的唯一合成账号安全复现：`security add-generic-password` 退出码 **36**，错误为 `SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.`；没有实际创建条目。不是未设置 `ALLRICE_BRIDGE_TEST_KEYCHAIN`：该变量只是测试脚本的显式清理授权 gate，产品存储逻辑不使用它。自动化/SSH 启动上下文受限，不据此推断 Finder 正常交互启动一定成功或失败。

P13 增加了只读来源投影：状态窗口明确显示 Keychain 或「Keychain 不可用，使用本机 0600 私有凭证文件（未加密）」；读取实际文件权限后才显示 0600，否则提示权限需要检查。不显示路径/token，不迁移/解锁，不更改原 fallback 策略。

### 候选构建与可追溯证据

两个包均为 `0.4.0-dev.1`，2026-09-08 构建，仅用于 Dev 候选验收，未上传或发布：

| 架构  | ZIP SHA-256                                                        | 本地目录                                                   |
| ----- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| Intel | `0aa5332c72b32c5564d8edd146a71992c361dfccba707c7fe58402bce113ab81` | `.local/p13-host-poc.CZB8en/app-intel-handoff-0.4.0-dev.1` |
| ARM   | `1cb16b68546bdf068fbf2eddcd2bfae3bfc06ebdfaedc573033a9a70f9332c11` | `.local/p13-host-poc.CZB8en/app-arm-handoff-0.4.0-dev.1`   |

- Intel 原生 AX 已有身份：`allrice-p13-ui-khT8oK/result.json`；首次配对/撤销及凭证保存来源提示：`allrice-p13-ui-AQ4AR0/result.json`。均为当次系统临时目录中的独立 fixture。
- M5 最终候选复制到 `/private/tmp/allrice-p13-m5.Kp1B28/handoff/`；已有身份 `allrice-p13-core-d0sBje/result.json`、新身份 `allrice-p13-core-t57IBE/result.json`。回传只包含测试结果/原生 view render，不包含 token/config。
- 本地保留 `.local/p13-host-poc.CZB8en/m5-handoff-existing-result.json`、`m5-handoff-fresh-result.json`、`m5-handoff-native-view.png`。view render 已人工检查文字、布局与版本，无截断；它不是 WindowServer 截图。
- 两架构实际 `.app` 均补证 `nativeSavedOptInWithoutEnvironmentFlag: true`：持久化 opt-in 在普通宿主环境白名单下仍开启 operation 协议；测试没有授予执行审批或自动开启 WSS。
- 完整 Bridge 测试 **214 passed / 0 failed / 1 skipped**（含 Intel 专用 VM 实测），结果保存在 `.local/p13-host-poc.CZB8en/bridge-p13-handoff-tests.json`；唯一外网 npm 下载测试按原 gate 跳过，不能算通过。Bridge TypeScript 检查、限定目录 ESLint、Prettier 及 Intel/ARM Swift 编译通过。
- 自审新增「配置父目录 symlink」与「启动失败不能伪报 paused/clean stop」回归；中途新测试曾误嵌套到另一个测试中，被 Vitest 报错后已修正并复测。早期 fixture 的 `/var`/`/private/var` 比较和异步 view render 等待也已修正，不将这些首次失败删去或算成功。

本机 WindowServer 截图当前无法捕获该窗口，未更改屏幕录制权限；保留真实 Accessibility 操作结果和应用自己的 view render 供人工检查，后者明确不是桌面截图。

批末尚需主代理完成：固定集成版本的 M5 原生 Accessibility 点击（需用户在系统中授权或人工验收）、最终真实 PostgreSQL+受控任务审批/运行/暂停联测、下载/发布入口与版本一致性核对。真实用户 Keychain 迁移、正式安装签名、公证、登录启动、更新回滚不由 mock 或跨编译代替。

```sh
pnpm exec vitest run apps/rice-bridge/src
pnpm --filter @allrice/rice-bridge typecheck
node scripts/package-rice-bridge-app-macos.mjs NEW_OUTPUT_DIRECTORY
node scripts/acceptance/runtime/bridge-desktop.mjs 'NEW_OUTPUT_DIRECTORY/Rice Bridge.app'
node scripts/acceptance/runtime/bridge-desktop-core.mjs 'NEW_OUTPUT_DIRECTORY/Rice Bridge.app'
node scripts/acceptance/runtime/bridge-desktop-core.mjs 'NEW_OUTPUT_DIRECTORY/Rice Bridge.app' --saved-opt-in
# 显式同意创建并清理一个随机合成 Keychain account，绝不枚举或解锁真实凭证：
ALLRICE_BRIDGE_TEST_KEYCHAIN=1 node scripts/acceptance/runtime/bridge-desktop.mjs 'NEW_OUTPUT_DIRECTORY/Rice Bridge.app' --fresh
```

## 官方选型依据

[NSStatusBar](https://developer.apple.com/documentation/appkit/nsstatusbar) 提供原生菜单栏项；其空间并非始终可用，所以同时提供状态窗口。[LSUIElement](https://developer.apple.com/documentation/bundleresources/information-property-list/lsuielement) 用于不进入 Dock 的 agent app，不是沙箱隔离。

[Foundation Process](https://developer.apple.com/documentation/foundation/process) 支持固定子进程与标准管道，子进程继承父应用沙箱边界；本设计保留既有 Runner 隔离，不把 UI 宿主当新权限边界。[terminateLater](https://developer.apple.com/documentation/appkit/nsapplication/terminatereply/terminatelater) 用于等真实停止后回复终止，而非主线程同步阻塞或立即强杀。
