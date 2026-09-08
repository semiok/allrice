# P09-c：有限后台服务与非 PTY 输入

MET-124 / B3 第三个独立切片。复用 P05 的隔离命令、P03 账本与设备日志、P04 精确审批；不增加 Agent Loop，也不把 AskUser 当作进程 stdin。

## 实际可用范围

`local.process.execute.arguments.background` 明确服务期限、容器内 readiness 探针及输入限额。审批后，Worker 等到**真实探针就绪**才返回 `service_ready`，同一 Run 可以继续调用其他工具。原 Operation 保持 `running`，不是把“启动成功”伪装成“任务已经完成”。`local.process.status` / `local.process.stop` 只查询或停止同一活跃 Run 所属的进程；用户也可在原命令卡片看到状态、输入请求和停止按钮。

第一版最多每设备两个、同一 Run 一个后台服务，单个最多五分钟，且不能超过原 root/job 期限。前台命令的 `limits.timeoutMs` 不变；后台审批额外展示并绑定 `background.durationMs`。服务只属于原 Run，不跨 Run、会话恢复 generation 或人员继续运行。Run 结束/取消、授权撤销、断线失去租约、输出耗尽或硬截止会停止服务；这不是无人值守守护进程。

后台启动与诊断/依赖准备在本版互斥，避免把依赖安装、临时环境复用和后台生命周期同时扩权。支持固定镜像内 Node/npm 及明确 SHA 清单中的项目文件，不提供任意 Shell/PTY、主机挂载、个人环境、主机安装或自动扩大范围。

## Readiness 与端口

可信 Supervisor 在子进程启动前检查指定端口，再用固定容器 loopback TCP 或 HTTP 2xx 探针判断就绪；HTTP 不跟随重定向，响应正文不用于模型上下文。只看到 PID、普通日志中的 ready 文本或容器处于 Running 都不能判定就绪。启动超时和正常的 EADDRINUSE 端口冲突有不同退出原因；不会自动选择另一个未批准端口。

容器保持 `NetworkMode:none`、无 PortBindings、无主机文件挂载、固定镜像、只读 rootfs、受限临时目录、UID 1000 子进程和 cgroup 限额。**这里的就绪只表示隔离容器内部可达，不是本机/云端浏览器已经可以访问。** 页面明确标注仅容器内部，不生成误导性 localhost 链接；跨网络开发预览仍归 P23。

## 有限输入协议

只有配置 `stdin.mode: requests-v1` 的脚本可以通过专用 fd3 发出逐行 JSON：

```js
import fs from 'node:fs';
fs.writeSync(
  3,
  JSON.stringify({ type: 'input.request', prompt: '输入本次测试文字' }) + '\n',
);
```

可信 PID1 为请求补充随机 requestId、单调序号、最大字节数和不超过硬截止的失效时间。默认普通 stdout 提示、模型文本和 AskUser 都不产生输入授权。只允许一个待答请求；输入请求必须遵守最多 16 次、每次最多 4096 UTF-8 字节的审批范围。不支持任意 TTY 应用；需要完整终端交互时明确转人工，而不是偷偷开启 PTY。

网页仅让用户向当前明确请求提交文本或 EOF；没有模型自动填写 stdin 工具。文本按填写的确切字节投递（需要换行时在文本中包含换行），EOF 是独立的关闭输入操作。请求/输入都绑定进程、原 attempt、序号、失效时间和内容摘要，过期、冲突、错序以及关闭后的继续输入会被拒绝。UI 不应输入密钥；输入正文不进入模型工具结果和一般审计摘要。

Docker 的非 TTY attach 只连接可信 PID1 的控制 stdin；用户程序拿到的是另外的 pipe，无法把普通输出变成控制命令。控制帧有独立单调序号，续租不能超过服务器冻结的硬截止。fd3 提示先经过既有有界输出过滤，再进入设备日志和 SaaS。

## 持久化、断线和停止

PostgreSQL 继续管理 owner/Run/attempt/fence、审批、服务状态、绝对期限、输入意图和回执。0080 只增加关联表，不创建自动 Allow 策略、不启用任何租户能力。starting 事件持久化容器 ID 后才允许 Docker start；ready 事件独立于 Operation 终态。

设备日志复用原 SQLite 与持有跨提交的独占 OS 锁，新增有界 service_events/service_inputs。写 stdin **之前**先持久化 prepared；写入回执再变 delivered。重复 delivered 只重发证据；重复 prepared 表示管道副作用不确定，绝不重新写。delivered 只证明字节已写入管道，不证明应用已处理或业务成功。页面刷新和网络重试不能再次启动服务、延后硬期限或重放输入。

后台任务入队时，在原终态回执预留之外额外保守预留 1 MiB，覆盖 16 条最大输入（含 JSON 转义放大）、64 条有界事件及 SQLite 索引开销；普通文件/前台操作不增加此项预留。容量不足先拒绝新任务，不能挤占已运行任务的终态落盘空间。

