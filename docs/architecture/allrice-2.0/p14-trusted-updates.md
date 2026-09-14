# P14 / MET-138：可信安装更新候选与保留门禁

2026-09-14，B6。依据执行总表 v1.27 P14 / R2、MET-106 106-C、MET-107 发布治理；前置 main `57f3b5fd2acba034e9011231075c3e29b4503733`。这是候选实现与证据说明，不表示正式分发、M/Intel 实机验收、Dev/Prod 发布或 GA 完成。

## 只读就绪检查与短设计

本机为 Intel x86_64。只读 `security find-identity -v -p codesigning` 输出仅归约为数量：有效签名身份 **0**，Developer ID Application **0**；`notarytool` 可执行文件存在。没有读取、导出或打印私钥/证书内容，没有枚举公证凭据，没有解锁或修改 Keychain、ACL、TCC。工具存在不等于公证身份可用。

独立验收以下边界：发布者密钥认证、包签名与完整性、Apple Developer ID/公证、兼容读写格式、停止领取与活跃执行、实际 App 替换、启动健康确认、失败恢复。SHA-256 不是发布者认证，合成 Apple 验证端口不是正式证书成功。

信任根只通过审核后的源码 `bridgeUpdateTrust` 及包含它的 Developer ID 签名 App 固定：Team ID、Ed25519 公钥/Key ID、HTTPS origin、dev/stable channel。当前明确为 `null`；环境变量、配对 server、网页、下载元数据、用户粘贴的公钥都不能启用或替换信任根。原生菜单显示未配置，保持现有应用运行，不访问更新网络、不修改安装目录。换 key 必须保留恢复历史包所需旧 key，另行审核签名 bootstrap；没有 TOFU 或服务端自签 root 轮换。

## 实际路径

