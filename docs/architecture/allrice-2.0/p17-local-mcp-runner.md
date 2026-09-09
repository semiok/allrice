# P17 / MET-133 — 受控本地 stdio MCP Runner

本页记录 Bridge 端侧实现与独立测试，不代替云端注册、冻结快照、Policy/Budget、审批账本或整批验收。P17 不是宿主机任意 CLI，也不表示任意第三方 MCP Server 已兼容。

## 运行边界

- 执行目标只有已存在且通过 preflight 的独立 Linux VM / 固定 digest 容器。复用本地命令 Runner 的架构、cgroup v2、seccomp、资源限制和 Unix Docker socket 检查。
- 不在 macOS 宿主 `spawn` MCP，不使用 `npx`、Shell 字符串或自动包安装。只运行用户准备的 Node JavaScript 入口及明确列出的依赖/数据文件；所有文件均固定 SHA-256。`source.files` 相对授权 `arguments.path`，只复制清单文件，拒绝软链接、硬链接、敏感文件名和凭证目录重叠。
- 容器无宿主目录绑定、无外部网络、无自动重启；工作区写入仅发生在隔离副本，不能冒称改了原工作区。首次版本不支持需要网络、个人浏览器会话或任意系统二进制的 MCP。
- 可信 PID1 以 root 管理控制管道；用户 MCP 进程固定 UID/GID 1000、最小环境和独立 stdin/stdout/stderr，不能控制 PID1 或获取 Docker socket。
- 每次 discovery/call 都是新的短生命周期进程；不复用旧 Run 的进程或授权。发现需要单独的准确授权；调用须重新发现并验证所选工具的完整 digest，不能把发现授权直接当执行授权。

## 协议、账本和结果

可信 supervisor 使用有界换行 JSON-RPC：`initialize`（协议 `2025-11-25`）、`notifications/initialized`、分页 `tools/list`，再等待可信控制管道明确选择结束发现或调用一次 `tools/call`。

不提供 roots、sampling、elicitation 等客户端能力；服务器请求返回 method-not-found。工具列表变更通知终止本次实例，不自动接纳新 schema。工具 schema 使用共享 `assertMcpSchemaSubset` 和锁定 SDK 1.30.0 的 `AjvJsonSchemaValidator`，不忽略不支持的校验关键字。

调用前必须完成 `prepareCall({ requestId: attemptId, digest })` 持久化；此后即使 ACK 丢失也不重发。断线、取消、lease 丢失、`isError`、协议失败、已启动进程但缺少结果，都不能当作 `effects:none` 或允许自动重试。冷恢复只能按准确容器名称、attempt 标签和 image digest 停止已有实例，不能启动 MCP；只有 Docker 明确 404 才表示没有实例。

本地结果先持久化后才能删除准确的已停止容器。可信终止、`stopConfirmed`、`callAttempted`、`resultKnown` 分开记录；杀死进程不证明业务动作没有发生。实际错误响应允许只有 text content；若带 structuredContent，仍必须符合冻结的 output schema。

## 明确上限

| 项目                     | 首版上限                                                |
| ------------------------ | ------------------------------------------------------- |
| 工具参数 JSON            | 8 KiB                                                   |
| 单行 JSON-RPC / 工具结果 | 64 KiB                                                  |
| 工具发现总 JSON          | 128 KiB、32 个工具、8 页                                |
| 本地回执总 JSON          | 256 KiB                                                 |
| 清单文件                 | 64 个；继承每文件 200,000 字节、总计 256 KiB            |
| 协议消息数               | 64                                                      |
| stderr                   | 16 KiB / 64 帧；仅计数，不回传原文                      |
| 单进程最长时间           | 60 秒；控制短租约最长 5 秒                              |
| 资源                     | 128–512 MiB、16–64 PIDs、明确 CPU quota                 |
| 凭证                     | 8–4096 字节可打印 ASCII，仅一个固定 `ALLRICE_MCP_TOKEN` |

仅支持 text content 与可选 structuredContent/isError。Image、resource 和任意扩展输出不能未经审查透传。超限与非法 UTF-8/JSON 会中止实例；不会以“截断后的成功结果”继续执行。

## 凭证生命周期：受保护但未加密

首版 MCP 凭证使用本机独立的 0700 目录和 0600 文件，明确标为 `private-file-unencrypted`，**不是 Keychain、不是加密存储**。Bridge 自身设备凭证既有 Keychain 机制保持不变。

MCP 记录绑定 `server origin + deviceId + connectionId + sourceDigest + reference.id + reference.revision`。不同 scope 不能读取；同一 revision 只能幂等写入相同 token，不能暗中轮换。撤销写入不含 token 的 tombstone，原 revision 不可复活；新 token 要求新 revision 及相应云端版本更新。写入/删除失败不会报告撤销成功。

token 只从非 TTY stdin 接收，经本机私有控制管道传入容器后，仅成为 MCP 子进程的环境变量。不进入命令 argv、Docker create/inspect 的容器 Env、派发载荷或 SQLite journal。日志只保留固定错误码；stderr 原文不传出；协议响应中的明文及 JSON 转义 token 拒绝进入回执。

