-- MET167 PR1a. Platform-only references; no tenant membership or parallel Run history.
create table allrice_platform_technical_issues (
  id uuid primary key default gen_random_uuid(),
  environment text not null check (environment in ('dev','prod','test','unknown')),
  fingerprint text not null check (fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  title text not null check (length(title) between 1 and 160),
  category text not null default 'unknown' check (category in ('unknown','configuration','upstream','capacity','quality','defect')),
  severity text not null default 'medium' check (severity in ('low','medium','high')),
  status text not null default 'open' check (status in ('open','investigating','resolved','ignored')),
  occurrence_count integer not null default 1 check (occurrence_count > 0),
  version integer not null default 1 check (version > 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references allrice_users(id),
  updated_by uuid not null references allrice_users(id),
  linked_pr text,
  release_sha text check (release_sha is null or release_sha ~ '^[a-f0-9]{40}$'),
  unique (environment, fingerprint)
);
create index allrice_platform_technical_issues_updated on allrice_platform_technical_issues(updated_at desc, id);

create table allrice_platform_technical_evidence (
  source_kind text not null check (source_kind in ('run','operation','feedback')),
  source_id uuid not null,
  issue_id uuid not null references allrice_platform_technical_issues(id),
  record jsonb not null check (jsonb_typeof(record) = 'object'),
  observed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  recorded_by uuid not null references allrice_users(id),
  primary key (source_kind, source_id)
);
create index allrice_platform_technical_evidence_issue on allrice_platform_technical_evidence(issue_id, recorded_at desc);

create table allrice_platform_technical_issue_events (
  issue_id uuid not null references allrice_platform_technical_issues(id),
  version integer not null,
  actor_id uuid not null references allrice_users(id),
  action text not null check (action in ('created','evidence_linked','status_changed')),
  status text not null,
  category text not null,
  severity text not null,
  occurred_at timestamptz not null default now(),
  primary key (issue_id, version)
);
