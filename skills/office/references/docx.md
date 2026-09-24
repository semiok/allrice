# Word documents

Adapted from DeepSeek Harness Office DOCX guidance; source and MIT notice are in `references/provenance.md` and `references/LICENSE.dsh` in this bundle.

## Available workflow

- Read a source DOCX with `workspace_document_read`; extracted text does not preserve the original document model.
- For a new DOCX, call `workspace_export_create` with `format: "docx"` and complete text. Prefix heading lines with `#`, `##` or `###` to produce Word heading styles. Other lines become editable paragraphs.
- Include a clear title, purpose, source-backed sections and a concise conclusion or action list. Review names, dates, units and Chinese punctuation before export.
- The current generator does not turn Markdown pipe tables into native Word tables. Do not promise complex tables, embedded media, page numbering or template fidelity through this text input.
- For a revised generated artifact, use `parentObjectId` and `changeSummary`. This preserves version history, not the source file's binary formatting.

## Principles for richer editing

Upstream recommends inspecting paragraphs/runs, tables, sections, headers and footers before editing an existing document. Targeted run changes preserve formatting better than replacing whole paragraphs. Heading styles and East Asian font settings matter for Chinese documents. Track changes, fields and unsupported features must not be silently discarded.

Those principles guide subsequent AllRice editing support. The current tools cannot inspect all those structures or render Word pages; do not report template preservation or visual verification based only on extracted text and a successful export.
