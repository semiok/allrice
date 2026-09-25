# 逐秒计时与 DSH 阶段性回复

核对基线：DSH UI `0.1.7-rc.1`，源码 `46a7f68b0922371ce7144b668b90e377d8e799f4`；Allrice `codex/tenant-feedback-experience`。

## 总耗时

此前 `useInteractionStatus` 每两秒刷新，`WorkProcess` 直接显示快照中的 `wallMs`，因此出现两秒一跳。现在沿用已同步的 DSH `LIVE_RUN_CLOCK_INTERVAL_MS`（1000ms），仅在计时文本组件内刷新，用浏览器单调时钟在两次服务端快照之间推进显示。较迟到达的运行中快照不会让数字倒退；完成后采用服务端最终值，排队未开始时不计时。

等待期间总历时仍继续推进，活跃时间、等待时间、时限及费用仍以服务端账本为准。此次没有增加请求频率、模型调用或新的计时权威来源。Chromium 覆盖连续 17→18→19→20 秒、等待、迟到快照、终态停止和未开始排队。

## 阶段性文字回复：DSH 原生具备

[官方会话分组说明](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/client/ui-chat/src/client/conversation-nodes/README.md#reading-model) 明确描述「工具过程 G1 → 中间回复 → 工具过程 G2 → 最终答复」。运行期间过程可见；正常完成后可整体折叠过程和中间回复，最终答复保留。源码入口为 `conversation-nodes/assistant.ts`、`conversation-nodes/turn-process.ts`、`chat/TurnProcessNodeView.tsx`。

## Allrice 接入

用户可在「设置 → 个人偏好」开启流式输出以查看以下交错过程。默认采用统一输出，任务结束后展示最终答复；详见 [个人偏好](./personal-preferences.md)。

- 复用现有 DSH `DisclosureRow`、过程图标、`AssistantMarkdown`，按官方的「过程 → 中间回复 → 过程 → 最终答复」组织阅读。Allrice 仅适配事件，不复制 DSH 的会话宿主或再建执行引擎。
- DSH 适配层按原生 session / turn / step 区分公开回复，切换步骤时重置增量缓冲。`assistant/message` 校准这一段文字，也支持只返回完整消息的模型；`llm/retry` 只清除相应步骤的失败半段，保留此前的进展。
- 既有 `assistant.text.delta` 增加可选 `replyId` / `textMode`，最终回执带对应 `replyId`，批处理不跨回复或替换边界。沿用原有事件落库、SSE、断线恢复与历史接口，不新增表或请求。
- 执行时公开进展和中文工具摘要按时间顺序展开。正常完成后整体折叠过程，最终答复在外；失败或停止保留可见过程。总耗时仍只有一处，每个工具行不增加代码、参数、原始日志或耗时。
- 没有可靠分段信息的历史记录保留原有最终回复，不猜测、补造中间内容。隐藏推理仍只显示生命周期，旧工具 envelope 仍按原协议解析。
- 不增加模型调用，不自动生成播报，也不强制模型每调用一个工具都发消息。原生支持阶段性回复，不保证每个模型、每种任务都会主动生成。

验证覆盖：原生协议多步骤、消息校准、无增量完整消息、步骤间和步骤内重试、隐藏推理不泄漏、批处理边界、乱序重放、旧记录兼容，以及 Chromium 执行中交错显示、结束折叠、刷新恢复与最终答复不重复。

## DSH / Allrice 测试提示词

```text
请检查当前工作区的项目结构，并找出主要入口文件。只读取，不修改。
调用工具前，先正常回复一句你准备检查什么，再实际查看目录。
目录检查完后，当场报告一个具体发现，再调用工具读取入口文件。
读取后先报告确认了什么，最后给出总结。
进展说明必须在相应阶段当场发出，不要等任务结束再补写，也不要输出隐藏思考。
```

观察运行中的正文；完成后 DSH 会折叠中间过程，需要展开过程才能回看。
