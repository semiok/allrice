# P03-b：Bridge 本地执行日志与结果 Outbox

> MET-114 / B1。新增传输默认关闭；不开放 Shell、PTY、依赖安装、后台服务或新的 Bridge capability。

## 产品意义

网页断线不应该让 Rice 再写一遍文件。PostgreSQL 继续决定任务、权限、租约和状态；设备上的 SQLite 只保存“这一台电脑是否已经开始过、有没有拿到真实结果、结果是否已送达”的证据。它不是第二套 Agent Loop 或任务调度器。

| 中断位置                                             | 设备重启后的处理                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| 已收到，但还没提交执行标记                           | 证明本客户端未开始，记录 failed / effects=none；不自动改为新尝试 |
| 已提交 executing，但没有持久结果                     | 记录 unknown，等待核实；包括服务端 start ACK 丢失，不能再次执行  |
| 结果已落盘，但 HTTP 响应丢失                         | 重投相同 receipt ID 和内容；只重投证据，不重做文件操作           |
| 已确认结果，再收到相同命令                           | 保留去重记录，不执行第二次                                       |
| 同 operation ID 的内容、attempt、fence 或 lease 改变 | 冲突并拒绝；不能把旧记录当成新授权                               |

未知结果不等于失败、已取消或可以转云。取消与完成竞争时保留实际执行结果，不伪称已经停止。

设备 token 已撤销时，迟到结果不能再通过正常设备 API 上报。服务端取消/unknown 与本地待投证据分别保留，需管理员核实；B1 不通过放开撤销凭证来伪造“完整自动恢复”，也尚未提供独立的人工证据导入流程。

## 代码与真实接入

- [共享传输契约](../../../packages/contracts/src/runtime-v2/bridge-journal.ts)：新增 opt-in envelope，旧 Bridge v1/v2 能力枚举不变。operation 的 inputDigest 绑定规范化的既有 Bridge payload。
- [本地日志](../../../apps/rice-bridge/src/journal.ts)：私有 SQLite、设备/服务绑定、执行标记、结果事务、重放防护和容量限制。
- [HTTP 客户端](../../../apps/rice-bridge/src/operation-client.ts)：先清 Outbox，再领取新工作；独立 start preflight，先落日志再执行；不把网络 ACK 解释为再次执行许可。
- [HTTP handler](../../../apps/web/lib/bridge/operation-http.ts)：可信设备鉴权、工作区和目标校验、请求字节上限；通过 P03-a ledger port 操作 PostgreSQL。
- [生产装配点](../../../apps/web/lib/bridge/operation-runtime.ts)：P03-b 独立部署时没有可放行的 admission，默认失败关闭。B1 合并集成必须装配 P04 的真实政策、成员/Run/设备/目录校验，不能换成空 callback 或浏览器自报 binding。

新增 `/api/v1/bridge/device/operations/next`、`/{id}/start`、`/{id}/receipts`。没有新的公开“创建任意 operation”入口，也不把旧队列自动搬进新账本。B1 首版 HTTP 适配仅处理 projectId=null 的工作区级操作；Project 归属需后续可信适配。

`ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED=1` 需在服务端和目标 Bridge 的受控测试环境分别显式设置。未设置时旧 CLI、配对、Keychain、工作区选择、心跳和旧命令 HTTP 路径保持不变。开关开启后新客户端不回落到旧命令执行路径，防止用回退绕过日志。旧客户端不会自动声明新能力。

新执行通道要求 HTTPS，只有显式 loopback 地址允许 HTTP 合成测试；请求不跟随重定向，防止执行授权通道静默跳转。

## 持久性、排他与边界

本路径要求含内建 `node:sqlite` 的 Node 22.13+；本次主机测试使用 22.23.2。旧路径不会加载 SQLite。正式 macOS 分发必须使用支持 SEA 的对应架构 Node 构建；Homebrew Node 可能没有 SEA sentinel，不能用“TypeScript build 通过”代替实际打包测试。

采用 SQLite `journal_mode=DELETE`、`synchronous=EXTRA` 与 `locking_mode=EXCLUSIVE`。先完成独占事务再启动客户端，并在执行标记和结果事务之间保持 OS 排他锁；**提交执行标记后才调用实际工具**，不把整段副作用夹在未提交事务里。进程退出由 OS 释放锁，新进程获得锁后才能核实旧 executing 记录。另有进程内保护，避免额外打开/关闭描述符影响 POSIX 锁。

