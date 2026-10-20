# Automation

> Status: **Native once and recurring task management implemented behind explicit deployment flags; legacy consumers retained pending migration.**

AllRice 的自动化参考飞书智能伙伴的“触发器 + 技能/工作流 + 执行记录”模型，但复用 AllRice 已有的 Employee、Run、Job、Worker 和权限快照。

## 一次性任务（MET192）

当前对话顶部的时钟入口可以创建、查看和取消尚未执行的一次性任务。列表只包含当前真人员工在当前工作区、当前 AI 员工名下的任务；点击记录回到它绑定的原对话。结果使用既有 Run、聊天消息和成果展示。表单使用浏览器时区并将 UTC 时刻与 IANA 时区一起保存。

聊天中的 `automation.create(name, prompt, delayMinutes)` 和页面入口采用相同的权限与持久化规则。工具调用还必须来自真实租约下的当前员工 Run，且其冻结快照包含该工具。延迟时刻只在首次提交时计算，重读同一请求不会把时间推后。创建请求结果未知时，页面保留请求标识并精确回读，不自动再建一个任务。

聊天工具在一次性任务开关、冻结工具和能力均通过时对普通轮次可见，不依赖路由关键词或 `autonomous` 策略。实际写入仍在事务内检查当前真人消息：支持明确的单次整数分钟／小时／天延迟，时间须与工具参数一致；不确定、询问、引用示例、条件和周期请求须先澄清。任务保存真人原文，模型改写的 `prompt` 不能替换执行内容。到时消息说明原文相对时间以创建时刻为参照、现在已到期；自动、文件夹、工作流及平台内部来源不能借 user 消息再次预约。旧调度消息使用持久 occurrence ID，覆盖 Run 尚未回填的来源窗口。

一次性路径复用当前批准执行包的 DSH 公共 Host、Schedule、Workspace 和 Session API。DSH 原生定时器产生持久化回执后，AllRice 在一个 SQL 事务内创建普通聊天消息、冻结执行快照、Run、Job 和回执绑定。原生控制 Session 只管理时间，不执行模型或业务工具；业务执行继续使用普通员工链路。旧 SQL 到期扫描明确排除这些已登记任务。

创建、触发、开始执行和续租均核对当前成员、云端执行开关、员工配发及对话权限。取消在入队前获胜时不生成业务 Run；已经排队或执行的任务使用原对话的停止操作。数据库保存唯一回执、不可变历史及提交时租约校验，未知提交结果先读取同一业务绑定。

### 部署与恢复

- 先应用 `0195_native_schedule_once.sql`。Web 与 Worker 同时设置 `ALLRICE_NATIVE_ONCE_ENABLED=1` 和 `ALLRICE_NATIVE_ONCE_REFERENCE`，后者是精确的 `artifactId/profileId/storageId/stateRoot` 四项引用；缺省关闭。
- 引用的执行包必须已批准，包含 `native-schedule-host-factory.mjs`。使用独立持久化绝对目录，不能回退到当前包、临时目录或任意模块 URL。新增控制引用也参与执行包保留检查。
- Worker 维护或退出时停止原生 Schedule、关闭 Host、排空两个持久化后端后才写关闭证明。下一进程凭同一引用和明确关闭证明恢复；只有租约过期、没有关闭证明时不会抢占旧 writer。
- 健康检查暴露原生调度初始化/关闭故障。该路径失败不应饿死既有自动化或参考资料处理。运行中分区不能静默切换执行包或存储目录。
- 新包上线还需保留已有最终交付协议批准；不能因为控制 Host 获批就推断业务交付协议也已验收。

### 回归入口

普通 `pnpm test` 覆盖状态、控制器、参数、运行时和持久化端口；CI 另外在真实 Chrome 中验证 `once-tasks.browser.test.ts`，在隔离 PostgreSQL 中验证 `native-schedule-once.integration.test.ts` 与 `native-schedule-once-sql.integration.test.ts`。后者实际启动公共 Host、重启恢复原生任务并入队一个普通 Run，不调用模型。真实 Dev 页面、自然语言创建和到时模型交付必须另行验证，不能以这些确定性检查代替。

## 周期任务（MET192）

同一个时钟入口增加“周期任务”，先提供固定间隔（至少一分钟）和每日指定时间／IANA 时区。任务绑定当前对话；每一期使用普通员工 Run，执行记录可打开原对话。时间计算、时区及夏令时行为由批准包的 DSH Schedule 公共接口负责，没有增加 SQL 到期时钟或业务 Agent。

