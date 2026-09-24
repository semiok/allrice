# Office

Tracking: [MET-157](https://linear.app/metasnowsky/issue/MET-157), under the DSH Skill adaptation plan MET-156.

## Current delivery: DSH native Office workflow (1.3)

Select **office** once. The same four existing tools are assembled automatically; no additional Office toggle or separate Word/Excel/PowerPoint Skill is required. DSH's original format guides and `check_office.py` are reused unchanged, with Python's native document libraries for editing. Allrice supplies tenant files, an isolated execution environment, formula-cache updates, previews, downloads and version history.

`workspace_export_create.python` takes a Python script and optional input objects (`path`, `objectId`, `checksum`). Inputs appear under `/tmp/work/input`; the script writes `/tmp/work/output/result.<format>`. Set `sourceObjectId` when revising an input file. Each call has a fresh sandbox; intermediate files are temporary. The existing export pipeline checks scoped source access again during publication and never overwrites the source. Python output and upstream checker results are returned as `nativeExecution`; formula/render results remain in `quality`.

Use native python-docx/openpyxl/pandas/python-pptx features rather than adding operation enums. This supports the previously missing Word styles/header edits, Excel conditional formatting/charts, and PowerPoint chart changes/new slides/notes. Preserve document features according to the upstream library guidance; universal preservation is not claimed. Non-Office reading and text/PDF exports keep their existing paths.

See [the exact upstream version, licenses and adaptation boundary](../../../skills/office/references/provenance.md). The package is `@deepseek-ai/dsh-skill-office@0.1.7-alpha.2`; the runtime engine is unchanged. The three upstream guides are internal resources of one Skill. Original bytes are frozen in the bundle; tasks never fetch mutable upstream resources.

Latest native-workflow evidence: [native acceptance](native-validation.md). Earlier PR validation is historical.

## Existing employees and sessions

`skills/catalog.json` declares `office.replaces` for `document-analysis` and `structured-deliverable`. Content synchronization retains their original rows, versions, checksums and source files, while disabling them for new selection. The administrator directory presents Office as their replacement. The catalog's replacement graph rejects missing, active, self-referencing and ambiguous sources.

Opening an employee for editing upgrades the editable definition and assembles Office dependencies. Saving an older API definition and compiling an existing unpublished draft also resolve the old IDs to one Office ID and add its tools. Explicit security denials in submitted definitions remain validation errors rather than being silently discarded. No employee is automatically published by content synchronization.

Published revisions, tenant EmployeeVersions, queued trials and existing Runs keep their frozen packages. Publishing the next draft applies Office to new sessions; existing sessions retain the previous employee version. Rollback selects the original immutable employee revision, including its old Skill IDs and exact content. The database integration suite verifies published/queued package preservation and rollback after catalog synchronization.

## Legacy compatibility

The old typed `office` input and its fixed create/edit implementation remain only for already frozen Office 1.0–1.2 employee packages. Office 1.3 defaults to `python`; new development does not add typed document operations. Remove the compatibility handler when no published package or running task needs it. Historical stored files, downloads and versions do not require retaining the old editor.

## Validation

The Office regression suite uses real binaries with styled split Word runs and an embedded image, typed Excel cells and cross-sheet formulas, and reordered PowerPoint slides containing native charts, embedded data and notes. It checks unchanged ZIP members, text/data readback, cache invalidation, source checksums, read denial and malformed input. PostgreSQL coverage exercises version continuation, template sources, private/workspace denial, durable source audits, publication retries and reconstruction using a new database connection and storage adapter.

PR1's local synthetic files passed the pinned upstream `check_office.py` package/content checks. PR2 additionally checked six richer generated/edited packages with the upstream checker, including sheet/slide counts and text. Its XLSX text assertion excludes numeric cells; the worker readback separately verified edited numeric values and formula expressions. Neither constitutes tenant Dev acceptance or rendered visual inspection. The Python checker is not installed in the employee runtime.

PR3 adds real LibreOffice evaluation: tests independently expect `30*2=60`, a cross-sheet sum of 90, typed string/boolean values and detection of division by zero. Original worksheet styles and non-worksheet ZIP members remain intact. Real DOCX/XLSX/PPTX conversion and inherited network denial run in Compose CI. HTTP tests recheck access after conversion/cache retrieval. Browser tests cover pagination and formula errors. The real Dev workflow passed on 2026-09-24; see [Dev acceptance and exact evidence](dev-validation.md). MET-157 remains open until the three stacked PRs are merged.

## Calculation and page preview

`workspace.export.create` checks all DOCX/XLSX/PPTX outputs automatically, including the legacy `content` path. Its `quality` response distinguishes `checked` from `unavailable`, returns actual formula results/error counts and explicitly labels layout as rendered, not visually reviewed. Rendering failures preserve the downloadable file and return an actionable limitation. Numerical results are not a business reconciliation verdict. The tenant workbench renders PNG pages and shows the formula results; it does not execute Office, PDF, HTML or external resources in the browser.

Web uses the existing authorized artifact content route and verifies stored length/hash before calling the renderer, then reauthorizes before returning any result. Previews come from the selected immutable version. The renderer cache requires the complete input bytes, is keyed by format/SHA-256 and bounded to 16 entries / 64 MB / ten minutes. It is disposable, has no new database table or storage category, and regenerates after restart. There are no extra preview files in the tenant file list. Original files retain existing storage quota and version enforcement.

The service limits input to 8 MB, expanded OOXML to 64 MiB, formulas to 10,000, queueing plus conversion to a single 40-second deadline and preview to the first eight pages / 3 MB of PNG. Page limits and formula truncation are visible. Formula errors are retained as errors, never replaced with zero. Normal/shared formulas are supported; array/spill formula outputs, macros, signatures and linked external data are not processed. Time/random results can change when a preview recalculates, and LibreOffice pagination can differ from Microsoft Office. Rendered images require actual human/model inspection before claiming layout quality.

## Deployment and rollback

Deploy the application and canonical content together, using `pnpm db:setup` / `pnpm content:sync`. No SQL migration is required. Install the lockfile dependencies and start the Office renderer together with the application; development bootstrap compiles the shared contracts before starting plain Node DSH subprocesses; Office bundle 1.3.1 is synchronized alongside it. Catalog synchronization persists replacement metadata atomically with the Skill updates. It is idempotent and does not rewrite employee history.

For PR2 rollback, restore the PR1 application and Office 1.0.0 catalog together and roll affected employees back to their previous published revision. Stored files, lineage and source audits remain readable. To undo the earlier legacy-entry migration entirely, restore the pre-Office application and catalog together. The old catalog re-enables the two legacy entries and removes replacement metadata. Because synchronization intentionally retains unmanaged content, the Office row may remain available after a code rollback; published Office employees require an explicit employee revision rollback when withdrawing that capability. Do not delete frozen content, historical bundle versions or source artifacts.

Compose starts `office-renderer` by default on a private network; Web and Worker use `ALLRICE_OFFICE_RENDERER_URL=http://office-renderer:3112`. `pnpm dev` starts a loopback renderer at `127.0.0.1:3112` unless an existing private URL is configured. This setting selects infrastructure, not an enable flag. The image contains maintained Debian LibreOffice/UNO/Poppler/font packages; no tenant-side installation is needed. It runs as a non-root user with a read-only root, bounded tmpfs, no app credentials/volumes and no capabilities. Conversion subprocesses inherit a seccomp denial of IP sockets; UNO uses only a local pipe, macros are disabled and document updates are refused. Renderer restarts do not affect original files.

For PR3 rollback restore the PR2 application/catalog and previous employee revision; stop the renderer after removing its callers. Existing files, including genuine cached formula results, remain readable. There is no database rollback or preview-data migration.

## Native sandbox deployment

Build `infra/docker/Dockerfile.office-sandbox` for linux/amd64 in the existing dedicated `colima-allrice-cloud-b4` execution backend. The Worker pins the resulting image digest in `apps/worker/src/office/runtime.ts`. The existing gVisor runtime and independent watchdog must already be installed, as for cloud execution. This deployment currently uses that backend; merely starting the fixed Office renderer does not install a Python execution backend.

The image contains the pinned document libraries and the original checker, but no credentials or host mounts. Each export runs with no network and a read-only image, with temporary files, bounded memory and a 60-second execution deadline. Input total is 20 MB; published output is 8 MB, consistent with the existing Office file boundaries. The generic cloud command policy and its existing limits are unchanged. Managed Office export keeps the existing file tool authorization; administrators need not separately approve each temporary Python script.

Publish a new revision of an existing employee to freeze Office 1.3, then start a new session. Existing sessions retain their original frozen package. Roll back application/catalog/employee revision together. No schema migration is required.