这不等于防御恶意 Server 对 token 任意编码或派生后的所有泄露，也不等于磁盘备份的安全擦除。无网络容器、来源冻结、精确审批和输出审查仍是必要边界。不要用提示词代替这些控制。

## 用户启用流程

服务端仍需分别启用现有 `ALLRICE_RUNTIME_POLICY_ENABLED`、`ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED`、`ALLRICE_LOCAL_COMMAND_ENABLED` 和新的 `ALLRICE_LOCAL_MCP_ENABLED`，并通过员工授权、工作区授权、预算及每次发现/调用审批。CLI 本地成功不证明服务端已授权。

1. 正常退出正在运行的 Bridge；既有配对和工作区保持不变。
2. 已安装且审核过的独立 VM 可用后，运行既有 `rice-bridge sandbox enable`。本功能不安装 VM，也不自动开启 sandbox。
3. 运行 `rice-bridge local-mcp enable`：检查既有 sandbox opt-in 和真实 preflight 后，保存与当前设备/服务端绑定的本地选择。
4. 如工具需要凭证，执行 `rice-bridge local-mcp credential set <connectionId> <sourceDigest> <refId> <revision> --private-file-unencrypted`，从受控的非交互式 stdin 输入 token；不要把 token 放在命令参数或 shell 历史中。
5. 正常重新打开菜单栏 App。Core 从安全本地设置读取 MCP opt-in，不需要终端保持开启，也不扩大 Swift 宿主的环境变量白名单。
6. `rice-bridge local-mcp status` 可在 App 运行时只读检查；修改设置或凭证需先正常退出 App，以遵守现有单实例锁。`local-mcp disable` 不访问 Docker，不取消配对、不删除工作区。

`local-mcp --help` 列出设置和凭证子命令。MCP 默认关闭；换设备、换服务端、解除配对、sandbox 关闭或不安全配置都会使既有实例的 MCP 授权失效。profile 发布和运行中的每次 lease 都重新检查本地选择；禁用不能只隐藏 UI 而留下进程继续运行。已保存 opt-out 优先于开发用 env=1；env=0 仍可作为紧急关闭开关。

目前 opt-in 是一次性 CLI 设置，原生菜单尚未新增图形开关或凭证输入界面；正常 App 已能读取并执行这一选择。MCP 凭证本地 revoke 只代表本机记录失效，不等于云端 connection 已撤销；云端撤销通过短租约检查终止在线任务。

## 端侧验证记录（2026-09-09）

独立 Intel `allrice-b2` VM 上真实执行 `local-mcp.integration.test.ts`，使用固定工具链、临时输入目录、合成工具和合成凭证，不读取真实用户凭证、工作区或网络服务。测试容器按准确 attempt/image 身份核对后正常删除，临时目录随后清理。

已验证真实 initialize/list、调用前 fsync 意图与单次调用、UID/权限隔离、凭证只经私管道注入（检查 decoded Docker 输入也无 token）、schema/参数/output 校验、isError、写后丢响应、凭证撤销、断连杀死包含 detached 子进程的容器、超时、stderr 限额、JSON 转义凭证回显阻断，以及不带环境开关的持久 opt-in、禁用后 lease 中止和 capability 撤回。

另有纯契约/受控 stdio 端口/本机私有文件/owned-orphan mock 测试，分别验证字节上限、严格源清单、作用域与文件安全、不可隐式轮换、tombstone、默认关闭、配对切换失效和精确 Docker 404 语义。实际 Node CLI 子进程测试还验证非 TTY stdin 配置及撤销凭证、运行中允许只读 status/help 但禁止绕过实例锁修改设置。端口替身测试不冒充真实 Server 或 Keychain 验收。

本轮端侧新增 60 项：47 项非容器测试、13 项真实独立 VM 测试，均通过。包含该阶段改动的全 Bridge 回归一次为 357 passed / 55 gated skipped；随后新增的 2 项实际 CLI 测试单独通过。类型检查、定向 lint、contracts 与 Bridge build 通过。完整批次最终数量以主代理合并所有模块后的报告为准。

执行命令（只针对指定独立 VM）：

```sh
ALLRICE_LOCAL_DOCKER_TEST_SOCKET=/Users/a123/.colima/allrice-b2/docker.sock \
  pnpm exec vitest run apps/rice-bridge/src/local-mcp.integration.test.ts
pnpm exec vitest run apps/rice-bridge/src/local-mcp-protocol.test.ts \
  apps/rice-bridge/src/local-mcp-runner.test.ts \
  apps/rice-bridge/src/local-mcp-credentials.test.ts \
  apps/rice-bridge/src/local-mcp-inputs.test.ts \
  apps/rice-bridge/src/local-mcp-settings.test.ts \
  apps/rice-bridge/src/local-mcp-cli.test.ts
```

本页不声明云端真实用户审批端到端、最终发布包、ARM 设备或新版本原生 AX 已通过；这些由总表及批次发布门禁单独记录。未提交、未部署不等于交付完成。
