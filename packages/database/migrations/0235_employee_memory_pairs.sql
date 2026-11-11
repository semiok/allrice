-- MET-246 PR1: storage only; not independently deployable without v2 consumers.
alter table allrice_memories add column summary text, add column details text;
alter table allrice_memory_revisions add column summary text, add column details text;

create function allrice_personal_memory_pair_valid(summary text, details text)
returns boolean language sql immutable set search_path=pg_catalog as $$
  select (summary is null and details is null) or (
    summary is not null and char_length(summary) between 1 and 40
    and summary= btrim(summary,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
    and summary !~ E'[\r\n\u2028\u2029]'
    and (details is null or (char_length(details) between 1 and 2000
      and btrim(details,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')<>''))
  )
$$;
alter table allrice_memories add constraint allrice_memories_pair_check
  check (allrice_personal_memory_pair_valid(summary,details));
alter table allrice_memory_revisions add constraint allrice_memory_revisions_pair_check
  check (allrice_personal_memory_pair_valid(summary,details));

-- Aggregate only. L1 here proves an exact original message identity, not a
-- current human authorization; runtime authority still uses its existing gate.
-- Checkpoints/occurrences/files/connectors are never guessed into message lineage.
create function allrice_employee_memory_pair_preflight() returns jsonb
language sql volatile set search_path from current as $$
  with classified as (
    select m.*,i.id is not null and a.employee_id=m.employee_id and m.visibility='private' as valid_scope,
      i.id is not null as has_instance,
      case when er.memory_id is not null then 'review'
        when b.memory_id is not null then 'brand'
        when exists(select 1 from allrice_employee_runs origin
          where origin.organization_id=m.organization_id and origin.workspace_id=m.workspace_id and origin.method_authoring
            and ((m.source_type='message' and m.source_id in (origin.user_message_id,origin.assistant_message_id))
              or (m.source_type='checkpoint' and exists(select 1 from allrice_context_checkpoints cp
                where cp.id=m.source_id and cp.covered_through_message_id in (origin.user_message_id,origin.assistant_message_id)))))
          then 'method' else 'ordinary' end as category,
      er.status as review_status,er.origin_kind,er.run_id as review_run_id,
      b.memory_id is not null as is_brand,
      case when m.archived_at is not null then 'archived'
        when m.expires_at<=clock_timestamp() then 'expired'
        when m.lifecycle_state='durable' and m.trust_level='user_confirmed' then 'active' else 'pending' end as state,
      case when m.source_type='message' and exists(select 1 from allrice_messages message
        join allrice_chat_sessions s on s.id=message.session_id and s.organization_id=message.organization_id
          and s.workspace_id=message.workspace_id and s.owner_id=message.owner_id
        where message.id=m.source_id and message.organization_id=m.organization_id
          and message.workspace_id=m.workspace_id and message.owner_id=m.owner_id and message.role='user'
          and coalesce(s.employee_instance_id,s.employee_assignment_id)=m.instance_id)
        then 'L1' else 'L0' end as lineage
    from allrice_memories m
    left join allrice_employee_instances i on i.id=m.instance_id and i.organization_id=m.organization_id
      and i.workspace_id=m.workspace_id and i.owner_id=m.owner_id
    left join allrice_employee_assignments a on a.id=i.assignment_id and a.organization_id=i.organization_id
      and a.workspace_id=i.workspace_id and a.user_id=i.owner_id
    left join allrice_experience_reviews er on er.memory_id=m.id
    left join allrice_brand_content_experiences b on b.memory_id=m.id
  ), ordinary as (select * from classified where category='ordinary'),
  over_limit as (
    select count(*) from ordinary where state='active'
    group by organization_id,workspace_id,owner_id,instance_id having count(*)>100
  ), origins as (
    select category,state,source_type,lineage,count(*) as count from classified
    group by category,state,source_type,lineage
  )
  select jsonb_build_object(
    'ordinaryCount',(select count(*) from ordinary),
    'scopeAnomalies',(select count(*) from ordinary where valid_scope is not true),
    'empty',(select count(*) from ordinary where content !~ '[^[:space:]]'),
    'over2000',(select count(*) from ordinary where char_length(content)>2000),
    'invalidDerivedPair',(select count(*) from ordinary where not allrice_personal_memory_pair_valid(
      btrim(translate(left(content,40),E'\r\n'||U&'\2028\2029','    '),
        U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),
      case when char_length(content)>40 then content end)),
    'expired',(select count(*) from ordinary where state='expired'),
    'futureExpiry',(select count(*) from ordinary where archived_at is null and expires_at>clock_timestamp()),
    'overActiveLimitScopes',(select count(*) from over_limit),
    'legacyReadableReview',(select count(*) from classified where category='review' and state='active'
      and has_instance and not is_brand and review_status='approved' and origin_kind not in ('incremental','derived')
      and not exists(select 1 from allrice_employee_runs origin where origin.run_id=classified.review_run_id and origin.method_authoring)
      and not exists(select 1 from allrice_employee_runs origin
        where origin.organization_id=classified.organization_id and origin.workspace_id=classified.workspace_id and origin.method_authoring
          and ((classified.source_type='message' and classified.source_id in (origin.user_message_id,origin.assistant_message_id))
            or (classified.source_type='checkpoint' and exists(select 1 from allrice_context_checkpoints cp
              where cp.id=classified.source_id and cp.covered_through_message_id in (origin.user_message_id,origin.assistant_message_id)))))),
    'missingCurrentRevision',(select count(*) from ordinary m where not exists(
      select 1 from allrice_memory_revisions r where r.memory_id=m.id and r.organization_id=m.organization_id
        and r.workspace_id=m.workspace_id and r.revision=m.revision and r.content=m.content)),
    'sourceLineage',coalesce((select jsonb_agg(to_jsonb(origins) order by category,state,source_type,lineage) from origins),'[]'::jsonb)
  )
$$;

-- Match 0225: pin both functions to the migration schema, not the session path.
do $$
declare
  app_schema text := current_schema();
  signature text;
begin
  foreach signature in array array[
    'allrice_personal_memory_pair_valid(summary text, details text)',
    'allrice_employee_memory_pair_preflight()'
  ] loop
    execute format('alter function %I.%s set search_path = pg_catalog, %I',
      app_schema, signature, app_schema);
  end loop;
end $$;

-- Deployment must already be stopped for writes; these relation locks also
-- make the preflight/CAS/backfill one indivisible migration transaction.
lock table allrice_memories,allrice_memory_revisions in share row exclusive mode;
do $$
declare
  report jsonb;
  original record;
  saved record;
  one_line text;
  detail text;
  before_digest text;
  after_digest text;
  migrated integer := 0;
begin
  report := allrice_employee_memory_pair_preflight();
  raise notice 'employee_memory_pair_preflight %', report;
  if exists(select 1 from jsonb_each(report) item where item.key in (
    'scopeAnomalies','empty','over2000','invalidDerivedPair','expired',
    'overActiveLimitScopes','legacyReadableReview','missingCurrentRevision') and item.value<>'0'::jsonb) then
    raise exception using errcode='23514',message='employee_memory_pair_preflight_failed',detail=report::text;
  end if;
  select encode(sha256(convert_to(coalesce(string_agg(id::text||':'||
    encode(sha256(convert_to(to_jsonb(m)::text,'UTF8')),'hex'),',' order by id),''),'UTF8')),'hex')
    into before_digest from allrice_memories m;
  for original in
    select m.* from allrice_memories m
    where not exists(select 1 from allrice_experience_reviews er where er.memory_id=m.id)
      and not exists(select 1 from allrice_brand_content_experiences b where b.memory_id=m.id)
      and not exists(select 1 from allrice_employee_runs origin
        where origin.organization_id=m.organization_id and origin.workspace_id=m.workspace_id and origin.method_authoring
          and ((m.source_type='message' and m.source_id in (origin.user_message_id,origin.assistant_message_id))
            or (m.source_type='checkpoint' and exists(select 1 from allrice_context_checkpoints cp
              where cp.id=m.source_id and cp.covered_through_message_id in (origin.user_message_id,origin.assistant_message_id)))))
    order by m.id for update
  loop
    one_line := btrim(translate(left(original.content,40),E'\r\n'||U&'\2028\2029','    '),
      U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
    detail := case when char_length(original.content)>40 then original.content end;
    update allrice_memories set summary=one_line,details=detail,revision=revision+1,
      expires_at=case when archived_at is null then null else expires_at end
    where id=original.id and revision=original.revision and content=original.content
      and summary is null and details is null returning * into saved;
    if not found then raise exception 'employee_memory_pair_cas_conflict'; end if;
    insert into allrice_memory_revisions
      (organization_id,workspace_id,memory_id,revision,content,summary,details,trust_level,
        lifecycle_state,memory_class,confidence,expires_at,reason,changed_by)
    values(saved.organization_id,saved.workspace_id,saved.id,saved.revision,saved.content,saved.summary,saved.details,
      saved.trust_level,saved.lifecycle_state,saved.memory_class,saved.confidence,saved.expires_at,
      'system:0235_employee_memory_pairs from revision '||original.revision,saved.owner_id);
    insert into allrice_audit_events
      (organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
    values(saved.organization_id,saved.workspace_id,null,'memory.migrate_pair','memory',saved.id,'recorded',
      'system_backfill',jsonb_build_object('migration','0235_employee_memory_pairs.sql',
        'previousRevision',original.revision,'revision',saved.revision,
        'pairDigest',allrice_native_control_document_digest(jsonb_build_object(
          'version',2,'summary',saved.summary,'details',saved.details)),
        'contentDigest','sha256:'||encode(sha256(convert_to(original.content,'UTF8')),'hex')));
    migrated := migrated+1;
  end loop;
  select encode(sha256(convert_to(coalesce(string_agg(id::text||':'||
    encode(sha256(convert_to(to_jsonb(m)::text,'UTF8')),'hex'),',' order by id),''),'UTF8')),'hex')
    into after_digest from allrice_memories m;
  raise notice 'employee_memory_pair_backfill %',jsonb_build_object(
    'migration','0235_employee_memory_pairs.sql','migrated',migrated,
    'beforeDigest','sha256:'||before_digest,'afterDigest','sha256:'||after_digest);
end
$$;
