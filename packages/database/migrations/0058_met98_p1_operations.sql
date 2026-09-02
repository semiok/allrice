-- MET-98 P1: governed memory, unified execution targets, managed browser
-- evidence and a replayable external-action ledger.

alter table allrice_memories
  drop constraint if exists allrice_memories_source_type_check;

alter table allrice_memories
  add constraint allrice_memories_source_type_check
    check (source_type in ('user', 'message', 'file', 'tool', 'connector')),
  add column revision integer not null default 1 check (revision > 0),
  add column trust_level text not null default 'user_confirmed'
    check (trust_level in (
      'user_confirmed', 'platform_verified', 'derived', 'untrusted_external'
    )),
  add column confidence numeric(4,3) not null default 1
    check (confidence between 0 and 1),
  add column source_label text not null default 'legacy memory',
  add column captured_at timestamptz not null default now(),
  add column expires_at timestamptz,
  add column last_verified_at timestamptz,
  add column supersedes_memory_id uuid references allrice_memories(id),
  add constraint allrice_memories_expiry_after_capture
    check (expires_at is null or expires_at > captured_at),
  add constraint allrice_memories_untrusted_not_verified
    check (
      trust_level <> 'untrusted_external' or last_verified_at is null
    );

create table allrice_memory_revisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  memory_id uuid not null,
  revision integer not null check (revision > 0),
  content text not null,
  trust_level text not null check (trust_level in (
    'user_confirmed', 'platform_verified', 'derived', 'untrusted_external'
  )),
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  expires_at timestamptz,
  reason text not null,
  changed_by uuid not null references allrice_users(id),
  changed_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, memory_id)
    references allrice_memories(organization_id, workspace_id, id),
  unique (memory_id, revision),
  unique (organization_id, workspace_id, id)
);

insert into allrice_memory_revisions (
  organization_id, workspace_id, memory_id, revision, content, trust_level,
  confidence, expires_at, reason, changed_by, changed_at
)
select organization_id, workspace_id, id, revision, content, trust_level,
       confidence, expires_at, 'MET-98 baseline', owner_id, created_at
from allrice_memories;

create index allrice_memories_governed_recall
  on allrice_memories (
    organization_id, workspace_id, employee_id, trust_level,
    confidence desc, updated_at desc
  ) where archived_at is null;

create table allrice_execution_targets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  target_key text not null check (
    target_key ~ '^[a-z0-9]+(?:[.-][a-z0-9]+)*$'
  ),
  kind text not null check (kind in ('cloud_sandbox', 'rice_bridge')),
  label text not null,
  state text not null default 'offline'
    check (state in ('online', 'degraded', 'offline', 'revoked')),
  capabilities jsonb not null check (jsonb_typeof(capabilities) = 'array'),
  concurrency_limit integer not null default 1
    check (concurrency_limit between 1 and 100),
  timeout_seconds integer not null default 900
    check (timeout_seconds between 1 and 86400),
  last_heartbeat_at timestamptz,
  unavailable_reason text,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  unique (organization_id, workspace_id, target_key),
  unique (organization_id, workspace_id, id)
);

create table allrice_managed_browser_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  run_id uuid not null,
  target_id uuid not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  start_url text not null,
  allowed_domains jsonb not null check (jsonb_typeof(allowed_domains) = 'array'),
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  error_code text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  foreign key (organization_id, workspace_id, run_id)
    references allrice_runs(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, target_id)
    references allrice_execution_targets(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, id)
);

create table allrice_external_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  run_id uuid not null,
  actor_id uuid not null references allrice_users(id),
  target_id uuid,
  connector_binding_id uuid,
  action text not null,
  risk text not null check (risk in (
    'managed_write', 'external_send', 'destructive', 'financial_or_legal'
  )),
  status text not null default 'pending_approval' check (status in (
    'pending_approval', 'approved', 'rejected', 'executing',
    'succeeded', 'failed', 'canceled'
  )),
  input_digest text not null check (input_digest ~ '^sha256:[a-f0-9]{64}$'),
  output_digest text check (
    output_digest is null or output_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  approval_id uuid references allrice_approval_requests(id),
  idempotency_key text not null,
  error_code text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  foreign key (organization_id, workspace_id, run_id)
    references allrice_runs(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, target_id)
    references allrice_execution_targets(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, connector_binding_id)
    references allrice_connector_bindings(organization_id, workspace_id, id),
  unique (organization_id, idempotency_key),
  unique (organization_id, workspace_id, id)
);

alter table allrice_connector_bindings
  add column health_state text not null default 'unknown'
    check (health_state in ('ready', 'degraded', 'offline', 'unknown')),
  add column last_health_check_at timestamptz,
  add column health_detail text;

create index allrice_execution_targets_health
  on allrice_execution_targets (
    organization_id, workspace_id, state, last_heartbeat_at desc
  );
create index allrice_browser_tasks_run
  on allrice_managed_browser_tasks (
    organization_id, workspace_id, run_id, created_at desc
  );
create index allrice_external_actions_audit
  on allrice_external_actions (
    organization_id, workspace_id, action, status, created_at desc
  );

update allrice_platform_dsh_skills
set content = replace(
      content,
      'Use `workspace_export_create` for Markdown, text, HTML, or JSON when a downloadable file is requested.',
      'Use `workspace_export_create` for Markdown, text, HTML, JSON, Word, Excel, PowerPoint, or PDF when a downloadable file is requested. Choose the format the user requested; otherwise prefer Markdown for editable reports, DOCX for formal documents, XLSX for tabular data, PPTX for presentations, and PDF for fixed-layout delivery.'
    ),
    description = '将已核验的研究、文档或工作区内容整理成结构清晰的报告、方案、清单，或 Markdown、Word、Excel、PowerPoint、PDF 等正式交付文件。',
    version = '1.1.0',
    checksum = 'sha256:d6b4a8e16ba18da69a98ac06bb5e09a90f34c1c7c0a925143a2e151f5135410a',
    reviewed_by_label = 'MET-98',
    reviewed_at = now(),
    updated_at = now()
where name = 'structured-deliverable';

insert into allrice_runtime_metadata (key, value)
values (
  'met98-p1-operations',
  '{"version":"0058","issue":"MET-98","memory":"versioned-provenance","executionTargets":["cloud_sandbox","rice_bridge"],"browser":"evidence-ledger","externalActions":"approval-and-idempotency"}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
