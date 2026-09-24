# Office

Tracking: [MET-157](https://linear.app/metasnowsky/issue/MET-157), under the DSH Skill adaptation plan MET-156.

## Current delivery: unified Skill (PR1)

Administrators select **office** once to provide document reading and basic file delivery. Selecting it assembles `workspace.file.list`, `workspace.document.read`, `workspace.skill.read` and `workspace.export.create`. Save and publish through the existing employee workflow; no Office environment switch or separate Word/Excel/PowerPoint activation is required.

The Skill reads PDF, DOCX, XLSX, PPTX, Markdown, JSON, text and native image attachments using existing tools. It exports DOCX, XLSX, PPTX, PDF, Markdown, text, HTML and JSON to tenant storage. Existing artifact cards, download authorization and version history remain the delivery surface. Financial reconciliation continues to use its dedicated deterministic Skill and export path.

The Office bundle adapts the pinned DSH Office document, workbook and presentation guidance into three internal references. These references are not three selectable Skills. See [provenance, dependencies and modifications](../../../skills/office/references/provenance.md) and the preserved [MIT notice](../../../skills/office/references/LICENSE.dsh). All resources are included in the published frozen bundle and read with `workspace.skill.read`; model execution never resolves mutable upstream files.

## Existing employees and sessions

`skills/catalog.json` declares `office.replaces` for `document-analysis` and `structured-deliverable`. Content synchronization retains their original rows, versions, checksums and source files, while disabling them for new selection. The administrator directory presents Office as their replacement. The catalog's replacement graph rejects missing, active, self-referencing and ambiguous sources.

Opening an employee for editing upgrades the editable definition and assembles Office dependencies. Saving an older API definition and compiling an existing unpublished draft also resolve the old IDs to one Office ID and add its tools. Explicit security denials in submitted definitions remain validation errors rather than being silently discarded. No employee is automatically published by content synchronization.

Published revisions, tenant EmployeeVersions, queued trials and existing Runs keep their frozen packages. Publishing the next draft applies Office to new sessions; existing sessions retain the previous employee version. Rollback selects the original immutable employee revision, including its old Skill IDs and exact content. The database integration suite verifies published/queued package preservation and rollback after catalog synchronization.

## What follows

- **PR2:** richer native Office generation, template handling and targeted binary edits. The current exporter rebuilds from text/row objects; `parentObjectId` means artifact version history, not preservation of an original binary's layout.
- **PR3:** structural and numerical checks, independent formula verification, rendered visual inspection and real Dev acceptance from upload to downloadable XLSX/DOCX/PPTX. A successful export alone does not prove layout quality or recalculation.

These gaps remain explicit in the Skill instructions and both consoles' shared capability description. Office is enabled in the source catalog by default; deployment and employee publication determine the actual tenant runtime state. MET-157 remains open until its editing, quality and Dev acceptance criteria are complete.

## Deployment and rollback

Deploy the application and canonical content together, using `pnpm db:setup` / `pnpm content:sync`. No SQL migration or new runtime dependency is required. Catalog synchronization persists replacement metadata atomically with the Skill updates. It is idempotent and does not rewrite employee history.

For rollback of new editing defaults, restore the previous application and catalog together. The old catalog re-enables the two legacy entries and removes replacement metadata. Because synchronization intentionally retains unmanaged content, the Office row may remain available after a code rollback; published Office employees require an explicit employee revision rollback when withdrawing that capability. Do not delete frozen content, historical bundle versions or source artifacts.
