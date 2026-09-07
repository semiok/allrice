# P05：受控本地命令

归属：[MET-116](https://linear.app/metasnowsky/issue/MET-116) / B2 / S1 / R2；
排期以[唯一执行总表](https://linear.app/metasnowsky/document/allrice-20-执行总表阶段依赖pr-与验收门禁-df09b0b1e681)为准。

## 先验证后开放

P02 的 Intel Seatbelt 实验没有证明整树停止、聚合内存及进程数量边界。
P05 不把该实验晋升为可用 Runner，不退回裸 Shell。当前选择验证本机 Linux VM
中的独立受限容器：本机执行，不是 SaaS 云端接管，也不宣称运行的是 macOS 原生工具链。
下列实现已在独立 Intel 本机 VM、真实 PostgreSQL、真实 Chrome 和设备 HTTP 链路验证。
B2 尚未整体交付；新能力默认关闭，Apple Silicon 未通过实测，不能启用。

### 首版准确范围

- 单次结构化程序及参数，只运行明确列入配置的不可变 Node 工具链镜像；不自动拉取镜像、安装依赖、启动 VM 或修复用户环境。
- 用户明确选择的文件和 SHA-256 构成输入清单；执行前逐个核对真实目录、文件类型、敏感路径、大小及版本。
- 输入复制到本机容器的临时工作副本，**不挂载原工作区、主目录、Bridge 凭证、Docker socket、SSH agent 或浏览器资料**。命令的临时写入不自动覆盖原目录；P08 负责准确落盘与恢复。
- 无网络、无端口映射、只读根文件系统、独立 PID/IPC/网络命名空间、不可提权、有限 tmpfs、cgroup v2 内存／CPU／进程数限制。
- 可信 PID 1 监督器与任务使用不同 UID。任务以无额外 capability 的用户执行；监督器拥有创建工作副本及降权所需最小 capability，不执行租户脚本本身。
- 墙钟期限在容器内和 Bridge 两端强制，Bridge 崩溃不能取消容器内期限。取消终止容器 PID 命名空间，不靠一个进程组；必须在 Docker 实际确认停止后报告。
- stdout/stderr 有序捕获、总量上限及截断提示；不把网络 ACK 当作开始／完成／停止。
- 固定 attempt 关联容器名和 label，重复派发不能重复创建执行。失联与无法核验保留 unknown，迟到证据独立恢复；不自动重试副作用。
- VM／容器不可用、镜像变化、资源控制不支持或平台未验证时明确不可用。旧 Bridge 能力枚举及旧协议不因新增代码自动扩权。

### 已覆盖的失败场景

越界与敏感文件不可达；继承环境无合成密钥；网络和 socket 不可达；子进程 setsid 后
取消仍全树停止；任务不能停止／篡改监督器；内存与进程数受硬上限约束；CPU 配额生效；
超时、输出爆量、Bridge 崩溃、服务器断线／撤销／租约到期；准确输入变化后拒绝；
重复派发／ACK 丢失不重复执行。测试目录及容器全为合成、独立资源。

## 实现与权限链

1. 员工后续新 Run 的冻结工具清单必须显式含 `local.process.execute` 和 `storage:write`；
   原有 Bridge“读写”不自动授予命令权限。
2. Web、Worker 同时打开 `ALLRICE_LOCAL_COMMAND_ENABLED`、`ALLRICE_RUNTIME_POLICY_ENABLED`、
   `ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED`，并具备当前租户策略、有效 Run/Worker 租约、
   当前设备与目录授权。即使租户规则为 Allow，P05 命令仍强制单次精确审批。
3. Bridge 显式打开 ledger/local-command 开关并配置 `ALLRICE_LOCAL_DOCKER_SOCKET`、
   `ALLRICE_LOCAL_COMMAND_IMAGE`。仅 darwin/x64 报告经预检的本地执行 profile；服务端
   复检平台、固定镜像及 90 秒 profile 心跳，不把设备布尔自报当作安全证明。
4. 模型提交结构化程序、参数、相对工作目录、文件哈希清单及资源限制，不能指定 daemon、
   额外环境、网络或镜像。支持 Node 与 npm 脚本，不限制项目脚本内部的语言表达式；
   真正的执行边界是 VM/container，而不是“没有 Shell 字符串所以安全”。
5. PostgreSQL 绑定 operation/attempt、单次审批、冻结配置、七项命令摘要、原子领取及租约。
   重复 tool call 使用同一幂等 ID，改变输入被拒绝；旧 Bridge 不领取新命令。
6. 网页独立卡片展示准确命令、文件版本、位置与限制；授权、排队、执行、停止意图、
   确认退出、unknown 分开。完成后仍可刷新查看 stdout/stderr 与退出码，不将审批当完成。
7. Bridge 每秒复核运行授权，短 HTTP 超时后停止；独立设备心跳不被长命令阻塞。
   容器内绝对期限不能因 Bridge 被 SIGKILL 而失效。
8. 已核实结果先写本地 SQLite journal/outbox，再清理准确匹配的容器；ACK 丢失只重传。
   重启后的 unknown 只检查原 attempt 的容器证据，不创建或重启容器。

原有文件/git HTTP 队列继续可用；闲置的 operation 队列不饿死旧队列。
原始输出在进入事件、数据库、模型结果前有界脱敏；凭证前缀跨 chunk、UTF-8 分段、私钥
多行和超长无换行内容有专项测试。脱敏是补充控制，不承诺识别任意秘密；主防线是不挂载、
不继承本机凭证，且只接收精确批准的非敏感文件。命令最多 60 秒、64 个文件、256 KiB 输入、
64 KiB 输出、512 MiB 内存、1 CPU、64 PIDs；根账本最多预留 32 次命令，不伪造费用估算。

## 数据迁移与回退

`0076_local_command_runtime.sql` 仅 expand：新增设备 profile（复合租户外键）和有界输出表。
没有回填、删除或改变旧 Bridge capabilities。回退先关三个新执行开关、等待/确认在途停止；
保留操作、审批、输出及 SQLite 证据，不通过删表抹去 unknown。旧代码忽略新增表可继续运行。
不将仅收到取消或 transport ACK 的记录改为“已停止”。

## 本地实测与未测项

2026-09-08：仅创建独立测试 profile `allrice-b2`，未挂载用户目录、未更改默认 Docker
context、未修改已有故障 profile。Intel 本机可启动 VM；Apple Silicon 尚未实际验证。
固定工具链为 `node:22.23.2-bookworm-slim` 的本地不可变镜像 ID
`sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5`。
真实 cgroup v2 测试包括实际 CPU throttling、内存 OOM、PID 上限、网络拒绝、监督器保护、
setsid 子孙树取消及源目录不变；并非只读取 Docker 配置值。
正式菜单栏、可信客户端包、工具链安装、后台服务、浏览器预览仍属后续切片。

验证命令：

```sh
pnpm --filter @allrice/contracts build
ALLRICE_RUN_DB_INTEGRATION=1 \
ALLRICE_TEST_DATABASE_URL=postgresql://a123@localhost:5432/allrice_b2 \
ALLRICE_LOCAL_DOCKER_TEST_SOCKET=/Users/a123/.colima/allrice-b2/docker.sock \
ALLRICE_LOCAL_DOCKER_TEST_IMAGE=sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 \
pnpm exec vitest run packages/database/src/runtime-governed-bridge.integration.test.ts \
  apps/rice-bridge/src/local-command.integration.test.ts
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

2026-09-08 本地记录：56 项真实 PG/VM 专项通过（45 PG/端到端，11 VM）；全仓普通
测试 955 通过，145 专用条件测试跳过（随后增加的 signal 专项已在上述 56 项实跑）。
类型、lint、构建通过。DSH 是固定 0.1.1-rc.2 的实际运行时初始化测试：发现并修正
其参数 DSL 与 JSON Schema 的差异；没有调用真实模型或暴露 Worker 宿主工具。

实际 macOS x64 SEA 单文件包冒烟通过：SQLite 私有日志、合成 HTTP 领取与 SIGTERM
退出正常。Homebrew Node 不含 SEA sentinel 的尝试失败；换用与官方 SHA-256 清单一致
的 Node 22.23.2 darwin-x64 后通过（同 P03-b 的固定归档哈希）。不是 M 芯片签名/公证验收。

Chrome E2E 使用真实 React 卡片、PG 权威及生产设备 HTTP 适配器，合成登录/设备身份：
批准→本地执行→分流输出→退出→刷新恢复；首次回执确认故意丢失，结果不重跑；第二条
执行强杀独立 Bridge 子进程，先核实容器自动退出，再恢复 journal 补证据。宽屏与 390px
窄屏验证通过。此测试不是已部署 Dev 登录态验收；最终版本及 Dev 验收随 B2 统一补齐。

未验证/不支持：M 芯片、macOS 原生工具链、任意依赖项目、持久后台服务、任意 PTY、
云端透明接管、目录原地写入。Docker 容器证据被外部删除或创建后从未启动时继续保持
unknown，待人工核实，不猜测结果；设备丢失时不保证能取得最终证据。

参考机制：[Docker 资源限制](https://docs.docker.com/engine/containers/resource_constraints/)、
[Docker 安全边界](https://docs.docker.com/engine/security/)。内核 namespace/cgroup 是机制，
不是“绝对安全”保证；Docker daemon/VM/固定镜像属于本机可信执行底座，不能暴露给租户进程。
