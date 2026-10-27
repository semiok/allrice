# P22：端侧独立浏览器与实际进程监督

服务端权威见 [p22-local-browser-authority.md](./p22-local-browser-authority.md)。本模块不增加 Agent 循环、Host Shell 或新的审批权威，也不默认读取个人 Chrome。

## 明确启用与隔离

- `RiceBridge browser status|enable|disable` 管理绑定当前 server/device 的持久 opt-in，默认关闭。正常菜单栏 App 读取同一设置；菜单确认由桌面控制协议提供。启用只预检现有 Chrome 和随包 launcher，不安装浏览器、不修改 TCC、Keychain 或 Chrome 权限。
- 此首版可执行端为 macOS Intel/Apple Silicon、标准安装的 Google Chrome。必须有固定的 `RiceBrowserLauncher`；不存在时拒绝，不能退回无监督的直接 Playwright 启动。CLI helper 同目录；App Core 在 Resources，helper 在同 App 的 MacOS 目录。
- 隔离使用 Chromium 自身 sandbox、全新专属进程和 CDP pipe，**不是 Linux VM/容器沙箱**。不使用 `--no-sandbox`、远程调试 TCP、任意 executable/argv 或个人 user-data-dir。
- 每 Run 新建 owned 0700 临时目录和空的外层浏览器 profile，实际工作使用新的隔离 context。HOME/TMPDIR 指向本轮临时目录；不继承用户环境凭证。浏览器密码库使用临时基础存储，不访问系统 Keychain。
- 原生 helper 固定校验 Google executable 的代码签名身份；因标准安装可含 Finder 元数据而排除资源校验。这**不是整个 Chrome bundle 所有资源都已验证**，不会修改 xattr 或权限来让检查通过。

## 网络与任务控制

- 复用 P21 的 renderer、控制 fence、观察、审批和操作账本。设备控制租约不超过 5 秒，端侧文件只是该期限的镜像，不能脱离服务端自动延长。
- 每个 CONNECT 重新解析全部 DNS 结果；任何私有/特殊/fake-IP 结果都拒绝，连接固定已授权公网 IP，Chrome 自己校验端到端 TLS/SNI。仅精确 HTTPS origin、443 端口；代理使用每进程随机认证，标准 407 challenge 不进行 DNS 或 upstream 连接。
- 默认禁止绕代理的 QUIC、WebRTC 非代理 UDP、DoH、Service Worker、WebSocket 和新窗口。普通 grant 不接受 `.preview.allrice.invalid`；P23 必须通过单独精确目标及受控 relay，不能放开全局 localhost。
- 网络预算为最多 200 tunnel、40 MiB 双向代理字节，连接超时 5 秒、空闲 30 秒。JSON 接口最多 256 KiB，截图/私有输入/文件传输另有独立限额。
- 初始控制、接管和恢复都先发布同 workspace/fence 的新截图和观察，再 ACK。START 的 `mayExecute` 只允许一次；未批准、重复 START、旧 fence 不执行。
- 请求正文的二次审批绑定每个物理请求的稳定 requestId、URL digest、method 和 body digest/bytes。不能确认网络完成时保持 unknown，不伪造 effects:none。
- Outbox 只保存投递事实：实际 I/O 前先持久化 unknown，冷启动只补交，绝不重放执行。上传只取精确操作绑定的 SaaS object；敏感输入消费后清零，不进入普通观察或错误。

## 真正关闭进程

`native/BrowserLauncher.swift` 使用 `posix_spawn` 创建 Chrome，子进程独立 PGID=childPID。监督程序只掌握自己创建的进程组，不遍历或终止其他 Chrome。

1. 校验固定参数、真实 Google executable、owned root 的 inode/owner/0700、lease 文件的 no-symlink/0600/单链接和 nonce。
2. 父 PID 消失、配对/授权失效、lease 过期或文件异常，都触发停止；SIGTERM/INT/HUP 同样触发停止请求。
3. 仅向自己创建的组发 SIGTERM，短暂宽限后必要时 SIGKILL；`waitpid` 回收真实 child，确认整个组不存在，才写私有 `stopped:true` 回执。
4. Driver 先停止 lease 镜像并等待真实进程回执，再释放 Playwright/CDP，最后只删除本次 inode 匹配的目录。`browser.isConnected() === false` 不能代替进程证明。

无法确认清理时保留目录和 `LOCAL_BROWSER_CLEANUP_PENDING`，不释放服务端 workspace、不再领取新任务。启动失败也必须区分“已确认没有存活进程”与“清理未知”，不能把 rejected startup 当作根本没启动。

## 登录资料与解除配对

- 默认不保存登录状态。用户显式允许时，仅保存本 grant 获准 origin 的 cookies/localStorage；不导入个人 Profile、IndexedDB、sessionStorage、扩展或密码库。
- 数据是 **0700/0600 受保护但未加密的私有文件**，不是 Keychain。server/device 哈希决定专属固定目录，状态再绑定 tenant scope、owner、grant/revision、logicalProfileId 和 origin。
- 每设备索引最多 128 个精确绑定；先原子写索引再写状态，防止出现已写 secret 却无清理目标。索引损坏、缺失但目录已有 profile、symlink/权限异常或绑定不符都 fail-closed。
- Grant 撤销先停止实际 context，再把对应状态写成无 secret 的 tombstone。整个配对撤销/失效时，停止实际浏览器后按该设备索引清理**所有非活动 profile**；不扫描个人 Chrome 或其他设备目录。
- 全设备清理先冻结索引，再逐条清理；中途失败不会变成成功，也不允许新状态写入。可重复检查剩余项。Core 本机 revoke 将其纳入原 `cleanupComplete`，失败保留配对诊断。
- 离线或 token 已无效时，本地清理事实不能冒充云端 ACK；服务端仍保持待清理/unknown，直到获得合法事实。旧测试临时目录不自动迁移或扩大删除范围。

## 当前测试证据与边界

- 本提交全 Bridge：375 passed、48 个显式门控用例 skipped；typecheck 和修改文件 ESLint 通过。包含私有文件/索引、控制器/outbox、真实 HTTP 传输、proxy 407 和 Core 部分清理测试。
- 独立 Intel 实际 Chrome 5/5：正常关闭、父 Node SIGKILL、lease 过期、helper 正常 SIGTERM、lease 权限异常。测试追踪自身子进程树，确认组归属和实际退出；不枚举个人进程。
- 先前无监督实现的 parent-SIGKILL 遗留故障真实复现后修复；初始 407、观察 URL、macOS `/private/var` 路径标准化失败也保留为验收记录，不能描述为一次全绿。
- 先前实际公网 HTTPS driver 组件已验证登录/上传/下载、精确正文审批、显式登录保存与撤销；监督/索引变更后的完整公网链路仍须按最终源码复验。
- 独立 SEA 实机与 ARM、正式双架构 ZIP、完整 Web/PG/Worker/Bridge/Chrome 路径由批次最终验收另行记录。真实 HTTP+PG 控制器且 renderer 合成的测试不等于实际 Chrome E2E。
- 本提交未部署 Dev/Prod，未操作真实用户凭证；正式签名、公证和可信升级仍属 P14/B6。没有这些证据不能称 GA。
