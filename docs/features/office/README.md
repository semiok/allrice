# Office

Tracking: [MET-157](https://linear.app/metasnowsky/issue/MET-157), under the DSH Skill adaptation plan MET-156.

## Current delivery: unified Skill with generation and editing (PR2)

Administrators select **office** once to provide document reading, rich native Office generation and targeted source-file editing. Selecting it assembles `workspace.file.list`, `workspace.document.read`, `workspace.skill.read` and `workspace.export.create`. Save and publish through the existing employee workflow; no Office environment switch or separate Word/Excel/PowerPoint activation is required.

The Skill reads PDF, DOCX, XLSX, PPTX, Markdown, JSON, text and native image attachments using existing tools. It exports DOCX, XLSX, PPTX, PDF, Markdown, text, HTML and JSON to tenant storage. Existing artifact cards, download authorization and version history remain the delivery surface. Financial reconciliation continues to use its dedicated deterministic Skill and export path.

The Office bundle adapts the pinned DSH Office document, workbook and presentation guidance into three internal references. These references are not three selectable Skills. See [provenance, dependencies and modifications](../../../skills/office/references/provenance.md) and the preserved [MIT notice](../../../skills/office/references/LICENSE.dsh). All resources are included in the published frozen bundle and read with `workspace.skill.read`; model execution never resolves mutable upstream files.

The PPTX exporter uses PptxGenJS's declared CommonJS entry so both the `tsx` development loader and compiled Node receive its constructor. A child-process regression test generates and reads a Chinese PPTX through the real development loader; Vitest's module transformation alone did not expose this failure.

## Existing employees and sessions

`skills/catalog.json` declares `office.replaces` for `document-analysis` and `structured-deliverable`. Content synchronization retains their original rows, versions, checksums and source files, while disabling them for new selection. The administrator directory presents Office as their replacement. The catalog's replacement graph rejects missing, active, self-referencing and ambiguous sources.

Opening an employee for editing upgrades the editable definition and assembles Office dependencies. Saving an older API definition and compiling an existing unpublished draft also resolve the old IDs to one Office ID and add its tools. Explicit security denials in submitted definitions remain validation errors rather than being silently discarded. No employee is automatically published by content synchronization.

Published revisions, tenant EmployeeVersions, queued trials and existing Runs keep their frozen packages. Publishing the next draft applies Office to new sessions; existing sessions retain the previous employee version. Rollback selects the original immutable employee revision, including its old Skill IDs and exact content. The database integration suite verifies published/queued package preservation and rollback after catalog synchronization.

## Structured creation and template edits

`workspace.export.create` accepts exactly one of the existing `content` input or the new typed `office` input. Existing text/non-Office calls keep their behavior. The Office 1.1.0 frozen guides supply executable input shapes for:

- DOCX native tables, headings, lists, page breaks, headers and page-number footers.
- XLSX typed multisheet data, column formats, filters, frozen headers and explicit formula expressions. Formula caches cannot be supplied by the model.
- PPTX text, editable native tables, bar/line/pie charts with embedded workbooks, accent color and speaker notes.

For edits, `workspace.document.read(includeStructure=true)` supplies the original checksum and addressable paragraphs, actual presentation-order slides or worksheet cells/formulas. `office.kind=edit` takes that exact source plus bounded text-replacement/cell changes. The worker verifies read capability, scoped file access, source media type, metadata and actual bytes. The publisher rechecks source access/checksum under a database lock before registration and before returning an idempotent retry.

Editing copies the original OOXML package. Unchanged members preserve their uncompressed bytes. Word replacements span ordinary body/table runs while retaining surrounding styles; PowerPoint replacements use visible slide order while retaining media, layouts, charts and notes; Excel cell edits retain styles, formulas and other parts. Exact expected match counts prevent publishing ambiguous partial replacements. A generated source owned by this user in the current session continues its series; an uploaded/shared template starts a new series. An atomic `artifact.source` audit, keyed to the existing deliverable version, retains source object ID/checksum. Workbench's stored v1 provenance shape stays unchanged so a PR1 application rollback can still parse new artifacts. There is no new file library or overwrite path.

Excel worksheet formula caches and the calculation chain are invalidated and a full recalculation on open is requested. This is **not** formula evaluation, chart/pivot data refresh or numerical verification. Text replacement does not edit fields, headers/footers or chart data. Row insertion, slide reordering, macros, encryption, signatures and strict OOXML are outside this edit implementation; supported originals are copied without dropping unknown members. Input is bounded (20 MiB source, 64 MiB expanded package, 8 MiB per parsed XML, 1 million structured input characters, 8 MB published output).

The new XML dependency is pinned to `@xmldom/xmldom@0.9.12`; DTD/entity declarations, duplicate/unsafe ZIP paths and ambiguous input are rejected. All code executes within the existing worker, without adding host Shell or upstream Python execution.

## Validation and remaining acceptance

The Office regression suite uses real binaries with styled split Word runs and an embedded image, typed Excel cells and cross-sheet formulas, and reordered PowerPoint slides containing native charts, embedded data and notes. It checks unchanged ZIP members, text/data readback, cache invalidation, source checksums, read denial and malformed input. PostgreSQL coverage exercises version continuation, template sources, private/workspace denial, durable source audits, publication retries and reconstruction using a new database connection and storage adapter.

PR1's local synthetic files passed the pinned upstream `check_office.py` package/content checks. PR2 additionally checked six richer generated/edited packages with the upstream checker, including sheet/slide counts and text. Its XLSX text assertion excludes numeric cells; the worker readback separately verified edited numeric values and formula expressions. Neither constitutes tenant Dev acceptance or rendered visual inspection. The Python checker is not installed in the employee runtime.

**PR3 remains:** independent formula/numerical checks, rendered visual inspection, tenant-facing quality feedback and real Dev acceptance from upload through editing to downloaded XLSX/DOCX/PPTX. MET-157 stays open until these criteria are met. The shared console description reflects these limits.

## Deployment and rollback

Deploy the application and canonical content together, using `pnpm db:setup` / `pnpm content:sync`. No SQL migration, environment variable or Python runtime is required. Install the lockfile dependency with the application; Office bundle 1.1.0 is synchronized alongside it. Catalog synchronization persists replacement metadata atomically with the Skill updates. It is idempotent and does not rewrite employee history.

For PR2 rollback, restore the PR1 application and Office 1.0.0 catalog together and roll affected employees back to their previous published revision. Stored files, lineage and source audits remain readable. To undo the earlier legacy-entry migration entirely, restore the pre-Office application and catalog together. The old catalog re-enables the two legacy entries and removes replacement metadata. Because synchronization intentionally retains unmanaged content, the Office row may remain available after a code rollback; published Office employees require an explicit employee revision rollback when withdrawing that capability. Do not delete frozen content, historical bundle versions or source artifacts.