- 创建后等待原生任务确认；编辑保留原 Task 和控制 Session，配置版本不可改写。每个到期回执绑定实际生效的配置，旧配置回执不会执行新版内容。
- 暂停、编辑和删除会阻止尚未入队的旧回执；已排队或运行的工作仍通过原对话停止。恢复只接收恢复时刻之后的周期，不补发暂停期间积压任务。
- 操作使用版本检查与固定请求标识。未知写入先精确回读原请求和结果；页面关闭、切换账号或隐藏后不会继续后台轮询，也不会自动重发写入。
- 删除保留设置版本和逐期历史。当前云端权限、成员和配发在修改、派发及执行准入时重新校验，历史不会因为撤权或删除而改成成功。

### 部署与回归

先应用 `0196_native_schedule_recurring.sql`；Web/Worker 同时显式启用 `ALLRICE_NATIVE_RECURRING_ENABLED=1`，配置 `ALLRICE_NATIVE_RECURRING_REFERENCE` 的批准包 ID、`allrice-recurring-control-v1`、独立 storage ID 和持久目录。原一次性分区保持自己的精确引用，不能跟随新包静默重指向。新控制分区与一次性复用 writer 租约、工作区持久化和双后端关闭证明，重启仍需原引用和明确关闭证明。

默认测试覆盖契约、控制器、状态及接口。CI 追加 `recurring-tasks.browser.test.ts` 的真实 Chrome 管理流程，以及 `native-schedule-recurring.integration.test.ts` 的隔离 PostgreSQL 事务与权限检查。Worker 的同名 integration 文件使用实际公开 Host，验证固定间隔到期、同任务改为 daily、两期入队、关闭后新 epoch 恢复和保留删除历史，全程不调用模型。真实 Dev 的创建、模型结果、管理和隔离另行验收。

这一步只新增上述表单管理流程。自然语言周期创建、原有普通自动化、经验整理、质量任务等消费者迁移继续按独立切片推进；旧消费者没有被改成新时钟所有者。

## 原有自动化能力（逐步迁移）

- 创建每日或每周自动化任务；
- Rice 在对话中识别“十分钟后提醒我喝水”这类明确的未来任务，并调用 `automation.create` 自动创建一次性提醒；
- 一次性提醒默认绑定当前对话，执行时把提醒消息写回原对话；
- 配置任务提示词、执行时间和时区（默认 `Asia/Shanghai`）；
- 启用、暂停和立即运行；
- Worker 调度到期任务，并通过现有 Rice 执行链入队；
- 每次执行可以新建独立私有对话，或延续自动化绑定的固定对话；
- 自动化运行关联真实 `Run`，保留队列状态、失败信息和完成时间；
- 页面展示下一次执行、上次执行和最近状态，并可打开最近生成的对话。

## 对话创建链路

```text
用户自然语言
  -> Rice 判断是否是明确的未来任务
  -> automation.create(name, prompt, delayMinutes)
  -> 一次性 Automation（绑定当前 session）
  -> Worker 到期调度
  -> 原对话追加提醒消息并执行 Rice
```

`automation.create` 只授予 Rice 当前工作区的 `automation:write` 能力，并将延迟限制在 1 分钟到 365 天之间。没有明确的提醒或未来执行意图时，Rice 不应调用该工具。

## 页面/调度运行链路

```text
Automation
  -> Worker scheduler
  -> AutomationRun
  -> private chat session/message (new or reused)
  -> existing Employee Run / Job
  -> Codex worker
  -> Run state sync back to AutomationRun
```

自动化不直接实现第二套 AI 执行器。它只负责“什么时候启动”和“启动时传入什么任务”，实际权限、技能、重试、租约、取消和事件流继续由既有执行平面负责。

默认使用“每次执行新建对话”。这可以让日报、周报和监控任务的每次结果彼此隔离；需要持续跟踪同一项目时，再选择“延续固定对话”。两种模式都会把 `sessionId` 写入自动化运行记录，保证任务结果可以回到工作区继续对话。

## 为什么先实现定时触发

定时触发是最小但完整的垂直切片：能够验证持久化、调度、幂等、权限、Worker 重启恢复和结果追踪。Webhook、飞书事件和多步骤节点可以在这个模型上继续扩展，而不需要改动执行器。

## 下一步建议

1. 增加 Webhook 触发器，并为外部请求提供签名和幂等键；
2. 增加工作区事件触发器，例如文件上传、记忆新增和会话完成；
3. 把提示词升级为结构化 Workflow，加入条件分支、人工确认和动作节点；
4. 增加自动化运行详情页，直接跳转到关联 Run 的事件时间线；
5. 增加失败通知、重试策略和执行耗用统计。
