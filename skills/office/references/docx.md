# Word documents

Adapted from pinned DSH Office guidance; provenance and MIT notice are bundled alongside this resource.

## Create a native document

Use `workspace_export_create` with `format: "docx"` and `office` (omit `content`):

```json
{
  "kind": "docx",
  "title": "项目汇报",
  "header": "内部材料",
  "footer": "稻米公司",
  "blocks": [
    { "type": "heading", "text": "本月结果", "level": "1" },
    { "type": "paragraph", "text": "已核验的数据如下。" },
    {
      "type": "table",
      "headers": ["项目", "金额"],
      "rows": [["服务费", 1200]]
    },
    { "type": "bullets", "items": ["下月复核回款"] },
    { "type": "page-break" },
    { "type": "paragraph", "text": "数据来源与口径", "bold": true }
  ]
}
```

Tables are editable Word tables, headings use native styles, and the footer includes a page-number field. Use concise cells and source-backed values. Each table row must match its header width. For simple output, the existing `content` path still supports heading lines and paragraphs; Markdown pipe tables do not become Word tables through that path.

## Edit an existing document or template

Read `workspace_document_read` with `includeStructure: true`. Copy its `id` and `checksum` into `office.sourceObjectId` and `sourceChecksum`. Example `office` input:

```json
{
  "kind": "edit",
  "sourceObjectId": "<returned id>",
  "sourceChecksum": "<returned checksum>",
  "changes": [
    {
      "type": "replace-text",
      "find": "{{客户}}",
      "replace": "稻米公司",
      "expectedOccurrences": 1
    }
  ]
}
```

Matching spans text runs inside a paragraph, including table paragraphs; replacement inherits the first matching run's style. Original surrounding text keeps its runs. Set the exact expected match count from the read result; a mismatch fails without delivering a partially edited document. Do not guess the count after a truncated read.

Edits preserve untouched package members such as headers, footers, styles, images and relationships. This operation does not edit header/footer text, fields, comments, tracked deletions or page geometry. Do not use it to replace whole documents, add sections or claim all Word features are editable. Use structured creation for a new layout. A successful edit is not rendered page inspection.
