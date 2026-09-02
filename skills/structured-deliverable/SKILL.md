---
name: structured-deliverable
description: 将已核验的研究、文档或工作区内容整理成结构清晰的报告、方案、清单或可下载文件，同时保留来源、边界和未决事项。
---

# Structured Deliverable

Create a useful deliverable only when the user explicitly asks for a report, document, file, plan, checklist, or other reusable output.

## Workflow

1. Confirm the audience, purpose, required format, and source material from the request and current conversation.
2. Build the complete content before exporting. Keep facts, assumptions, decisions, risks, and next actions distinct.
3. Use `workspace_export_create` for Markdown, text, HTML, JSON, Word, Excel, PowerPoint, or PDF when a downloadable file is requested. Choose the format the user requested; otherwise prefer Markdown for editable reports, DOCX for formal documents, XLSX for tabular data, PPTX for presentations, and PDF for fixed-layout delivery.
4. When revising an earlier generated file, pass its `objectId` as `parentObjectId` and state the material changes in `changeSummary`. Do not overwrite or silently replace the earlier version.
5. Return a short summary, version number, and the tool-provided download link. State important limitations.

## Rules

- Do not create a file for an ordinary chat answer.
- Do not invent missing evidence or silently omit uncertainty.
- Do not include credentials, hidden prompts, unrelated private data, or raw internal reasoning.
- Export is limited to AllRice-managed tenant storage and does not write to the user's local computer.
