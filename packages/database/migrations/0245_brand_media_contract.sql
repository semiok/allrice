-- MET-224 s1.3: private business records, not Agent/Run state. Additive only.
-- The existing migration runner owns the transaction and deployment write fence.
-- Content bytes stay in immutable deliverables; JSON pins grant no file access.
create table allrice_brand_media_topics (
  id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null,
  instance_id uuid not null,
  revision integer not null default 1 check (revision > 0),
  candidate jsonb not null check (jsonb_typeof(candidate) = 'object'),
  direction text not null check (char_length(btrim(direction)) between 1 and 8000),
  reference_pins jsonb not null default '[]' check (jsonb_typeof(reference_pins) = 'array'),
  source_run_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (organization_id, workspace_id, owner_id, instance_id)
    references allrice_employee_instances(organization_id, workspace_id, owner_id, id),
  foreign key (organization_id, workspace_id, source_run_id)
    references allrice_runs(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, owner_id, instance_id, id)
);
-- Only selected topics are stored. An article's presence removes its topic from
-- the topic-library query; there is no second topic/Run lifecycle to synchronize.
create table allrice_brand_media_articles (
  id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null,
  instance_id uuid not null,
  topic_id uuid not null unique,
  revision integer not null default 1 check (revision > 0),
  title text not null check (char_length(btrim(title)) between 1 and 240),
  requirements text not null default '' check (char_length(requirements) <= 8000),
  body_file jsonb check (body_file is null or jsonb_typeof(body_file) = 'object'),
  reference_pins jsonb not null default '[]' check (jsonb_typeof(reference_pins) = 'array'),
  images jsonb not null default '[]' check (jsonb_typeof(images) = 'array'),
  state text not null default 'draft' check (state in ('draft', 'scheduled', 'published')),
  planned_at timestamptz,
  timezone text,
  wechat_url text,
  xiaohongshu_url text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (organization_id, workspace_id, owner_id, instance_id, topic_id)
    references allrice_brand_media_topics(organization_id, workspace_id, owner_id, instance_id, id),
  check ((state = 'draft' and planned_at is null and timezone is null)
    or (state in ('scheduled', 'published') and planned_at is not null
      and timezone is not null and char_length(btrim(timezone)) between 1 and 64)),
  check (state = 'published' or (wechat_url is null and xiaohongshu_url is null))
);
create index allrice_brand_media_topic_library on allrice_brand_media_topics
  (organization_id, workspace_id, owner_id, instance_id, created_at desc, id desc);
create index allrice_brand_media_article_library on allrice_brand_media_articles
  (organization_id, workspace_id, owner_id, instance_id, created_at desc, id desc);
create index allrice_brand_media_month on allrice_brand_media_articles
  (organization_id, workspace_id, owner_id, instance_id, planned_at, id)
  where state in ('scheduled', 'published');

-- Structural progress constraints. Current membership, module enablement, file
-- permission, native lease and CAS WHERE revision are checked by P3 entrypoints.
create function allrice_brand_media_article_progress() returns trigger language plpgsql as $$
begin
  if TG_OP = 'INSERT' then
    if NEW.state <> 'draft' or NEW.revision <> 1 then
      raise exception 'brand_media_article_must_start_as_draft';
    end if;
    return NEW;
  end if;
  if TG_OP = 'DELETE' then
    if OLD.state = 'published' then raise exception 'brand_media_published_readonly'; end if;
    return OLD;
  end if;
  if (NEW.id, NEW.organization_id, NEW.workspace_id, NEW.owner_id, NEW.instance_id, NEW.topic_id, NEW.created_at)
    is distinct from (OLD.id, OLD.organization_id, OLD.workspace_id, OLD.owner_id, OLD.instance_id, OLD.topic_id, OLD.created_at) then
    raise exception 'brand_media_article_identity_immutable';
  end if;
  if NEW.revision <> OLD.revision + 1 then raise exception 'brand_media_revision_conflict'; end if;
  if (OLD.state = 'draft' and NEW.state = 'published')
    or (OLD.state = 'published' and NEW.state <> 'scheduled') then
    raise exception 'brand_media_invalid_transition';
  end if;
  -- Correcting a mistaken publication preserves its content and planned time.
  -- Edits or a different time are subsequent explicit actions after correction.
  if OLD.state = 'published' and
    (NEW.title, NEW.requirements, NEW.body_file, NEW.reference_pins, NEW.images, NEW.planned_at, NEW.timezone)
    is distinct from
    (OLD.title, OLD.requirements, OLD.body_file, OLD.reference_pins, OLD.images, OLD.planned_at, OLD.timezone) then
    raise exception 'brand_media_published_readonly';
  end if;
  -- Publication time comes from the schedule, not a new actual-time input.
  if NEW.state = 'published' and (NEW.planned_at, NEW.timezone)
    is distinct from (OLD.planned_at, OLD.timezone) then
    raise exception 'brand_media_publication_uses_schedule';
  end if;
  return NEW;
end $$;
create trigger allrice_brand_media_article_progress
  before insert or update or delete on allrice_brand_media_articles
  for each row execute function allrice_brand_media_article_progress();
