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

## Local file organization proposals

When the user explicitly requests copying, moving or renaming files inside their selected Bridge folder, first inspect only the relevant files with `local_fs_list` and `survey: {mode: files, hash: true}`. Publish a `kind: changeset`, `format: json` proposal using `content: {operations: [...]}` encoded as JSON. Each operation contains `path`, `target`, `operation: copy|move|rename`, `source: {checksum, version, sizeBytes}` from that exact survey, and `expectedDestination: null`. Never invent hashes or versions, substitute a `local_file_inspect` version, or represent binary files as empty before/after text.

Keep sources and destinations inside the same selected root, at most32 operations, each file at most9000000 bytes and total at most128000000 bytes. Destination parents must already exist; request supported directory creation separately if needed. Existing destinations are conflicts, not permission to overwrite. Do not create overlapping paths, cycles, executable commands or permanent deletions.

The proposal and its review list do not change files. The user requests its application through the existing workbench. Distinguish confirmed files, conflicts, pending files and unknown outcomes; the batch is not atomic and must not be replayed after an uncertain effect. Restoration only offers inverse moves using the destination version recorded by the actual receipt. Copies remain, and changed destinations or newly occupied original paths require reconciliation.

## Export rules

- Do not create a file for an ordinary chat answer.
- Do not invent missing evidence or silently omit uncertainty.
- Do not include credentials, hidden prompts, unrelated private data, or raw internal reasoning.
- Export is limited to AllRice-managed tenant storage and does not write to the user's local computer.
