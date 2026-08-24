# Automation

> Status: **M6 schedule-triggered and dialogue-created automation implemented**

AllRice 的自动化参考飞书智能伙伴的“触发器 + 技能/工作流 + 执行记录”模型，但复用 AllRice 已有的 Employee、Run、Job、Worker 和权限快照。

## 当前能力

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
