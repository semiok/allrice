-- MET194 P2-P5: private instance-scoped business progress. Content bytes remain
-- in the existing immutable deliverable/storage system. No model/cron service.
create table allrice_brand_content_brands (
  id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null,
  instance_id uuid not null,
  name text not null check(char_length(name) between 1 and 160),
  revision integer not null check(revision>0),
  current_context_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,workspace_id,owner_id,instance_id)
    references allrice_employee_instances(organization_id,workspace_id,owner_id,id),
  unique(organization_id,workspace_id,owner_id,instance_id,id)
);
create table allrice_brand_content_contexts (
  id uuid primary key,
  organization_id uuid not null, workspace_id uuid not null,
  owner_id uuid not null, instance_id uuid not null, brand_id uuid not null,
  number integer not null check(number>0),
  brand_name text not null check(char_length(brand_name) between 1 and 160),
  content jsonb not null check(jsonb_typeof(content)='object'),
  digest text not null check(digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id)
    references allrice_brand_content_brands(organization_id,workspace_id,owner_id,instance_id,id),
  unique(brand_id,number),
  unique(organization_id,workspace_id,owner_id,instance_id,brand_id,id)
);
alter table allrice_brand_content_brands add foreign key
  (organization_id,workspace_id,owner_id,instance_id,id,current_context_id)
  references allrice_brand_content_contexts(organization_id,workspace_id,owner_id,instance_id,brand_id,id)
  deferrable initially deferred;
create table allrice_brand_content_batches (
  id uuid primary key,
  organization_id uuid not null, workspace_id uuid not null,
  owner_id uuid not null, instance_id uuid not null, brand_id uuid not null,
  context_id uuid not null, platform text not null check(char_length(platform) between 1 and 80),
  revision integer not null default 1 check(revision>0),
  workflow jsonb check(workflow is null or jsonb_typeof(workflow)='object'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id,context_id)
    references allrice_brand_content_contexts(organization_id,workspace_id,owner_id,instance_id,brand_id,id),
  unique(organization_id,workspace_id,owner_id,instance_id,brand_id,id)
);
create table allrice_brand_content_topics (
  id uuid primary key,
  organization_id uuid not null, workspace_id uuid not null,
  owner_id uuid not null, instance_id uuid not null, brand_id uuid not null,
  context_id uuid not null, platform text not null,
  title_key text not null check(char_length(title_key) between 1 and 240),
  candidate jsonb not null check(jsonb_typeof(candidate)='object'),
  state text not null default 'candidate' check(state in ('candidate','accepted','rejected')),
  revision integer not null default 1 check(revision>0),
  decision_reason text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id,context_id)
    references allrice_brand_content_contexts(organization_id,workspace_id,owner_id,instance_id,brand_id,id),
  unique(brand_id,context_id,platform,title_key),
  unique(organization_id,workspace_id,owner_id,instance_id,brand_id,id)
);
create table allrice_brand_content_batch_topics (
  organization_id uuid not null, workspace_id uuid not null,
  owner_id uuid not null, instance_id uuid not null, brand_id uuid not null,
  batch_id uuid not null, topic_id uuid not null,
  primary key(batch_id,topic_id),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id,batch_id)
    references allrice_brand_content_batches(organization_id,workspace_id,owner_id,instance_id,brand_id,id),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id,topic_id)
    references allrice_brand_content_topics(organization_id,workspace_id,owner_id,instance_id,brand_id,id)
);
create table allrice_brand_content_articles (
  id uuid primary key,
  organization_id uuid not null, workspace_id uuid not null,
  owner_id uuid not null, instance_id uuid not null, brand_id uuid not null,
  topic_id uuid not null, context_id uuid not null, session_id uuid not null,
  topic_revision integer not null check(topic_revision>0),
  platform text not null, revision integer not null default 1 check(revision>0),
  state text not null check(state in ('awaiting_review','changes_requested','approved')),
  current_bundle_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id,topic_id)
    references allrice_brand_content_topics(organization_id,workspace_id,owner_id,instance_id,brand_id,id),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id,context_id)
    references allrice_brand_content_contexts(organization_id,workspace_id,owner_id,instance_id,brand_id,id),
  foreign key(organization_id,workspace_id,session_id)
    references allrice_chat_sessions(organization_id,workspace_id,id),
  unique(topic_id),
  unique(organization_id,workspace_id,owner_id,instance_id,brand_id,id)
);
create table allrice_brand_content_bundles (
  id uuid primary key,
  organization_id uuid not null, workspace_id uuid not null,
  owner_id uuid not null, instance_id uuid not null, brand_id uuid not null,
  article_id uuid not null, number integer not null check(number>0),
  content jsonb not null check(jsonb_typeof(content)='object'),
  images jsonb not null check(jsonb_typeof(images)='array'),
  digest text not null check(digest ~ '^sha256:[a-f0-9]{64}$'),
  parent_bundle_id uuid, source_review_id uuid,
  change_summary text not null check(char_length(change_summary) between 1 and 2000),
  workflow jsonb check(workflow is null or jsonb_typeof(workflow)='object'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id,article_id)
    references allrice_brand_content_articles(organization_id,workspace_id,owner_id,instance_id,brand_id,id),
  unique(article_id,number),
  unique(organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,id)
);
alter table allrice_brand_content_bundles add foreign key
  (organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,parent_bundle_id)
  references allrice_brand_content_bundles(organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,id);
