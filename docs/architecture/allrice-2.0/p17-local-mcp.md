# P17 / MET-133 — 本地 MCP 注册、审批和运行闭环

P17 是 B5 的一个独立交付切片，基线为 `7ed52d88ceebb3131f37446a0781de7a3be9c488`。本页记录源码和隔离验收，不代表已经合并、部署 Dev、安装 Bridge 或启用租户能力；批次发布状态以执行总表为准。

## 产品与实现

复用 P16 的连接、工具版本、逐工具授权、员工版本绑定；新增 `local_stdio` transport 与设备所有者配置。云端 HTTP MCP 与本地 stdio 分开管理，不能把云端 endpoint、凭证或授权带到本机。

用户流程：

1. 在自己的 Bridge 中明确启用已审核安装的沙箱和本地 MCP。不是装上 Bridge 就自动开放。
2. 在 `/workspace/mcp` 选择本人设备、目录授权、相对路径，以及固定版本、入口和完整文件校验和清单。可登记本机凭证引用，不上传凭证明文。
3. 绑定获准的员工版本。保存配置本身不启动任何进程。
4. 发送发现工具的任务，批准这一次发现；Bridge 从固定清单创建无网络隔离副本，运行真实 MCP Server，回传工具目录。
5. 审核工具后逐个授权。发现结果默认不授权；新工具或 schema 改动不能静默继承权限。
6. 下一条新任务冻结新的连接和工具目录，模型调用 `local.mcp.call` 时再批准该次调用。旧 Run 不获得新增能力。
7. 回执分别展示结果是否已知、是否调用过工具、是否真实停止。丢失结果、不明确副作用、`isError` 等不能自动重放。

员工必须已有发布 Skill 所声明的写入能力和非自主执行模式；绑定 MCP 只激活明确登记的 MCP 凭证使用能力，**不会自动发布 Skill 或扩大通用文件写入权限**。无连接、未绑定、未逐工具授权、旧冻结配置或任一功能开关关闭时，不向模型开放本地 MCP 调用。

## 边界与目录

| 层           | 实现入口                                                                           | 责任                                                               |
| ------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 契约         | `packages/contracts/src/local-mcp.ts`、`runtime-v2/local-mcp.ts`、`mcp-schema.ts`  | 固定来源、有限 JSON Schema、目录快照、输入与回执上限               |
| 权威状态     | 迁移 `0087_local_mcp.sql`、`packages/database/src/local-mcp-*.ts`                  | 所有者与设备授权、版本、发现接纳、Run 冻结、操作和审批             |
| 通用账本     | `runtime-policy.ts`、`runtime-governed-bridge.ts`、`runtime-ledger/ledger.ts`      | 在审批、派发、START 和运行租约处重复检查当前授权；审计、预算、取消 |
| Worker / DSH | `allrice-local-mcp-native-tools.mjs`、`tool-broker/handlers/local-mcp.ts`          | 使用既有 Agent Loop；验证模型参数，创建持久操作，等待结果          |
| Bridge       | `apps/rice-bridge/src/local-mcp-*.ts`、`operation-client.ts`、`journal.ts`         | 私有凭证、精确副本、隔离进程、调用前持久意图、先落回执再清理       |
| 网页         | `/api/v1/admin/local-mcp`、`/api/v1/runtime/local-mcp`、设置组件和 `LocalMcpPanel` | 本人管理、明确授权、刷新恢复、撤销、结果与停止证据                 |

模型只选择已冻结的连接与工具，不决定宿主路径、进程参数、凭证值、执行设备或权限策略。发现目录只能来自成功并确认停止的当前操作；相同回执幂等，旧发现不能覆盖较新的目录。解析和数据库故障不伪装成“连接不存在”或静默忽略。

端侧进程、凭证存储限制、命令和资源上限见 [P17 Runner](./p17-local-mcp-runner.md)。首版只支持审核后的 Node JavaScript stdio 服务，最多 64 个文件 / 256 KiB；不自动安装第三方包、不支持任意宿主 CLI、网络型本地 MCP 或个人浏览器会话。不能把这个受限实现宣称为所有第三方 MCP 即插即用。

## 验证记录 — 2026-09-09

- 真实 PostgreSQL 隔离 schema：32/32，覆盖保存不执行、默认拒绝、员工绑定、发现回执、schema/凭证版本变更、撤销、租户与所有者、旧回执、下一轮冻结和数据库异常。
- 私有 Chrome + 实际鉴权 HTTP + PostgreSQL + 真实 SQLite journal + Intel 独立 VM：设置绑定与保存、未批准不执行、页面重开审批恢复、发现、逐工具授权、新 Run 调用返回 `synthetic-rows:3`、实际停止、撤销失效、390px 无横向溢出均通过。使用合成身份签发真实登录会话 Cookie，不是密码登录测试，不请求模型或供应商服务。
- 上述闭环入口：`scripts/acceptance/runtime/p17-local-mcp-workbench.ts`；最终报告 `/private/tmp/allrice-p17-ui-MOFbb5/report.json`。此前代理路由遗漏、表单可访问标签以及验收脚本参数/隔离配置错误的失败证据保留，修复后重新完整执行。
- Intel 的实际 Vitest VM suite 13/13。M5 ARM64 使用相同 13 个测试体与实际 Runner/VM，经过便携 Node assert 适配执行 13/13；不是声称在 M5 安装运行 Vitest。检查发现 M5 原专用 VM 已停止，按原隔离配置重新启动后完成；未安装依赖、替换日常 Bridge 或修改配对。
- M5 证据 `/private/tmp/allrice-b5-p17.di9h8s/report-final.json`，本机副本 `.local/p17-arm/report-final.json`；合成容器按准确身份回收，最终没有残留 `allrice-mcp-*` 容器。临时测试包和报告保留便于复核。
- 全仓回归最终一次：1532 passed / 407 gated skipped / 0 failed（`--maxWorkers=2`）。前一次并发回归中已有 P24 原生子代理时序测试失败，保留该记录；没有删除或放宽它，随后完整复测通过。跳过的外部集成门禁不计为通过。

这些证据不等于最终打包后的 M5 原生菜单、Finder 权限、真实凭证 Keychain、正式签名/公证或 Dev 端真实用户模型任务验收。MCP 私有凭证文件仍明确未加密，不能冒称 Keychain。

## 发布与回滚

`ALLRICE_LOCAL_MCP_ENABLED=0` 为默认值。启用还需要既有 Policy、Bridge Ledger、Local Command 开关；不得为了验证本地 MCP 自动打开真实租户全部能力。

0087 为扩展迁移，保留旧云端 MCP 数据和 HTTP 接口。回滚先关闭新调用并排空/确认停止新进程，保留审批、回执、发现版本与审计，不能删除持久账本或靠重发恢复不明确结果。旧 Bridge 不声明 `local_mcp`，因此不接收新操作。

B5 最终桥接包、五个 PR 集成、CI、main 合并和统一 Dev 切换仍须批次门禁确认。
