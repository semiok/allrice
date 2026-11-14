# Office

### Generation and preview font parity

New reports use Noto Sans CJK SC (including explicit DOCX East Asian run fonts), and Noto Sans Mono CJK SC for code. Web and Worker images include the same Debian `fonts-noto-cjk=1:20220127+repack1-1` family used by managed Python, plus `fonts-dejavu-core=2.37-6` for existing reports. Their copyright notices are retained. DSH's native provider discovers these through its standard OS font catalog; AllRice does not replace the renderer or suppress missing-font diagnostics.

For a host-based deployment, provision these fonts in the service user's native font directory before starting Web/Worker (`~/Library/Fonts` on macOS, `~/.local/share/fonts` on Linux). The managed runtime's `NotoSansCJK-Regular.ttc` is SHA256 `b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a`. Retain the source package's copyright, and restart the native provider after changing the catalog. Verify actual Chinese headings, tables, code and `missingFonts` on the same delivered Office bytes. A downloaded source document's other fonts may still require its own installed family; fallback is not exact-font preservation.

Tracking: [MET-157](https://linear.app/metasnowsky/issue/MET-157), under the DSH Skill adaptation plan MET-156.

## Current delivery: DSH native Office workflow (1.3)

Select **office** once. The same four existing tools are assembled automatically; no additional Office toggle or separate Word/Excel/PowerPoint Skill is required. DSH's original format guides and `check_office.py` are reused unchanged, with Python's native document libraries for editing. Allrice supplies tenant files, an isolated execution environment, formula-cache updates, previews, downloads and version history.

`workspace_export_create.python` takes a Python script and optional input objects (`path`, `objectId`, `checksum`). Inputs appear under `/tmp/work/input`; the script writes `/tmp/work/output/result.<format>`. Set `sourceObjectId` when revising an input file. Each call has a fresh sandbox; intermediate files are temporary. The existing export pipeline checks scoped source access again during publication and never overwrites the source. Python output and upstream checker results are returned as `nativeExecution`; formula/render results remain in `quality`.

Use native python-docx/openpyxl/pandas/python-pptx features rather than adding operation enums. This supports the previously missing Word styles/header edits, Excel conditional formatting/charts, and PowerPoint chart changes/new slides/notes. Preserve document features according to the upstream library guidance; universal preservation is not claimed. Non-Office reading and text/PDF exports keep their existing paths.

See [the exact upstream version, licenses and adaptation boundary](../../../skills/office/references/provenance.md). The package is `@deepseek-ai/dsh-skill-office@0.1.7-alpha.2`; the runtime engine is unchanged. The three upstream guides are internal resources of one Skill. Original bytes are frozen in the bundle; tasks never fetch mutable upstream resources.

Latest native-workflow evidence: [native acceptance](native-validation.md). Earlier PR validation is historical.

## Current tools and catalog

Office uses the native `python` workflow; `content` exports and `officePdf` conversion remain available through the same authorized export tool. The retired typed `office` DSL, its fixed operation enums, `document-analysis` and `structured-deliverable` have been deleted under MET-223. The catalog no longer carries replacement metadata or upgrades old bindings. Old execution packages are not a supported compatibility target.

## Validation

The Office regression suite uses real binaries with styled split Word runs and an embedded image, typed Excel cells and cross-sheet formulas, and reordered PowerPoint slides containing native charts, embedded data and notes. It checks unchanged ZIP members, text/data readback, cache invalidation, source checksums, read denial and malformed input. PostgreSQL coverage exercises version continuation, template sources, private/workspace denial, durable source audits, publication retries and reconstruction using a new database connection and storage adapter.

PR1's local synthetic files passed the pinned upstream `check_office.py` package/content checks. PR2 additionally checked six richer generated/edited packages with the upstream checker, including sheet/slide counts and text. Its XLSX text assertion excludes numeric cells; the worker readback separately verified edited numeric values and formula expressions. Neither constitutes tenant Dev acceptance or rendered visual inspection. The Python checker is not installed in the employee runtime.

PR3 adds real LibreOffice evaluation: tests independently expect `30*2=60`, a cross-sheet sum of 90, typed string/boolean values and detection of division by zero. Original worksheet styles and non-worksheet ZIP members remain intact. Real DOCX/XLSX/PPTX conversion and inherited network denial run in Compose CI. HTTP tests recheck access after conversion/cache retrieval. Browser tests cover pagination and formula errors. The real Dev workflow passed on 2026-09-24; see [Dev acceptance and exact evidence](dev-validation.md). MET-157 remains open until the three stacked PRs are merged.

## Calculation and page preview

Current sidebar previews use the [native DSH document readers](native-preview.md):
Word/PowerPoint convert to PDF, spreadsheets use the native grid, and the selected
original version remains unchanged. The PNG rendering and formula checks below
describe the export-quality workflow and legacy preview payloads, not the current
sidebar limits.

`workspace.export.create` checks all DOCX/XLSX/PPTX outputs automatically, including the legacy `content` path. Its `quality` response distinguishes `checked` from `unavailable`, returns actual formula results/error counts and explicitly labels layout as rendered, not visually reviewed. Rendering failures preserve the downloadable file and return an actionable limitation. Numerical results are not a business reconciliation verdict. Historical PNG preview payloads remain readable.

### Final saved values and original publication receipts

XLSX exports now include `savedValues` for the exact final returned bytes. A bounded ZIP/XML inspection records numeric, boolean and string caches, missing/invalid/error caches, and unsupported formula/cache types. `inspection: incomplete` exposes only observed counts and a finite reason; it is never a claim that the workbook was fully checked. Cache presence proves neither freshness nor business correctness. The existing renderer is reused once; this inspection does not calculate formulas or rewrite the workbook. Local-only output is inspected locally without invoking the cloud renderer.

When quality checking fails, optional `diagnostic.stage/code` identifies local policy, transport, renderer, cache patching or cache inspection. It contains no raw exception, path or stderr. Existing explicit formula/render requirements continue to prevent publication when their required check is unavailable. A successful render is still not a visual or business-quality verdict.

Both export paths persist the same receipt against the immutable version, final object checksum and originating Run. Retrying the same publication returns its original receipt; a newly obtained inspection cannot upgrade missing or unavailable historical evidence. Old records without the new fields remain readable without invented defaults. Company inspection can display an original exact-version receipt for legacy files with unknown Run provenance; those records do not become proof of a current Run's completed delivery. Actual PostgreSQL regression is registered in CI at `apps/worker/test/office-receipt-publication.integration.test.ts`.

Web uses the existing authorized artifact content route and verifies stored length/hash before calling the renderer, then reauthorizes before returning any result. Previews come from the selected immutable version. The renderer cache requires the complete input bytes, is keyed by format/SHA-256 and bounded to 16 entries / 64 MB / ten minutes. It is disposable, has no new database table or storage category, and regenerates after restart. There are no extra preview files in the tenant file list. Original files retain existing storage quota and version enforcement.

The service limits input to 8 MB, expanded OOXML to 64 MiB, formulas to 10,000, queueing plus conversion to a single 40-second deadline and preview to the first eight pages / 3 MB of PNG. Page limits and formula truncation are visible. Formula errors are retained as errors, never replaced with zero. Normal/shared formulas are supported; array/spill formula outputs, macros, signatures and linked external data are not processed. Time/random results can change when a preview recalculates, and LibreOffice pagination can differ from Microsoft Office. Rendered images require actual human/model inspection before claiming layout quality.

## Deployment and rollback

Deploy application, migrations and canonical content together through the existing `db:prepare` path. MET-223 removes the retired directory records and method tables; an older application cannot run against the retired schema. Release rollback therefore requires the matching pre-migration database snapshot, not merely an old binary or catalog.

Compose starts `office-renderer` by default on a private network; Web and Worker use `ALLRICE_OFFICE_RENDERER_URL=http://office-renderer:3112`. `pnpm dev` starts a loopback renderer at `127.0.0.1:3112` unless an existing private URL is configured. This setting selects infrastructure, not an enable flag. The image contains maintained Debian LibreOffice/UNO/Poppler/font packages; no tenant-side installation is needed. It runs as a non-root user with a read-only root, bounded tmpfs, no app credentials/volumes and no capabilities. Conversion subprocesses inherit a seccomp denial of IP sockets; UNO uses only a local pipe, macros are disabled and document updates are refused. Renderer restarts do not affect original files.

## Native sandbox deployment

Build `infra/docker/Dockerfile.office-sandbox` for linux/amd64 in the existing dedicated `colima-allrice-cloud-b4` execution backend. The Worker pins the resulting image digest in `apps/worker/src/office/runtime.ts`. The existing gVisor runtime and independent watchdog must already be installed, as for cloud execution. This deployment currently uses that backend; merely starting the fixed Office renderer does not install a Python execution backend.

The image contains the pinned document libraries and the original checker, but no credentials or host mounts. Each export runs with no network and a read-only image, with temporary files, bounded memory and a 60-second execution deadline. Input total is 20 MB; published output is 8 MB, consistent with the existing Office file boundaries. The generic cloud command policy and its existing limits are unchanged. Managed Office export keeps the existing file tool authorization; administrators need not separately approve each temporary Python script.

Publish the current Office bundle through the existing reviewed employee publication path. Its file authorization, source checks and durable export receipts remain required.