alter table allrice_brand_content_articles add foreign key
  (organization_id,workspace_id,owner_id,instance_id,brand_id,id,current_bundle_id)
  references allrice_brand_content_bundles(organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,id)
  deferrable initially deferred;
create table allrice_brand_content_reviews (
  id uuid primary key,
  organization_id uuid not null, workspace_id uuid not null,
  owner_id uuid not null, instance_id uuid not null, brand_id uuid not null,
  article_id uuid not null, bundle_id uuid not null,
  bundle_digest text not null check(bundle_digest ~ '^sha256:[a-f0-9]{64}$'),
  decision text not null check(decision in ('approved','rejected')),
  reason text not null check(char_length(reason) between 1 and 2000),
  decided_by uuid not null references allrice_users(id),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,bundle_id)
    references allrice_brand_content_bundles(organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,id),
  unique(bundle_id),
  unique(organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,id)
);
alter table allrice_brand_content_bundles add foreign key
  (organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,source_review_id)
  references allrice_brand_content_reviews(organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,id);
create table allrice_brand_content_plans (
  id uuid primary key,
  organization_id uuid not null, workspace_id uuid not null,
  owner_id uuid not null, instance_id uuid not null, brand_id uuid not null,
  article_id uuid not null, bundle_id uuid not null, review_id uuid not null,
  bundle_digest text not null check(bundle_digest ~ '^sha256:[a-f0-9]{64}$'),
  platform text not null, planned_at timestamptz not null, timezone text not null,
  publisher text not null, notes text not null default '',
  revision integer not null default 1 check(revision>0),
  state text not null default 'planned' check(state in ('planned','cancelled')),
  cancellation_reason text,
  reminder_status text not null default 'not_registered'
    check(reminder_status in ('not_registered','registered','reminded','failed','unknown')),
  automation_id uuid references allrice_automations(id),
  automation_run_id uuid references allrice_automation_runs(id),
  run_id uuid references allrice_runs(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,bundle_id)
    references allrice_brand_content_bundles(organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,id),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,review_id)
    references allrice_brand_content_reviews(organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,id),
  unique(organization_id,workspace_id,owner_id,instance_id,brand_id,id)
);
create unique index allrice_brand_content_plan_active
  on allrice_brand_content_plans(article_id,platform) where state='planned';
create unique index allrice_brand_content_plan_automation
  on allrice_brand_content_plans(automation_id) where automation_id is not null;
create table allrice_brand_content_receipts (
  id uuid primary key,
  organization_id uuid not null, workspace_id uuid not null,
  owner_id uuid not null, instance_id uuid not null, brand_id uuid not null,
  plan_id uuid not null unique,
  bundle_digest text not null check(bundle_digest ~ '^sha256:[a-f0-9]{64}$'),
  platform text not null, publisher text not null, published_url text not null,
  actual_published_at timestamptz not null,
  source_type text not null check(source_type in ('manual_confirmation','imported_public_record')),
  evidence text not null check(char_length(evidence) between 1 and 4000),
  evidence_files jsonb not null check(jsonb_typeof(evidence_files)='array'),
  recorded_by uuid not null references allrice_users(id),
  verification_state text not null default 'provided' check(verification_state='provided'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id,plan_id)
    references allrice_brand_content_plans(organization_id,workspace_id,owner_id,instance_id,brand_id,id)
);
create table allrice_brand_content_requests (
  organization_id uuid not null, workspace_id uuid not null,
  owner_id uuid not null, instance_id uuid not null,
  request_id text not null check(char_length(request_id) between 1 and 200),
  input_digest text not null check(input_digest ~ '^sha256:[a-f0-9]{64}$'),
  authority text not null check(authority in ('user','workflow','scheduler')),
  response jsonb not null check(jsonb_typeof(response)='object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(organization_id,workspace_id,owner_id,instance_id,request_id),
  foreign key(organization_id,workspace_id,owner_id,instance_id)
    references allrice_employee_instances(organization_id,workspace_id,owner_id,id)
);
create index allrice_brand_content_owner on allrice_brand_content_brands
  (organization_id,workspace_id,owner_id,instance_id,updated_at desc);
create function allrice_brand_content_immutable() returns trigger language plpgsql as $$
begin raise exception 'brand_content_record_immutable'; end $$;
create trigger allrice_brand_content_context_immutable before update or delete on allrice_brand_content_contexts
  for each row execute function allrice_brand_content_immutable();
create trigger allrice_brand_content_bundle_immutable before update or delete on allrice_brand_content_bundles
  for each row execute function allrice_brand_content_immutable();
create trigger allrice_brand_content_review_immutable before update or delete on allrice_brand_content_reviews
  for each row execute function allrice_brand_content_immutable();
create trigger allrice_brand_content_receipt_immutable before update or delete on allrice_brand_content_receipts
  for each row execute function allrice_brand_content_immutable();
create trigger allrice_brand_content_request_immutable before update or delete on allrice_brand_content_requests
  for each row execute function allrice_brand_content_immutable();
