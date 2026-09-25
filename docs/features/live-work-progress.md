# 逐秒计时与 DSH 阶段性回复

核对基线：DSH UI `0.1.7-rc.1`，源码 `46a7f68b0922371ce7144b668b90e377d8e799f4`；Allrice `codex/tenant-feedback-experience`。

## 总耗时

此前 `useInteractionStatus` 每两秒刷新，`WorkProcess` 直接显示快照中的 `wallMs`，因此出现两秒一跳。现在沿用已同步的 DSH `LIVE_RUN_CLOCK_INTERVAL_MS`（1000ms），仅在计时文本组件内刷新，用浏览器单调时钟在两次服务端快照之间推进显示。较迟到达的运行中快照不会让数字倒退；完成后采用服务端最终值，排队未开始时不计时。

等待期间总历时仍继续推进，活跃时间、等待时间、时限及费用仍以服务端账本为准。此次没有增加请求频率、模型调用或新的计时权威来源。Chromium 覆盖连续 17→18→19→20 秒、等待、迟到快照、终态停止和未开始排队。

## 阶段性文字回复：DSH 原生具备

[官方会话分组说明](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/client/ui-chat/src/client/conversation-nodes/README.md#reading-model) 明确描述「工具过程 G1 → 中间回复 → 工具过程 G2 → 最终答复」。运行期间过程可见；正常完成后可整体折叠过程和中间回复，最终答复保留。源码入口为 `conversation-nodes/assistant.ts`、`conversation-nodes/turn-process.ts`、`chat/TurnProcessNodeView.tsx`。

Allrice 当前接入情况：

- `dsh-adapter.ts` 处理 `assistant/chunk` 中的 `text-delta`，转成平台流式事件；`assistant/message` 更新完成文本。
- `chatflow-utils.ts` 的 `assistantDelta` 将同一 Run 的所有文字增量直接拼接；`chat-transcript.tsx` 在一个回复区渲染，工具步骤另放 `WorkProcess`。因此未保留原生中间回复与工具段交错的展示。
- 工具桥仍有少量 envelope 调用，要求该次回复只包含工具封包，不能简单在其中插入进度文案。原生工具路径没有这项封包限制。

建议后续优先复用官方会话节点分组/中间回复组件，补足平台事件到原生消息和步骤标识的适配；核对运行中、历史重放、重试、断线恢复的消息边界，避免重复拼接或中间内容被最终文本覆盖。保留已选定的中文工具摘要和无代码详情体验。员工提示词再要求长任务在有实质进展时简短汇报，不编造进度，不另外调用模型生成播报。DSH 支持这类输出并不保证所有模型和提示词都会自动按相同频率汇报。

本次只完成计时修复与阶段性输出调研，尚未改动阶段性回复的接入链路。