1. 原生“检查可信更新”读取固定 `${origin}/bridge/${channel}/latest.json`，严格禁重定向、凭证/查询串/跨 origin。元数据上限 32 KiB；流式包上限 256 MiB，网络 60 秒有界，不发送 Bridge token、配置或用户数据。
2. 元数据先验 Ed25519 签名再解析。签名涵盖域分离前缀和原始 JSON bytes；另有绑定版本、sequence、架构、大小、hash 的独立包签名。必须同时列出 x64/arm64 两个独立包，选择本机原生架构，无 Rosetta 回退。
3. 检查发布序列、版本、channel、有效期（最长 30 天）、最低 macOS、协议范围及凭据/日志兼容。当前协议取实际 `BridgeProtocolVersion`；凭据兼容 generation 2 表示 B4 权威来源记录读取器（不是 JSON 内 `version: 1` 的改名），SQLite journal generation 1。元数据还必须声明 `writes.credentials: 2` 和 `writes.journal: 1`：本切片不允许格式迁移，保持旧包可读。重放/降级拒绝；回滚后保留已见 sequence，不重新安装同一失败版本。
4. 用户确认精确版本后下载并验证包；同时验证当前 bootstrap App 的 Apple 发布者身份。只创建用户 `Applications/AllRice Bridge` 下的新 `0700` managed 目录及私有暂存；不接管任意已有 App，不操作系统 `/Applications`，不提权。第一次 managed 安装保留原 App，后续只替换 managed App。
5. “等待任务结束并暂停”独立于原“暂停并停止任务”。停止新的前台、后台服务、浏览器动作领取；已经发出的领取/正在执行的工作继续完成。浏览器 UI 已启用时先要求用户明确关闭；并且运行时仍检查独立浏览器的实际活动与在途 claim，避免 CLI 改 opt-in 导致遗漏。后台服务按原期限或用户明确停止收敛，不能因更新期限强杀。浏览器清理未知、执行 journal `unknownOperations > 0`、运行时停止失败均拒绝更新。仅已知完成但未发送的回执可以原样保留移交。
6. 排空成功后才写一次性 `0600` drained ticket，绑定 request ID、Core PID、原生 host PID、install/recover 动作；首次安装必须与原 handoff 的 PID 完全一致，恢复使用当前阻塞宿主的新 PID。独立 monitor 等原宿主/Core 真退出，消费 ticket，持整次 monitor OS 锁，并取得原 config 的 OS owner 锁；PID 提示不替代锁。持 owner 后再次读取浏览器/预览 opt-in，并通过原 journal API 检查已有执行日志，拒绝票据生成后另一 CLI 遗留的 unknown。不为新安装创建 journal；既有目录缺数据库、锁仍被占用、格式不识别或日志不可读均拒绝，不把损坏当空白。只有已知完成的 pending receipts 可以原样保留。旧应用正常退出后，monitor 校验并解包、验证候选，再对实际 App 目录做 rename。没有凭据搬移、token 导出、目录授权重置、后台服务重放或第二套执行账本。
7. ZIP 预检同时检查 local/central 文件名，拒绝绝对路径、`..`、重复、软链接、ZIP64、未知替代路径 extra fields、加密和过量解压。只允许普通文件/目录和有限 Unix 时间戳/UID-GID字段；系统 `ditto --norsrc` 真实 ZIP 有独立回归。解包后再次查 UID、类型、权限及链接数，再检查 Apple anchor、Developer ID certificate class、固定 Team ID、bundle ID、stapled ticket、Gatekeeper、原生架构，最后才执行候选 `--version`。
8. 新原生宿主携带随机 health ID 启动，Core 取得同一 owner，读取原有凭据/配置并初始化本地 journal/controller，再写 `ready-health`；此时前台与浏览器都不能领取工作。monitor 观察准确 ID/version 后提交 `healthy`，Core 看到提交才开放正常领取。无配对的新安装也必须完成同一 native/Core 握手，不为了更新消耗配对码。managed Core 直接以 CLI `start` 调用也要经过 pending 启动门禁与默认健康等待，不仅约束 desktop 入口；源 CLI/非 managed 旧包仍走原生命周期。
9. 候选退出或健康超时，monitor 只向本次创建的候选宿主请求 SIGTERM；等待它退出并重新取得 Core owner 后，才恢复旧实际 App 目录并重新验 Apple 身份、旧版本后启动。停止未确认不回滚。最终 health commit 抛错可能已经可见，故绝不按“丢 ACK”杀掉可能已开始工作的新版；保留状态报 `UPDATE_HEALTH_UNCONFIRMED`。
10. 进程中断遗留 prepared/pending/ready/recovering 时，普通启动阻止领取并提供恢复入口。恢复只在当前运行已停止且无 active/unknown 时可进入，不隐式调用 pause/abort。恢复对已存元数据仍验发布者签名，但允许按原已验证时间恢复过期的本地事务；不能借此安装新过期包。恢复/失败包、原配置、Keychain 来源记录、journal/outbox 保留。

`update-state.json` 通过独占临时文件、文件 sync、原子 rename、目录 sync 写入。App 包在私有子目录暂存，原 App 保留为 `rollback-<id>.app`；失败候选改名 `failed-<id>.app`。恢复操作本身可重入。没有“把旧指针改回来就是已回滚”的假成功；验收实际目录内容。保留最多 8 个下载 request 后提示管理员检查存储，不自动清理历史证据。

## 格式与离线发布工具

外层固定 `{ keyId, payload, signature }`，后二者为规范 base64；payload 为 UTF-8 JSON。无额外字段：

```json
{
  "v": 1,
  "sequence": 2,
  "version": "0.6.0-dev.1",
  "channel": "dev",
  "issuedAt": "2026-09-14T00:00:00.000Z",
  "expiresAt": "2026-09-21T00:00:00.000Z",
  "bundleId": "xyz.bplabs.rice-bridge",
  "teamId": "REALTEAMID",
  "minimumMacOS": "13.0.0",
  "protocol": { "min": 2, "max": 2 },
  "credentials": { "min": 2, "max": 2 },
  "journal": { "min": 1, "max": 1 },
  "writes": { "credentials": 2, "journal": 1 },
  "packages": []
}
```

`REALTEAMID` 只是字段示意，不能当作可用身份。`packages` 由离线工具填入两个真实包的 url/arch/bytes/sha256/signature。元数据签名 bytes 是 `AllRice Bridge update metadata v1\n` + payload 原 bytes；包签名 bytes 是 `AllRice Bridge update package v1\n` + `JSON.stringify([version, sequence, arch, bytes, sha256])`。不依赖 JSON key 排序做隐含 canonicalization。

