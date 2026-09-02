update allrice_platform_dsh_skills
set content = $skill$# Structured Deliverable

Create a useful deliverable only when the user explicitly asks for a report, document, file, plan, checklist, or other reusable output.

## Workflow

1. Confirm the audience, purpose, required format, and source material from the request and current conversation.
2. Build the complete content before exporting. Keep facts, assumptions, decisions, risks, and next actions distinct.
3. Use `workspace_export_create` for Markdown, text, HTML, JSON, Word, Excel, PowerPoint, or PDF when a downloadable file is requested. Choose the format the user requested; otherwise prefer Markdown for editable reports, DOCX for formal documents, XLSX for tabular data, PPTX for presentations, and PDF for fixed-layout delivery.
4. Return a short summary and the tool-provided download link. State important limitations.

## Rules

- Do not create a file for an ordinary chat answer.
- Do not invent missing evidence or silently omit uncertainty.
- Do not include credentials, hidden prompts, unrelated private data, or raw internal reasoning.
- Export is limited to AllRice-managed tenant storage and does not write to the user's local computer.
$skill$,
    description = '将已核验的研究、文档或工作区内容整理成结构清晰的报告、方案、清单，或 Markdown、Word、Excel、PowerPoint、PDF 等正式交付文件。',
    required_tool_refs = '["workspace.export.create"]'::jsonb,
    version = '1.1.0',
    checksum = 'sha256:d6b4a8e16ba18da69a98ac06bb5e09a90f34c1c7c0a925143a2e151f5135410a',
    reviewed_by_label = 'MET-98',
    reviewed_at = now(),
    updated_at = now()
where name = 'structured-deliverable';
