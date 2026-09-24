# Office

Tracking: [MET-157](https://linear.app/metasnowsky/issue/MET-157), under the DSH Skill adaptation plan MET-156.

## Current delivery: unified Skill with generation, editing and quality feedback (PR3)

Administrators select **office** once to provide document reading, rich native Office generation and targeted source-file editing. Selecting it assembles `workspace.file.list`, `workspace.document.read`, `workspace.skill.read` and `workspace.export.create`. Save and publish through the existing employee workflow; no Office environment switch or separate Word/Excel/PowerPoint activation is required.

The Skill reads PDF, DOCX, XLSX, PPTX, Markdown, JSON, text and native image attachments using existing tools. Chat attachments now accept DOCX/XLSX/PPTX in both the composer picker and API contract, including generic browser MIME fallback. Macro-enabled formats remain unsupported. It exports DOCX, XLSX, PPTX, PDF, Markdown, text, HTML and JSON to tenant storage. Existing artifact cards, download authorization and version history remain the delivery surface. Financial reconciliation continues to use its dedicated deterministic Skill and export path.

The Office bundle adapts the pinned DSH Office document, workbook and presentation guidance into three internal references. These references are not three selectable Skills. See [provenance, dependencies and modifications](../../../skills/office/references/provenance.md) and the preserved [MIT notice](../../../skills/office/references/LICENSE.dsh). All resources are included in the published frozen bundle and read with `workspace.skill.read`; model execution never resolves mutable upstream files.

The PPTX exporter uses PptxGenJS's declared CommonJS entry so both the `tsx` development loader and compiled Node receive its constructor. A child-process regression test generates and reads a Chinese PPTX through the real development loader; Vitest's module transformation alone did not expose this failure.

## Existing employees and sessions

`skills/catalog.json` declares `office.replaces` for `document-analysis` and `structured-deliverable`. Content synchronization retains their original rows, versions, checksums and source files, while disabling them for new selection. The administrator directory presents Office as their replacement. The catalog's replacement graph rejects missing, active, self-referencing and ambiguous sources.

Opening an employee for editing upgrades the editable definition and assembles Office dependencies. Saving an older API definition and compiling an existing unpublished draft also resolve the old IDs to one Office ID and add its tools. Explicit security denials in submitted definitions remain validation errors rather than being silently discarded. No employee is automatically published by content synchronization.

Published revisions, tenant EmployeeVersions, queued trials and existing Runs keep their frozen packages. Publishing the next draft applies Office to new sessions; existing sessions retain the previous employee version. Rollback selects the original immutable employee revision, including its old Skill IDs and exact content. The database integration suite verifies published/queued package preservation and rollback after catalog synchronization.

## Structured creation and template edits

`workspace.export.create` accepts exactly one of the existing `content` input or the new typed `office` input. Existing text/non-Office calls keep their behavior. The Office 1.2.0 frozen guides supply executable input shapes for:

- DOCX native tables, headings, lists, page breaks, headers and page-number footers.
- XLSX typed multisheet data, column formats, filters, frozen headers and explicit formula expressions. Formula caches cannot be supplied by the model.
- PPTX text, editable native tables, bar/line/pie charts with embedded workbooks, accent color and speaker notes.

For edits, `workspace.document.read(includeStructure=true)` supplies the original checksum and addressable paragraphs, actual presentation-order slides or worksheet cells/formulas. `office.kind=edit` takes that exact source plus bounded text-replacement/cell changes. The worker verifies read capability, scoped file access, source media type, metadata and actual bytes. The publisher rechecks source access/checksum under a database lock before registration and before returning an idempotent retry.

Editing copies the original OOXML package. Unchanged members preserve their uncompressed bytes. Word replacements span ordinary body/table runs while retaining surrounding styles; PowerPoint replacements use visible slide order while retaining media, layouts, charts and notes; Excel cell edits retain styles, formulas and other parts. Exact expected match counts prevent publishing ambiguous partial replacements. A generated source owned by this user in the current session continues its series; an uploaded/shared template starts a new series. An atomic `artifact.source` audit, keyed to the existing deliverable version, retains source object ID/checksum. Workbench's stored v1 provenance shape stays unchanged so a PR1 application rollback can still parse new artifacts. There is no new file library or overwrite path.

Excel worksheet formula caches and the calculation chain are invalidated and a full recalculation on open is requested. The PR3 calculator then evaluates normal/shared formulas on an isolated copy and patches only computed caches back into the original package. Array/spill formulas remain explicitly unchecked. This does not refresh chart/pivot caches or verify business inputs. Text replacement does not edit fields, headers/footers or chart data. Row insertion, slide reordering, macros, encryption, signatures and strict OOXML are outside this edit implementation; supported originals are copied without dropping unknown members. Input is bounded (20 MiB source, 64 MiB expanded package, 8 MiB per parsed XML, 1 million structured input characters, 8 MB published output).

The new XML dependency is pinned to `@xmldom/xmldom@0.9.12`; DTD/entity declarations, duplicate/unsafe ZIP paths and ambiguous input are rejected. Creation and targeted editing execute in the existing worker. Recalculation/rendering use the fixed service described below; no host Shell or upstream Python executor is exposed.

## Validation

The Office regression suite uses real binaries with styled split Word runs and an embedded image, typed Excel cells and cross-sheet formulas, and reordered PowerPoint slides containing native charts, embedded data and notes. It checks unchanged ZIP members, text/data readback, cache invalidation, source checksums, read denial and malformed input. PostgreSQL coverage exercises version continuation, template sources, private/workspace denial, durable source audits, publication retries and reconstruction using a new database connection and storage adapter.

PR1's local synthetic files passed the pinned upstream `check_office.py` package/content checks. PR2 additionally checked six richer generated/edited packages with the upstream checker, including sheet/slide counts and text. Its XLSX text assertion excludes numeric cells; the worker readback separately verified edited numeric values and formula expressions. Neither constitutes tenant Dev acceptance or rendered visual inspection. The Python checker is not installed in the employee runtime.

PR3 adds real LibreOffice evaluation: tests independently expect `30*2=60`, a cross-sheet sum of 90, typed string/boolean values and detection of division by zero. Original worksheet styles and non-worksheet ZIP members remain intact. Real DOCX/XLSX/PPTX conversion and inherited network denial run in Compose CI. HTTP tests recheck access after conversion/cache retrieval. Browser tests cover pagination and formula errors. The real Dev workflow passed on 2026-09-24; see [Dev acceptance and exact evidence](dev-validation.md). MET-157 remains open until the three stacked PRs are merged.

## Calculation and page preview

`workspace.export.create` checks all DOCX/XLSX/PPTX outputs automatically, including the legacy `content` path. Its `quality` response distinguishes `checked` from `unavailable`, returns actual formula results/error counts and explicitly labels layout as rendered, not visually reviewed. Rendering failures preserve the downloadable file and return an actionable limitation. Numerical results are not a business reconciliation verdict. The tenant workbench renders PNG pages and shows the formula results; it does not execute Office, PDF, HTML or external resources in the browser.

Web uses the existing authorized artifact content route and verifies stored length/hash before calling the renderer, then reauthorizes before returning any result. Previews come from the selected immutable version. The renderer cache requires the complete input bytes, is keyed by format/SHA-256 and bounded to 16 entries / 64 MB / ten minutes. It is disposable, has no new database table or storage category, and regenerates after restart. There are no extra preview files in the tenant file list. Original files retain existing storage quota and version enforcement.

The service limits input to 8 MB, expanded OOXML to 64 MiB, formulas to 10,000, queueing plus conversion to a single 40-second deadline and preview to the first eight pages / 3 MB of PNG. Page limits and formula truncation are visible. Formula errors are retained as errors, never replaced with zero. Normal/shared formulas are supported; array/spill formula outputs, macros, signatures and linked external data are not processed. Time/random results can change when a preview recalculates, and LibreOffice pagination can differ from Microsoft Office. Rendered images require actual human/model inspection before claiming layout quality.

## Deployment and rollback

Deploy the application and canonical content together, using `pnpm db:setup` / `pnpm content:sync`. No SQL migration is required. Install the lockfile dependencies and start the Office renderer together with the application; development bootstrap compiles the shared contracts before starting plain Node DSH subprocesses; Office bundle 1.2.0 is synchronized alongside it. Catalog synchronization persists replacement metadata atomically with the Skill updates. It is idempotent and does not rewrite employee history.

For PR2 rollback, restore the PR1 application and Office 1.0.0 catalog together and roll affected employees back to their previous published revision. Stored files, lineage and source audits remain readable. To undo the earlier legacy-entry migration entirely, restore the pre-Office application and catalog together. The old catalog re-enables the two legacy entries and removes replacement metadata. Because synchronization intentionally retains unmanaged content, the Office row may remain available after a code rollback; published Office employees require an explicit employee revision rollback when withdrawing that capability. Do not delete frozen content, historical bundle versions or source artifacts.

Compose starts `office-renderer` by default on a private network; Web and Worker use `ALLRICE_OFFICE_RENDERER_URL=http://office-renderer:3112`. `pnpm dev` starts a loopback renderer at `127.0.0.1:3112` unless an existing private URL is configured. This setting selects infrastructure, not an enable flag. The image contains maintained Debian LibreOffice/UNO/Poppler/font packages; no tenant-side installation is needed. It runs as a non-root user with a read-only root, bounded tmpfs, no app credentials/volumes and no capabilities. Conversion subprocesses inherit a seccomp denial of IP sockets; UNO uses only a local pipe, macros are disabled and document updates are refused. Renderer restarts do not affect original files.

For PR3 rollback restore the PR2 application/catalog and previous employee revision; stop the renderer after removing its callers. Existing files, including genuine cached formula results, remain readable. There is no database rollback or preview-data migration.
