# Excel workbooks

Adapted from pinned DSH Office guidance; provenance and MIT notice are bundled alongside this resource.

## Create typed, formatted sheets

Use `workspace_export_create` with `format: "xlsx"` and `office` (omit `content`):

```json
{
  "kind": "xlsx",
  "sheets": [
    {
      "name": "明细",
      "columns": [
        { "header": "编号", "width": 18 },
        { "header": "金额", "numberFormat": "#,##0.00" },
        { "header": "含税金额", "numberFormat": "#,##0.00" }
      ],
      "rows": [["00123", 100, { "formula": "B2*1.06" }]]
    }
  ]
}
```

Up to ten sheets, each with one header row, frozen header, filter and column formats. Data begins at row 2. Sheet names must be unique; every row must match its columns. Numbers and booleans remain typed; identifiers and leading zeroes must remain strings. An explicit `{ "formula": "..." }` creates a formula; a string beginning with `=` remains text. The service does not accept model-provided formula caches. Its isolated calculator evaluates normal/shared formulas and writes actual cached results into the original package.

The legacy `content` path still accepts a JSON array of row objects for simple single-sheet output. Specialized business reconciliation continues to use its deterministic Skill and export tool.

## Edit workbook inputs without rebuilding the template

Read with `includeStructure: true` for exact sheet names, cell addresses, formula expressions and source checksum. Use `office.kind: "edit"`, returned `sourceObjectId`/`sourceChecksum`, and changes such as:

```json
[
  { "type": "set-cell", "sheet": "明细", "cell": "B2", "value": 120 },
  {
    "type": "set-cell",
    "sheet": "明细",
    "cell": "C2",
    "value": { "formula": "B2*1.06" }
  }
]
```

Only the selected cells change value; existing cell styles and untouched package parts remain. `null` clears a cell's content. Merged cells can only be changed at the top-left anchor; shared/array formulas cannot be partially overwritten. This does not insert/delete rows, rewrite tables or change charts.

All worksheet formula caches and the calculation chain are invalidated, and automatic full recalculation is requested on open. Formulas are preserved, including those on other sheets. The exporter then attempts real LibreOffice recalculation on a copy and patches only verified cell results back. Inspect `quality.status`, `formulaCount`, `formulaErrorCount` and `formulas`; fix error cells before claiming success. Array/spill formulas and external data are currently reported as unchecked, retaining a downloadable workbook for Excel/LibreOffice. Charts/pivots are not refreshed in the original package. Check source amounts and units separately; evaluated formulas are not a business audit. The workbench shows print-layout previews (first eight pages, bounded size); download to see all sheets. Time/random functions may change when previews recalculate. Never report stale cached numbers as new results, or rename XLS/XLSB/XLSM files as XLSX.
