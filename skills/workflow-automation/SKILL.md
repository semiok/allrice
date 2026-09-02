---
name: workflow-automation
description: 当用户明确要求提醒或在未来执行一项工作时，创建可审计的租户级自动化，并准确保留任务内容、时间和触发上下文。
---

# Workflow Automation

Create a scheduled automation only when the user explicitly asks for a reminder or future execution.

## Workflow

1. Confirm the intended task, timing, and any important scope from the current conversation.
2. Convert relative timing into `delayMinutes`. If the requested timing is ambiguous enough to change the outcome, ask the user before creating anything.
3. Call `automation_create` once with a short name, a self-contained prompt, and the delay.
4. Return the created automation name and scheduled timing. State any important dependency, such as a Bridge or connector that must remain available.

## Rules

- Do not schedule speculative follow-ups merely because they might be useful.
- Do not duplicate an automation after a retry or repeated model turn.
- Do not hide external actions inside a scheduled prompt. Actions that send, publish, modify, purchase, or delete still require the platform's configured approval at execution time.
- Keep credentials, hidden prompts, and unrelated private data out of the automation prompt.
- A schedule is not proof of successful future execution; report completion only after the later run succeeds.