正常执行每秒重检授权；Supervisor 的本地续租窗口最多五秒。Bridge 退出或断开控制通道后，容器会因租约消失停止。取消由可信进程/容器管理接口终止整个 PID namespace，包括仍存活的后代进程；只有核对准确容器 ID、attempt 标签、固定镜像与 Docker 已退出状态，才能记录 `stopped`。发送了 kill 但无法核实退出只记 unknown，不能声称全树已经停止。

停止原因按首次实际观察到的边界归因：已到冻结硬截止时，续租返回停止/过期、控制回执丢失，以及同一截止的 readiness/input 定时器均记 `timeout`；硬截止前已观察到的真实取消或租约丢失，不因后续日志排空/容器核验较晚而改写。可信 Supervisor 在硬截止后也不再验证或投递新的 renew/input。B3 发布目录复测发现并修正了该竞态，保留原 2 秒硬截止严格断言，另补 5 个真实 VM 边界场景及 2 个精确毫秒单测。

重新启动 Bridge 后不会接管并继续旧服务：先取得原 journal 独占锁，将旧执行记为 unknown，再核对/停止原容器、读取保留的有界日志并提交收口证据，不重启旧 attempt。迟到回执、设备令牌撤销或服务器不可达时，不能伪造 ACK；本地证据保留待核对。确认容器停止不等于确认所有输入已投递，未确认输入保持不重试。

服务事件有独立 Outbox：完成或 unknown 的本地服务在终态回执之前，通过 `deliveryOnly` 补交未确认事件。此请求仅归档有序事实，不续租、不返回 stdin、不初始化新服务，也不产生新的取消意图。迟到的 ready 不复活服务，也不能阻挡后续真实的 input_delivered；撤销设备令牌后仍保留本地证据，不绕过认证补报。

日志仍限审批的总字节数（最高 64 KiB）及有限帧数；达到限额明确以 output_limit 停止，不轮转成无限运行。数据库只收有序有界输出，完整终态证据先写本地 Outbox，再删除已确认停止的合成容器。

## 验证与发布边界

- `local-service-journal.test.ts`：真实 SQLite 文件关闭/重开、prepared 不重写、delivered 丢 ACK 后只重发证据、请求序号/期限与 ACK 范围。
- `local-service.integration.test.ts`：专用 VM 的真实 HTTP readiness、继续运行与取消、文本/EOF、输入过期、readiness 超时、硬截止、断线、输出限额、端口冲突，以及真实 Bridge owner 退出后的短租约停止和 journal 核对。
- `runtime-governed-bridge.integration.test.ts`：专用合成 PostgreSQL 中的批准、旧客户端过滤、事件防重、输入/ready 顺序、Run 结束、取消/过期和进程归属，以及可选的 PostgreSQL→HTTP→Bridge→真实 VM 纵向用例。
- 同一集成测试的 `ALLRICE_RUN_BROWSER_INTEGRATION=1` 用例：实际 Chrome 与真实合成 PG 后端，验证 390px 窄屏、独立进程输入卡、重复点击和丢 ACK 仍为同一输入意图、刷新恢复及停止意图不冒充终态。生产 cookie/Origin 门禁另由真实路由测试覆盖。

真实 VM 测试仅使用 `/Users/a123/.colima/allrice-b2/docker.sock`、固定已验证镜像和新建合成目录；数据库仅用专用 allrice_b2 与隔离 schema。首次 owner 退出测试发现测试子进程缺少源码 tsconfig 路径，修正测试启动方式后已真实跑通；不是跳过恢复测试或只靠 mock 证明崩溃一致性。

本切片验证记录：独立真实 VM 11/11；真实 PG→HTTP→Bridge→VM 联调组 7/7；最终 PG/Chrome 组 8/8；最终 contracts/SQLite/历史 journal/HTTP/工具清单回归共 34/34，包含最大转义输入后终态落盘与关闭重开。Bridge、database、web 类型检查及定向 lint/format 均通过。一次全仓测试发现静态工具清单仍按旧数量断言（1057 通过、205 跳过、1 失败），已修正并通过定向清单测试；此前生产构建通过，但不冒充最终合并版本验证，B3 合并后仍须重跑全仓测试/生产构建。

需服务端和新 Bridge 都明确开启 `ALLRICE_LOCAL_SERVICE_ENABLED=1`，并满足既有 ledger/policy/local-command 门禁。profile 和领取另要求 `background_services`，旧 Bridge 不领取后台载荷。默认关闭，现有配对、正式安装包和租户 Dev 权限不改变；当前真实平台证据仍只覆盖专用 Intel 环境，不声称 M 芯片已验证，也不等于 B3 已合并部署或 2.0 GA。

`.env.example` 与 `compose.yaml` 的 web/worker 均显式列出默认 `0` 的四个开关：`ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED`、`ALLRICE_RUNTIME_POLICY_ENABLED`、`ALLRICE_LOCAL_COMMAND_ENABLED`、`ALLRICE_LOCAL_SERVICE_ENABLED`。使用空 env 文件及合成签名值执行真实 `docker compose config`，确认两服务均解析为 `0`，未启动容器或读取真实 Dev 配置。`compose.dev.yaml` 仅包含数据库，没有需注入开关的 web/worker；本机 Bridge 是独立进程，仍需独立显式启用。
