# PowerPoint presentations

Adapted from pinned DSH Office guidance; provenance and MIT notice are bundled alongside this resource.

## Create native editable slides

Use `workspace_export_create` with `format: "pptx"` and `office` (omit `content`):

```json
{
  "kind": "pptx",
  "title": "月度汇报",
  "accentColor": "2563EB",
  "slides": [
    {
      "title": "本月结论",
      "body": ["收入稳步增长", "下月跟进回款"],
      "notes": "统计口径与来源"
    },
    {
      "title": "收入趋势",
      "chart": {
        "type": "bar",
        "labels": ["八月", "九月"],
        "series": [{ "name": "收入", "values": [12, 20] }]
      }
    },
    {
      "title": "区域明细",
      "table": {
        "headers": ["区域", "收入"],
        "rows": [
          ["华东", 12],
          ["华南", 8]
        ]
      }
    }
  ]
}
```

Create at most 50 slides. Choose body text, table or chart per slide; put supplementary detail in `notes` or another slide. Tables use native editable cells (at most 12 data rows and 8 columns per slide). Native bar/line/pie charts retain their editable embedded workbook. Every series must have one value per label; a pie chart has one series. Keep units, labels and sources explicit. Use short titles and compact cells; fit-to-box is not proof of readable layout.

The existing `content` path remains available for simple text slides headed by `#`/`##`.

## Revise text in a source presentation

Read `workspace_document_read` with `includeStructure: true`; slide labels follow presentation order, including reordered decks. Export `office.kind: "edit"` with the returned `sourceObjectId`, `sourceChecksum` and changes such as:

```json
[
  {
    "type": "replace-text",
    "slide": 2,
    "find": "旧标题",
    "replace": "收入趋势",
    "expectedOccurrences": 1
  }
]
```

Omit `slide` only when intentionally matching across the entire deck. Matching spans runs within a paragraph, including table cell text. An unexpected match count aborts the edit. Unchanged parts retain charts and embedded data, images, notes, layouts and relationships. This edits slide text; it does not edit chart values, reorder slides, modify SmartArt or change animation/layout. Create a new chart slide through structured generation when needed.

After publishing, return the real download link and version. Text readback and package preservation do not prove font availability, spacing, alignment or absence of overflow. The workbench now shows bounded PNG slide previews from an isolated renderer, retaining the original PPTX. Inspect those pages for text clipping and chart legibility; up to eight pages are shown, and remaining slides require download. The export quality status distinguishes rendering success from an actual visual review.