`scripts/create-bridge-update-metadata.ts` 仅供明确获授权的发行操作者使用：参数依次为模板、明确指定的 `0600` Ed25519 私钥文件、新输出目录。模板为 `{ keyId, release, packages: { x64: "绝对ZIP路径", arm64: "绝对ZIP路径" } }`。必须已经源码预置信任根，私钥必须匹配该公钥；不搜索/导出密钥，不提供任意 key bootstrap，不上传内容。输出 `candidate.signed.json`，**不宣称 Apple 验证或自动发布**。当前 trust 未配置，调用在读取任何输入/密钥前失败。

正式构建用原 `package-rice-bridge-app-macos.mjs NEW_DIRECTORY`，另显式设置：

- `ALLRICE_BRIDGE_SIGNING_MODE=developer-id`
- `ALLRICE_BRIDGE_SIGNING_IDENTITY`：已存在的 Developer ID identity SHA-1 标识（非私钥）。
- `ALLRICE_BRIDGE_SIGNING_TEAM_ID`：已核定 Team ID。
- `ALLRICE_BRIDGE_NOTARY_PROFILE`：已由用户配置的 notarytool profile 名称。
- 架构仍用原 `ALLRICE_BRIDGE_APP_ARCH` 与官方目标 Node 输入。

配置/identity 缺失在创建输出之前失败，不降成 ad-hoc 成功。Core、BrowserLauncher、native host 从内到外 hardened runtime 签名；目前仅 Core 声明 allow-jit，不擅加 disable-library-validation/unsigned-memory。notarytool 必须返回 Accepted，staple/validate/codesign/Gatekeeper 都成功；最终 ZIP 重解压后再检 ticket/签名/Gatekeeper，避免只验打 ZIP 前目录。CFBundle 版本取同一 Core 源版本。目标平台 Node/JIT、签名内层 runtime 资源与票据经 ZIP 后保留仍必须实测，失败时修复并复测，不能自动放宽 entitlement 或系统安全设置。

## R2 失败模式与验证边界

已实现并有隔离测试覆盖：真 Ed25519 认证及篡改/错误 publisher/key/hash/架构、过期/重放/读写不兼容、流式上限、ZIP 越界/链接/重名/截断、未签名 App 被本机 Apple 工具真实拒绝、真正目录安装/健康确认/失败回退、prepared/recovering 各中断布局重入、两个安装器互斥、原 credential fixture bytes 不变、独立真实 Node child 的 owner/读取合成凭据/ready→commit→允许工作顺序、启动失败/timeout/停止未知/commit ACK 丢失、不用假 PID 绕过 owner。desktop 控制通道真实子进程测试覆盖默认 trust gate、排空/恢复、已知 pending receipt 与 unknown 的区别；原 operation HTTP/SQLite 适配器覆盖排空时已领取工作真实落盘并只执行一次。

这些不是所有产品路径都已实机成功：Apple 成功端口用合成替身；健康 child 是真实 Node 测试进程，不冒称已用 Developer ID 新旧 App 完成原生升级。中断布局测试验证真实 fs 状态机，不把它写成真实断电实验。普通 `fsync`/rename 与同 UID 私有目录检查不保证抵御同 UID 任意进程控制或恶意管理员，也不承诺跨文件系统事务、磁盘硬件断电可靠性。OS锁、ticket、元数据、安装器均不替代有效产品权限或租户审批。

保留正式门禁：真实 Developer ID/公证成功；最终 M/Intel ZIP 两台原生安装→已有 Keychain/私有文件来源读取→活跃任务排空→更新→重开健康→故障回退；用户拒绝钥匙串、过期签名/吊销、真实升级进程 SIGKILL 与恢复、磁盘满/权限失败及原生菜单视觉验收；审核后的实际公钥/Team/origin 配置与 HTTPS 发布环境；最终固定 SHA/包 hash/Dev 联合验收。未改已安装 App、日常配置或任意 Keychain 条目，不动 Prod。

## 本地验证记录（保留失败，不替代正式验收）

工作树 `.local` 报告仅是本次隔离候选证据，不上传、不发布。依赖按 frozen lockfile 安装，无依赖升级。

