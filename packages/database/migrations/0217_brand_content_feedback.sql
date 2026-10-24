-- MET194: immutable business evidence, with existing Memory review governance.
create table allrice_brand_content_feedback (
  id uuid primary key,
  organization_id uuid not null, workspace_id uuid not null,
  owner_id uuid not null, instance_id uuid not null, brand_id uuid not null,
  context_id uuid not null,
  content jsonb not null check(jsonb_typeof(content)='object'),
  digest text not null check(digest ~ '^sha256:[a-f0-9]{64}$'),
  publication_key text not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id,context_id)
    references allrice_brand_content_contexts(organization_id,workspace_id,owner_id,instance_id,brand_id,id),
  unique(brand_id,publication_key),
  unique(organization_id,workspace_id,owner_id,instance_id,brand_id,id)
);
create table allrice_brand_content_retrospectives (
  id uuid primary key,
  organization_id uuid not null, workspace_id uuid not null,
  owner_id uuid not null, instance_id uuid not null, brand_id uuid not null,
  context_id uuid not null, platform text not null, campaign_key text,
  feedback_ids uuid[] not null check(cardinality(feedback_ids) between 1 and 20),
  output jsonb not null check(jsonb_typeof(output)='object'),
  source_text text not null check(char_length(source_text) between 1 and 4000),
  run_id uuid not null unique, session_id uuid not null,
  workflow jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id,context_id)
    references allrice_brand_content_contexts(organization_id,workspace_id,owner_id,instance_id,brand_id,id),
  foreign key(organization_id,workspace_id,run_id) references allrice_runs(organization_id,workspace_id,id),
  foreign key(organization_id,workspace_id,session_id) references allrice_chat_sessions(organization_id,workspace_id,id),
  unique(organization_id,workspace_id,owner_id,instance_id,brand_id,id)
);
create table allrice_brand_content_experiences (
  memory_id uuid primary key,
  organization_id uuid not null, workspace_id uuid not null,
  owner_id uuid not null, instance_id uuid not null, brand_id uuid not null,
  retrospective_id uuid not null unique,
  context_id uuid not null, platform text not null, campaign_key text,
  created_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,workspace_id,memory_id) references allrice_memories(organization_id,workspace_id,id),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id,retrospective_id)
    references allrice_brand_content_retrospectives(organization_id,workspace_id,owner_id,instance_id,brand_id,id),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id,context_id)
    references allrice_brand_content_contexts(organization_id,workspace_id,owner_id,instance_id,brand_id,id),
  unique(organization_id,workspace_id,owner_id,instance_id,brand_id,memory_id)
);
create table allrice_brand_content_experience_uses (
  organization_id uuid not null, workspace_id uuid not null,
  owner_id uuid not null, instance_id uuid not null, brand_id uuid not null,
  entity_id uuid not null, memory_id uuid not null,
  revision integer not null check(revision>0), digest text not null check(digest ~ '^sha256:[a-f0-9]{64}$'),
  reason text not null check(char_length(reason) between 1 and 600),
  created_at timestamptz not null default clock_timestamp(),
  primary key(entity_id,memory_id),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id,memory_id)
    references allrice_brand_content_experiences(organization_id,workspace_id,owner_id,instance_id,brand_id,memory_id),
  foreign key(organization_id,workspace_id,owner_id,instance_id,brand_id)
    references allrice_brand_content_brands(organization_id,workspace_id,owner_id,instance_id,id)
);
create index allrice_brand_feedback_scope on allrice_brand_content_feedback(brand_id,created_at desc);
create index allrice_brand_retrospective_scope on allrice_brand_content_retrospectives(brand_id,created_at desc);
create index allrice_brand_experience_scope on allrice_brand_content_experiences(brand_id,platform,campaign_key);
create trigger allrice_brand_feedback_immutable before update or delete on allrice_brand_content_feedback
  for each row execute function allrice_brand_content_immutable();
create trigger allrice_brand_retrospective_immutable before update or delete on allrice_brand_content_retrospectives
  for each row execute function allrice_brand_content_immutable();
create trigger allrice_brand_experience_immutable before update or delete on allrice_brand_content_experiences
  for each row execute function allrice_brand_content_immutable();
create trigger allrice_brand_experience_use_immutable before update or delete on allrice_brand_content_experience_uses
  for each row execute function allrice_brand_content_immutable();
