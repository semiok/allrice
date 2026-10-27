---
name: workflow-automation
description: 当用户明确要求提醒或在未来执行一项工作时，创建可审计的租户级自动化，并准确保留任务内容、时间和触发上下文。
---

# Workflow Automation

Create a scheduled automation only when the user explicitly asks for a reminder or future execution.

## Workflow

1. Confirm the intended task, timing, and any important scope from the current conversation.
2. Use the current tool schema: a one-time delay uses `delayMinutes`; a repeating interval uses `rule: {kind: "every", seconds: ...}`; a daily wall-clock time uses `rule: {kind: "daily", time: "HH:mm:ss", timezone: "Area/Location"}`. For example, every 2 minutes is 120 seconds. Ask only when the requested timing or work is unclear; do not invent a timezone.
3. Invoke the available `automation.create` capability once, using its exposed native function or Broker envelope and exact schema. Include a short name, a self-contained prompt, and the chosen timing. Do not substitute a one-time delay for a requested repeating rule.
4. Report the returned task identity and timing accurately. `preparing` means saved and awaiting scheduler confirmation; it is not proof that the task has run. State any important dependency, such as an AllRice 助手 or connector that must remain available. The task can be managed from the automation entry and linked to its original conversation.

## Rules

- Do not schedule speculative follow-ups merely because they might be useful.
- Do not duplicate an automation after a retry or repeated model turn.
- Do not hide external actions inside a scheduled prompt. Actions that send, publish, modify, purchase, or delete still require the platform's configured approval at execution time.
- Keep credentials, hidden prompts, and unrelated private data out of the automation prompt.
- A schedule is not proof of successful future execution; report completion only after the later run succeeds.
