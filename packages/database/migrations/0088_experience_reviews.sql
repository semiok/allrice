-- P20 adds governance/provenance to existing Memory, not a second asset store.
create table allrice_experience_reviews (
  memory_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  client_request_id uuid not null,
  request_digest text not null check (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  run_id uuid not null,
  session_id uuid not null,
  message_id uuid not null,
  source_excerpt text not null check (length(source_excerpt) between 1 and 4000),
  source_digest text not null check (source_digest ~ '^sha256:[a-f0-9]{64}$'),
  proposed_digest text not null check (proposed_digest ~ '^sha256:[a-f0-9]{64}$'),
  requested_scope text not null check (requested_scope in ('private', 'workspace', 'platform')),
  share_acknowledged boolean not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references allrice_users(id),
  reviewed_at timestamptz,
  review_reason text,
  created_at timestamptz not null default now(),
  foreign key (organization_id,workspace_id,memory_id) references allrice_memories(organization_id,workspace_id,id),
  foreign key (organization_id,workspace_id,run_id) references allrice_runs(organization_id,workspace_id,id),
  foreign key (organization_id,workspace_id,session_id) references allrice_chat_sessions(organization_id,workspace_id,id),
  foreign key (organization_id,workspace_id,message_id) references allrice_messages(organization_id,workspace_id,id),
  unique (organization_id,workspace_id,owner_id,client_request_id),
  check (requested_scope='private' or share_acknowledged),
  check ((status='pending' and reviewed_by is null and reviewed_at is null and review_reason is null)
    or (status<>'pending' and reviewed_by is not null and reviewed_at is not null and length(review_reason) between 1 and 500))
);
create index allrice_experience_review_queue on allrice_experience_reviews(organization_id,workspace_id,status,created_at desc);
create function allrice_experience_origin_immutable() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' or (to_jsonb(new)-array['status','reviewed_by','reviewed_at','review_reason'])
     is distinct from (to_jsonb(old)-array['status','reviewed_by','reviewed_at','review_reason'])
     or old.status<>'pending' then
    raise exception 'experience origin and completed reviews are immutable';
  end if;
  return new;
end;
$$;
create trigger allrice_experience_origin_guard before update or delete on allrice_experience_reviews
for each row execute function allrice_experience_origin_immutable();
