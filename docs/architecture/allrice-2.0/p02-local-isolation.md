# P02：本地 OS 隔离实验与平台能力报告

归属：[MET-111 / P02](https://linear.app/metasnowsky/issue/MET-111)。输入：[共同契约](contracts.md)、[ADR-002](decisions.md)、[验收设计](acceptance.md)。本页是实验结论，不另行改变执行总表、产品权限或 GA 门禁。

**结论：Intel Mac 上，最小 Seatbelt profile 可以真正拒绝文件越界和部分网络/进程操作；它不能凭本次实验被当作可上线的通用本地 CLI 沙箱。** 已复现全树取消、CPU 硬终止和作业内存边界的缺口。P02 交付实验与否定证据，`productionRunnerReady=false`；不会因测试脚本退出 0 就启用 `process.execute`。

## 1. 本次实际交付与范围

- [独立 harness](../../../scripts/acceptance/local-isolation/p02.mjs)：仅接受无参数运行，固定合成用例；Node 内置模块，不依赖在线安装。
- [C 合成探针](../../../scripts/acceptance/local-isolation/probe.c)：本机 Clang 编译到一次性临时目录；不编译/执行租户代码，不提供 Shell 或任意可执行路径入口。
- [原始 Intel 结果](evidence/p02-intel-2026-09-07.json)：逐项状态、观测、平台、源码摘要和 profile 摘要。34 项中 **31 项通过、3 项记录限制、0 项测试异常**。`limitation_observed` 绝不是防护通过。
- 未改 Bridge、Tool Broker、DSH、API、数据库、运行契约、capability handshake 或产品 Feature Flag。没有迁移、没有真实租户数据或新功能权限；P05 以后的执行器不能直接导入此探针作为实现。

测试基线完整 SHA：`f696c0ea4b79f1f5c8eb2074b4664c4ec4495eaf`。证据来自该基线上新增探针的工作树，`sourceBase` 记录基线，不伪装成测试时已存在的候选提交。两份测试源码的完整 SHA-256 在 JSON 中；后续 PR 证据同时记录最终候选完整 SHA，可据摘要核对内容。采集时间：`2026-09-07T13:03:17.926Z`。

## 2. 平台必须分别记账

| 平台              | 真实环境/可用性                                                                           | 本次证据                                     | 能否启用通用本地执行        |
| ----------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------- |
| Intel / x86_64    | MacBookPro15,2；macOS 15.7.7 / 24G720；Node 22.23.2；系统 Clang、`/usr/bin/sandbox-exec`  | 34 项实际运行，含 3 项已知限制               | 否                          |
| Apple Silicon / M | 本次未取得可验证远程连接；`huihuimac` 的 BatchMode、既有主机密钥验证 SSH 连接在执行前关闭 | **未测试**，不是通过，也不是已证实平台不支持 | 否，须在授权 M 设备原生重跑 |
| Linux / Windows   | 此 harness 不实现对应后端                                                                 | 明确不支持本实验，退出 2；无裸执行回退       | 否；云端 Runner 另属 P15    |

双架构编译不能替代 M 设备实测。没有为获得 M 结果关闭主机密钥检查、扫描网络、请求新凭证或远程写文件；也没有用模拟平台字段补一份“通过”报告。

## 3. 如何复现，具体做了什么

在 macOS 仓库根运行（无需 `pnpm install`）：

```bash
node scripts/acceptance/local-isolation/p02.mjs
```

需要 Git、Node 22+、系统 Clang 和 `sandbox-exec`。标准输出为 JSON；未支持平台、前置工具缺失、profile 失败或意外断言失败时返回非零，不在失败后改为裸执行。由于这是固定的边界实验，预期缺陷用独立 `limitation_observed` 表示，脚本成功只表示观察与断言一致，不表示可上线。

只在 `mkdtemp` 创建的唯一 `allrice-p02-*` 目录内放置授权 workspace、兄弟 outside、合成 `.env`/key、软链接、硬链接目标、编译出的两个测试二进制和 profile。所有越界攻击对象都是此次创建的合成兄弟目录；不读取真实用户凭证。仅启动受控 IPv4 loopback 与临时 Unix socket listener，不连接公网、个人账户或真实 SSH agent。

每个探针受独立 alarm/外部 watchdog 约束；fork 用例最多产生一个短命子进程。输出生成最多 64 KiB，捕获最多 16 KiB；内存探针最多触碰 16 MiB；CPU 反证到约 2.5 秒自行结束；脱离进程组的子进程约 1.2 秒结束且有 3 秒 alarm。清理只删除当前 harness 创建并校验父目录/前缀的确切临时根，不使用全局 `pkill` 或宽泛目录删除。

本次另运行了 `pnpm exec eslint scripts/acceptance/local-isolation/p02.mjs` 和 Prettier 检查；C 编译使用 `-Wall -Wextra -Werror`。这些静态检查不替代真实 OS 测试。

## 4. 防护证据，不把目录与命令白名单冒充沙箱

| 维度           | 实际输入与观测                                                                                                                      | 证明范围                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 启动与正常工作 | 同一个沙箱内创建、读取授权文件，父进程核对精确内容                                                                                  | 不是“所有操作都打不开”导致假通过                                        |
| 路径           | 兄弟文件读取/覆盖/新建、`..`、指向兄弟目录的软链接读写均被 OS 拒绝；原文件不变，新文件不存在                                        | 静态路径与链接用例，不是任意并发 TOCTOU 证明                            |
| 合成凭证       | 授权根内明确拒绝的 `.env`、软链接、文件/目录改名、硬链接均拒绝；父进程复核原件和目标不存在                                          | 固定 deny 对象；不是已实现通用凭证发现/掩码或 Keychain 隔离验收         |
| 环境           | 只传 PATH/LANG/临时 TMPDIR；父进程合成 canary、SSH agent、注入变量未继承                                                            | 可信 supervisor 的 env 过滤，不能归功于 OS 沙箱；不读取真实密钥         |
| 网络           | 裸探针只作为合成正对照，TCP/UDP/Unix socket 各到达一次；沙箱调用报 EPERM，父 listener 没收到额外连接/包；bind 拒绝                  | IPv4 TCP/UDP 与 Unix socket；未测 IPv6、DNS、各种 Mach/系统代理绕行     |
| 子进程         | strict profile 禁止 fork；单独 profile 开 fork 后，子进程 exec 同一合成二进制仍不能读 outside；另一个合成二进制禁止 exec            | 内核确实施加并继承限制；exec 白名单只是收窄 fixture，不是单独的隔离证明 |
| FD/文件        | pre-exec soft+hard NOFILE=32 后最多新开 29 个 FD，再报 EMFILE；FSIZE=65536 后即使忽略 SIGXFSZ 也不能继续增长，父进程核对 65536 字节 | 单进程 FD/单文件大小，不是整棵树或磁盘配额                              |
| 输出/墙钟      | stdout+stderr 合并捕获 16384 字节后终止已知进程组；300ms timeout 终止直接探针                                                       | 可信 supervisor 功能；管道不受 FSIZE 约束；不能宣称全树停止             |
| 失败关闭       | 故意损坏 profile，工具非零且没有探针启动标记                                                                                        | 没有解析失败后的裸执行 fallback                                         |

最小 profile 采用 `deny default`，授权根外只给测试二进制、`/usr/lib`、`/System/Library` 必要读取，以及 dyld 需要的根目录读取和目录 metadata；因此 **允许看见根目录名称/目录 metadata，不是隐藏整个文件系统**。默认不放开网络、任意 exec、Mach lookup、Apple Events 或全用户目录内容读取。`sysctl-read` 与可执行映射仍属于本次 profile 的允许项，生产版本要再收窄并验证，不能把这份短 profile 宣称为通用恶意代码隔离政策。

初始 profile 未给 dyld 根目录/目录 metadata，真实启动发生 SIGABRT，不能据此把后续拒绝记为通过。补充必要读取后重新运行全部用例，才得到本页证据；没有通过扩大到全盘读取修复启动。

## 5. 三项实际缺口与后续门禁

1. **进程组不是进程树。** `setsid()` 子进程脱离父组；父组 SIGTERM/SIGKILL 后它仍继续写入合成心跳，并自行完成。限制文件访问与完成取消是两件事。P05 必须证明整棵树停止、与租约/attempt 绑定、撤销和断线恢复；不能把 kill 返回成功写成 `stopped`。P02 未解决该缺口。
2. **CPU 的 hard 值不等于本平台已证明强制终止。** 正常探针超过软限收到 SIGXCPU；另一探针忽略 SIGXCPU 后，配置 soft=1/hard=2，仍累计 `2501063` 微秒 CPU 后自行退出。即使手册讨论软硬上限，也不能覆盖反证。不能用这一 rlimit 配置替代可信 supervisor、根任务预算与全树控制。
3. **没有建立作业内存上限。** 本机将 DATA 降到 8 MiB 被 EINVAL 拒绝，随后受控 16 MiB mmap 可完成；这证明该配置未生效，**不证明所有 DATA 值都不可用，也不证明所有内存后端无效**。DATA 也不能直接被当作跨子进程的物理内存配额；当前没有作业级内存和进程数量隔离证据。不得把缺失计为 0 消耗/0 风险。

另外，`NPROC` 定义是每 UID 进程数，CPU/FD 等为每进程约束；没有用修改共享用户额度的方式假装实现租户预算。这里不做 fork bomb、OOM、真实凭证窃取或系统攻击测试。未测的符号链接并发交换、文件描述符继承绕行、IPv6/代理/Mach 服务、工具链/包管理器、全树资源聚合、M 设备、OS 升级兼容、签名/公证和更新撤销须继续保留为未验收项。

## 6. 隔离后端判断与 P05 交接

- **保留**：Seatbelt 作为可重复本机实验，证明文件/网络限制不是单靠 cwd 或 Prompt。现有 Bridge 文件功能不因该实验改变。
- **不直接晋升**：本机 `man sandbox-exec` 明确标为 `DEPRECATED`。它是实验后端，不是已承诺的长期平台 API，也未建立整树停止和聚合资源边界。无法满足所声明能力时应明确 unavailable，不能退回无隔离执行。
- **下一步验证**：受支持的 App Sandbox 子进程继承方案、受控 VM/容器或其他可证明后端均可研究；App Sandbox 的文件授权和子进程继承不自动提供按任务动态策略或完整资源管理。P02 没有实现这些替代后端，也没有用“未来换 VM”当作当前通过证据。
- **P04/P05 开放门禁**：明确生产支持的 OS/架构、后端与策略版本，完成被允许工具链的真实隔离、整个进程树取消/撤销、资源上限和日志去敏、两种 Mac 原生证据；连接租户审批/冻结配置/attempt/unknown 规则。达不到完整本地 CLI 能力时可继续开发协议与 UI，但相应执行能力必须保持关闭，不能声称本地任务验收完成。
- **回滚**：本 PR 无 schema/协议/功能 Flag 变更；回滚只移除实验代码和报告，不影响旧 Bridge/Session。测试运行完成后只清理其合成临时目录和短命探针；不会清理用户项目、设备配对或租户数据。

## 7. 查证来源

本页主要结论来自原始 JSON 和此次本机探针，外部资料只解释机制，不代替平台实测。

- 本机 `man sandbox-exec`：该工具已弃用；本机 `man 2 setrlimit`：资源语义。Apple 的 [setrlimit 官方手册](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/setrlimit.2.html) 区分 CPU、FD、FSIZE、DATA 与每 UID 的 NPROC。
- Apple [App Sandbox 官方说明](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox)：应用及其子进程的保护边界；不能据此推断 AllRice 已采用或验证该方案。
- Apple [XNU 的资源限制实现](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_resource.c)：可见 DATA 降限可能被 VM 拒绝；这是当前公开源码，**未证明与本机内核逐行相同**，因此本页保留实际 errno，不替 OS 猜根因。
- Anthropic [macOS sandbox-runtime 实现](https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/macos-sandbox-utils.ts)：核对 SBPL/目录 metadata/IPC 策略复杂性。仅研读参考，没有复制库实现、引入依赖或声称继承其安全认证。