- 全 Bridge + signing suite 串行：`pnpm exec vitest run apps/rice-bridge/src scripts/rice-bridge-signing.test.mjs --maxWorkers=1`，**549 passed / 68 skipped**，报告 `.local/p14-bridge-serial-final-tests.json`。68 条是原有显式环境/集成门禁，未假装执行。之后最后一处 CLI 生命周期补丁及新测试以 desktop/update-quiescence/desktop-update/core-update-startup 四文件复核：**30 passed / 1 skipped**，`.local/p14-final-lifecycle-tests.json`；不把两轮相加冒称同一完整运行。
- TypeScript typecheck、Bridge 与其 contracts/browser-control 依赖构建、全部改动 JS/TS 的 ESLint、x86_64 与 arm64 Swift typecheck 通过。最后新增测试曾触发 type-import lint，按同一规范修复并重查。
- 实际 Intel SEA + AppKit 隔离烟测（没有 `--fresh`、没有测试 Keychain 写入）通过：原配置 fixture 保留、pause/resume、正常 stop/EOF、GUI/CLI 单 owner、原生宿主打开/退出/重复宿主拒绝、宿主退出后 Core owner 可重新获取。渲染图为原生初始状态视图，不冒称 AX 菜单点击、真实凭据或真实签名更新成功。
- M/Intel 开发包均使用只读复用的官方 Node 22.23.2：archive 分别匹配官方 SHA-256 `5eff7a9011895aae3f29d06f167b84a62b028a591370c7cafb59103559fd26e1` / `96dff79f4e19a78715da559ec7cac2028f4985a175ea0c3454625a269c21deb7`，已有解压 binary 与对应 archive 内 binary hash 一致。包版本沿用基线 `0.5.0-dev.1`，不冒充后续联合发布版本。两个包均是 ad-hoc，`notarization: not-performed`、`trustedUpdatesEnabled: false`；M 包只做交叉构建/静态签名检查，未在 Intel 上冒称 ARM 运行。
- 最新候选位于 `.local/p14-app-intel-handoff` / `.local/p14-app-arm-handoff`。Intel ZIP SHA-256 `3c9ebf8b3719081303c09c737cfdc22f555ef99fedeb79c8f39e394211be3d71`（41,852,842 bytes）；M ZIP `b539b461be1bacc97ef92418cd352b3ce1b10eb205089ea1b30a3020620a4a6f`（40,632,906 bytes），两个最终 ZIP 都通过实际预检。最新 Intel 原生烟测 synthetic root 为 `/private/var/folders/30/v63hjxmj0slbppng0p3fc5t40000gp/T/allrice-p13-core-pvGV68`，`native-status-view.png` 保留；这些只供本地审核，不是允许用户安装的正式更新源。
- 首次默认 Homebrew Node 构建因缺 SEA sentinel 失败，保留 `.local/p14-app-intel`，改用上述已验证官方 Node 后成功。真实系统 ditto ZIP 初次预检暴露有限 Unix extra field `0x5855`，只加入该时间戳/UID-GID字段兼容并用真实 ZIP 回归，没有放宽路径或符号链接限制。
- 实现中修复了已知完成回执上传 503 时错误把 drain 标为失败的问题，以及测试读取 child marker 存在但 bytes 尚未写完的时序问题；分别有实际 HTTP/SQLite drain 与 exact-content child 检查复核。
- 并行全量曾出现两个非新增用例失败：desktop preview fixture 连接状态 deadline；既有 `journal.test.ts` 的 result_committed 子进程用例一次预期 owner locked 却取得 journal。报告 `.local/p14-bridge-verified-tests.json` 保留。二者串行复核 **31 passed / 1 skipped**；另以 exact stdout sentinel、抢锁前后 childAlive 检查重复原 result_committed 流程 **12/12** 都拒绝 competing open。强制 GC 对照也未复现。原失败没有记录 child 当时的完整生命周期，**根因尚未确定，不能因此宣称已排除 owner 锁漏洞或将其标为已修复**；没有修改既有 journal 实现或弱化该断言。需在联合回归持续观察并在启用正式 updater 前闭合。

官方依据：[Apple 公证](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)、[notarytool/stapler 工作流](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)、[Apple JIT entitlement](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.security.cs.allow-jit)、[Node 22 SEA](https://nodejs.org/download/release/latest-jod/docs/api/single-executable-applications.html)。采用这些机制不自动证明本候选已通过真实签名和双架构验收。