日志目录 0700、数据库/旁文件 0600，校验所有者、普通文件、单硬链接和无符号链接；检查目录/数据库 inode，创建后同步文件和目录。不得授权包含日志本身的上级工作目录执行新路径，防止工具改写自己的证据。SQLite 提供崩溃恢复，**这不是对同一 OS 用户恶意篡改、磁盘损坏或操作系统失陷的安全隔离证明**；P02/P04 的隔离和权限门禁仍然必要。

默认最多 1,000 个 operation tombstone、约 128 MiB 日志容量预算，领取前预留结果空间；每条 receipt 最多 500,000 字节，输出超限记录“已完成但输出省略”，不把已发生的写入报成失败。每次最多投递 16 条，未清空则不领取新工作。保留已 ACK 证据和 tombstone，不自动删历史后允许重放。配额满、旧记录冲突、文件不安全或磁盘写失败均停止新动作，需要显式运维核实；P03-b 不实现自动归档/修复按钮。

持久输出可能包含已授权的工作文件内容，因此日志也属于敏感本地数据；0600 不是加密承诺。日志不保存设备 Bearer token，保留精确操作的 lease token 和结果证据。未知结果的证据不会被伪装为成功 output。

## 已验证与未验证

新增测试直接使用真实文件系统和 SQLite，而不是内存 journal：

- 重开数据库后的结果和 ACK 持久性、保留 tombstone；过期/冲突 attempt、不同设备/服务拒绝。
- 独立子进程已提交 executing 并写入合成文件时，第二进程无法获得独占锁；真实 SIGKILL 后可恢复为 unknown，文件保留且不再次执行。
- 目录/文件权限、符号链接、硬链接、数据库 inode 替换、容量与输出限额。
- 在真实 SQLite 上注入 BEGIN/COMMIT IO 错误（不是断电实测），即使 ROLLBACK 成功也毒化当前句柄，禁止继续领新任务；重开后已发生副作用保留为 unknown。
- 真实 loopback HTTP server + 本地文件操作；start 响应丢失不执行，结果 ACK 丢失后重开日志只重发；取消竞争、ACK ID 不符、请求/响应上限、鉴权和默认关闭。

HTTP fixture 的服务端 ledger 是确定性替身，**不冒充 PostgreSQL 集成**。B1 总体验收需另用 P03-a PostgreSQL + P04 admission 装配真实路由，校验租户隔离、撤销/取消与结果恢复。这里不宣称真实 Snow/Drink 设备、macOS 菜单栏、两个架构正式安装或 Dev/Prod 已验收。

```sh
pnpm exec vitest run apps/rice-bridge/src packages/contracts/src/runtime-v2
pnpm --filter @allrice/rice-bridge typecheck
pnpm --filter @allrice/web typecheck
pnpm --filter @allrice/rice-bridge... build
node scripts/acceptance/runtime/bridge-journal-sea.mjs
```

SEA 脚本只创建临时合成设备、loopback HTTP 和私有日志，验证真实 CLI 的 SQLite 加载/轮询/停止；不会配对或操作真实租户。必要时提供与目标匹配的 `ALLRICE_BRIDGE_NODE_BINARY`、`ALLRICE_BRIDGE_BLOB_NODE_BINARY`，可用 `ALLRICE_POSTJECT_CLI` 指向已安装的 postject 避免重复下载。单主机测试结果不能代表另一架构。

2026-09-07 实测 macOS x64 / Node 22.23.2：实际 CLI SEA 打包、SQLite 加载、0600 日志创建、loopback 轮询和 SIGTERM 退出通过。使用官方 `node-v22.23.2-darwin-x64.tar.xz`，SHA-256 `96dff79f4e19a78715da559ec7cac2028f4985a175ea0c3454625a269c21deb7`，与 [Node 官方校验清单](https://nodejs.org/dist/v22.23.2/SHASUMS256.txt)匹配。Homebrew Node 不带 SEA sentinel 的首次构建失败已定位，未把它当通过；Apple Silicon 分发与公证更新不在本主机验证结论内。

## 回滚

先停止新路径领取并核实正在执行/unknown 的动作，保留服务器和本地 journal 证据。关闭 Feature Flag 恢复旧客户端路径，但不能把新账本的未知动作搬入旧队列；不得删除日志来“修复”重复执行保护。没有新 DB migration；P03-a 的 additive schema 由其 PR 管理。撤销新代码不撤销已经发生的本地文件写入。
