-- MET-98 P1: immutable deliverable objects grouped into an explicit version
-- lineage. Each generated file remains independently downloadable.

create table allrice_deliverable_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  object_id uuid not null,
  series_id uuid not null,
  version integer not null check (version > 0),
  parent_version_id uuid references allrice_deliverable_versions(id),
  session_id uuid,
  platform_test_run_id uuid references allrice_platform_employee_test_runs(id),
  file_name text not null check (char_length(file_name) between 1 and 255),
  format text not null check (format in (
    'markdown', 'text', 'html', 'json', 'docx', 'xlsx', 'pptx', 'pdf'
  )),
  change_summary text check (
    change_summary is null or char_length(change_summary) <= 2000
  ),
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, object_id)
    references allrice_storage_objects(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, session_id)
    references allrice_chat_sessions(organization_id, workspace_id, id),
  unique (object_id),
  unique (series_id, version),
  unique (organization_id, workspace_id, id),
  check ((session_id is null) <> (platform_test_run_id is null)),
  check (
    (version = 1 and parent_version_id is null)
    or (version > 1 and parent_version_id is not null)
  )
);

create index allrice_deliverable_versions_lineage
  on allrice_deliverable_versions (
    organization_id, workspace_id, series_id, version desc
  );

create index allrice_deliverable_versions_owner_activity
  on allrice_deliverable_versions (
    organization_id, workspace_id, owner_id, created_at desc
  );

update allrice_platform_dsh_skills
set content = $skill$# Structured Deliverable

Create a useful deliverable only when the user explicitly asks for a report, document, file, plan, checklist, or other reusable output.

## Workflow

1. Confirm the audience, purpose, required format, and source material from the request and current conversation.
2. Build the complete content before exporting. Keep facts, assumptions, decisions, risks, and next actions distinct.
3. Use `workspace_export_create` for Markdown, text, HTML, JSON, Word, Excel, PowerPoint, or PDF when a downloadable file is requested. Choose the format the user requested; otherwise prefer Markdown for editable reports, DOCX for formal documents, XLSX for tabular data, PPTX for presentations, and PDF for fixed-layout delivery.
4. When revising an earlier generated file, pass its `objectId` as `parentObjectId` and state the material changes in `changeSummary`. Do not overwrite or silently replace the earlier version.
5. Return a short summary, version number, and the tool-provided download link. State important limitations.

## Rules

- Do not create a file for an ordinary chat answer.
- Do not invent missing evidence or silently omit uncertainty.
- Do not include credentials, hidden prompts, unrelated private data, or raw internal reasoning.
- Export is limited to AllRice-managed tenant storage and does not write to the user's local computer.
$skill$,
    version = '1.2.0',
    checksum = 'sha256:e91ed50e40195ee9686ccae51dde13fc5e48bfd4c068245196000685f5522d01',
    required_tool_refs = '["workspace.export.create"]'::jsonb,
    reviewed_by_label = 'MET-98',
    reviewed_at = now(),
    updated_at = now()
where name = 'structured-deliverable';

insert into allrice_runtime_metadata (key, value)
values (
  'deliverable-version-schema',
  '{"version":"0063","storage":"immutable-objects","lineage":"series-parent-version","visibility":"tenant-owner","skill":"structured-deliverable@1.2.0"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
