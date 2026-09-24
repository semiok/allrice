# Excel workbooks

Adapted from DeepSeek Harness Office XLSX guidance; source and MIT notice are in `references/provenance.md` and `references/LICENSE.dsh` in this bundle.

## Available workflow

- Read a source XLSX with `workspace_document_read` and retain worksheet names, cell labels and any truncation notice. A formula and its cached value are different evidence; a cache may be stale or absent.
- For a new XLSX, call `workspace_export_create` with `format: "xlsx"`. Set `content` to a JSON array of row objects. Keys become column headers; numbers and booleans retain their types. Example: `[{"项目":"服务费","数量":2,"单价":15,"金额":30}]`.
- Keep account numbers, document identifiers and values with leading zeroes as strings. Keep money units and precision explicit. Never replace missing data with invented zeroes.
- The current generator creates one worksheet with a header row. Plain text becomes line/value columns, so prefer JSON row objects for business tables.
- Formula objects supported by the writer are not a calculation engine. Do not invent cached results or claim recalculation. Use independently verified values when no actual formula calculation is available. Deterministic financial reconciliation stays in business-reconciliation and its dedicated export tool.
- Use `parentObjectId` and `changeSummary` for revisions of generated workbooks. This creates a new workbook version; it does not preserve source workbook styles, macros, charts or untouched sheets.

## Principles for richer editing

Upstream distinguishes formula-preserving workbook edits from dataframe round trips, which can lose workbook features. Read formula expressions and values separately, change only intended ranges, preserve types and verify totals independently. Structural validation does not prove formula accuracy. Never relabel legacy XLS, XLSB or macro-enabled files as XLSX or silently remove unsupported content.

These principles guide subsequent AllRice editing and calculation support; the current text reader/exporter cannot claim full workbook fidelity or rendered visual inspection.
