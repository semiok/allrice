-- Offline execution-artifact replacement only. No Session/Task/history migration,
-- business admission, maintenance supervisor activation, or automatic retry.
create function allrice_native_control_json_pin(value jsonb) returns text
  language sql immutable strict as $$
    select 'sha256:'||encode(sha256(convert_to(value::text,'UTF8')),'hex')
  $$;

-- Upgrade documents contain schema-checked strings, booleans and safe integers.
-- Their ASCII field names and integer representation match runtimePolicyDigest.
create function allrice_native_control_canonical(value jsonb) returns text
  language plpgsql immutable strict as $$
declare result text;
begin
  case jsonb_typeof(value)
    when 'object' then
      select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||allrice_native_control_canonical(v),',' order by key collate "C"),'')||'}'
        into result from jsonb_each(value) as e(key,v);
    when 'array' then
      select '['||coalesce(string_agg(allrice_native_control_canonical(v),',' order by n),'')||']'
        into result from jsonb_array_elements(value) with ordinality as e(v,n);
    else result:=value::text;
  end case;
  return result;
end $$;
create function allrice_native_control_document_digest(value jsonb) returns text
  language sql immutable strict as $$
    select 'sha256:'||encode(sha256(convert_to(allrice_native_control_canonical(value),'UTF8')),'hex')
  $$;

create table allrice_native_control_upgrade_plans (
  plan_id uuid primary key,
  partition_id text not null references allrice_native_once_partitions,
  plan_digest text not null unique check(plan_digest ~ '^sha256:[a-f0-9]{64}$'),
  plan jsonb not null check(jsonb_typeof(plan)='object' and octet_length(plan::text)<=65536),
  recorded_at timestamptz not null default clock_timestamp(),
  unique(plan_id,partition_id),
  check((plan->>'planId'=plan_id::text and plan->>'partitionId'=partition_id
    and plan->>'kind'='native-schedule-control-upgrade-plan-v1') is true),
  check(plan_digest=allrice_native_control_document_digest(plan))
);
create table allrice_native_control_upgrades (
  sequence bigint generated always as identity primary key,
  plan_id uuid not null unique,
  partition_id text not null,
  plan_digest text not null check(plan_digest ~ '^sha256:[a-f0-9]{64}$'),
  before_reference jsonb not null,
  after_reference jsonb not null,
  workspace_digest text check(workspace_digest ~ '^sha256:[a-f0-9]{64}$'),
  latest_journal_pin jsonb,
  previous_sequence bigint not null check(previous_sequence>=0),
  approval jsonb not null,
  approval_digest text not null check(approval_digest ~ '^sha256:[a-f0-9]{64}$'),
  offline_attestation jsonb not null,
  attestation_digest text not null check(attestation_digest ~ '^sha256:[a-f0-9]{64}$'),
  transaction_id bigint not null default txid_current(),
  applied_at timestamptz not null default clock_timestamp(),
  foreign key(plan_id,partition_id) references allrice_native_control_upgrade_plans(plan_id,partition_id),
  check(approval_digest=allrice_native_control_document_digest(approval)),
  check(attestation_digest=allrice_native_control_document_digest(offline_attestation)),
  check(octet_length(approval::text)<=8192 and octet_length(offline_attestation::text)<=16384)
);
create index native_control_upgrade_partition on allrice_native_control_upgrades(partition_id,sequence desc);
create trigger native_control_upgrade_plan_immutable before update or delete on allrice_native_control_upgrade_plans
  for each row execute function allrice_native_once_immutable();
create trigger native_control_upgrade_immutable before update or delete on allrice_native_control_upgrades
  for each row execute function allrice_native_once_immutable();

create function allrice_native_control_upgrade_idle() returns jsonb language sql volatile as $$
  select jsonb_build_object(
    'jobs',(select count(*) from allrice_jobs where status in ('queued','claimed','running','retry_wait','waiting_approval')),
    'clouds',(select count(*) from allrice_cloud_execution_attempts where cleanup_confirmed_at is null),
    'employeeTests',(select count(*) from allrice_platform_employee_test_runs where status in ('queued','running')),
    'runtimeLeases',(select count(*) from allrice_runtime_operations where lease_expires_at>clock_timestamp()),
    'providerFlows',(select count(*) from allrice_provider_authorization_flows where state in ('pending','running','awaiting_user')),
    'onceOutbox',(select count(*) from allrice_native_once_occurrences where outbox_state='pending' or outbox_expires_at>clock_timestamp()),
    'recurringOutbox',(select count(*) from allrice_native_recurring_occurrences where outbox_state='pending' or outbox_expires_at>clock_timestamp()),
    'recurringOperations',(select count(*) from allrice_native_recurring_operations where status='pending'))
$$;

-- No process/OS claim is made by SQL. The reviewed source operator supplies
-- actual lock ownership and normal-stop/PID-birth/exit evidence. Historical
-- unknown producer permits are neither completed nor treated as a supervisor.
create function allrice_native_control_upgrade_facts(target text) returns jsonb language plpgsql volatile set TimeZone='UTC' as $$
declare p allrice_native_once_partitions%rowtype; j allrice_native_once_journal%rowtype;
  audit allrice_native_once_close_proofs%rowtype; protected jsonb:='{}'; relation text; pin jsonb;
begin
  select * into p from allrice_native_once_partitions where partition_id=target;
  if not found then return null; end if;
  select * into audit from allrice_native_once_close_proofs where partition_id=target and epoch=p.epoch;
  select * into j from allrice_native_once_journal where partition_id=target and entry_kind='workspace'
    order by (after_snapshot->>'revision')::bigint desc limit 1;
  foreach relation in array array['allrice_native_once_controls','allrice_native_once_occurrences',
    'allrice_native_once_journal','allrice_native_recurring_controls',
    'allrice_native_recurring_occurrences','allrice_native_recurring_journal'] loop
    execute format('select jsonb_build_object(''count'',count(*),''pin'',allrice_native_control_json_pin(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),''[]''::jsonb))) from %I r where partition_id=$1',relation)
      into pin using target;
    protected:=protected||jsonb_build_object(relation,pin);
  end loop;
  foreach relation in array array['allrice_native_recurring_versions','allrice_native_recurring_operations','allrice_automations','allrice_automation_runs'] loop
    execute format('select jsonb_build_object(''count'',count(*),''pin'',allrice_native_control_json_pin(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),''[]''::jsonb))) from %I r where %s in (select automation_id from allrice_native_once_controls where partition_id=$1 union select automation_id from allrice_native_recurring_controls where partition_id=$1)',relation,case when relation='allrice_automations' then 'id' else 'automation_id' end)
      into pin using target;
    protected:=protected||jsonb_build_object(relation,pin);
  end loop;
  return jsonb_build_object(
    'reference',p.reference,'partitionPin',allrice_native_control_json_pin(to_jsonb(p)),
    'partitionInvariantPin',allrice_native_control_json_pin(to_jsonb(p)-'reference'),
    'closeFence',jsonb_build_object('closed',p.closed,'epoch',p.epoch,'ownerId',p.owner_id,'tokenDigest',p.token_digest,
      'proofId',audit.proof_id,'auditPin',allrice_native_control_json_pin(to_jsonb(audit)),
      'valid',coalesce(p.closed and p.epoch>0 and audit.proof=p.close_proof
        and p.close_proof->>'kind' in ('public_host_backend_drained','verified_process_exit')
        and p.close_proof->>'partitionId'=target and p.close_proof->>'ownerId'=p.owner_id
        and p.close_proof->>'epoch'=p.epoch::text and p.close_proof->>'tokenDigest'=p.token_digest
        and p.close_proof->>'proofId'=audit.proof_id and jsonb_typeof(p.close_proof->'evidence')='object'
        and p.close_proof->'evidence'<>'{}'::jsonb,false)),
    'workspaceSnapshotPin',allrice_native_control_json_pin(p.workspace_snapshot),
    'latestWorkspaceJournal',case when j.write_id is null then null else jsonb_build_object(
      'writeId',j.write_id,'rowPin',allrice_native_control_json_pin(to_jsonb(j)),
      'reference',j.reference,'afterDigest',j.after_digest) end,
    'protected',protected,
    'previousSequence',coalesce((select max(sequence) from allrice_native_control_upgrades where partition_id=target),0));
end $$;

create function allrice_native_control_upgrade_plan_guard() returns trigger language plpgsql as $$
declare p allrice_native_once_partitions%rowtype; now_ms bigint;
begin
  select * into p from allrice_native_once_partitions where partition_id=new.partition_id for update;
  now_ms:=floor(extract(epoch from clock_timestamp())*1000);
  if (new.plan ?& array['createdAtMs','expiresAtMs','workspaceDigest','artifactEvidence','artifactEvidenceDigest']) is not true
    or jsonb_typeof(new.plan->'createdAtMs') is distinct from 'number'
    or jsonb_typeof(new.plan->'expiresAtMs') is distinct from 'number'
    or (new.plan->'beforeReference'->>'artifactId' ~ '^sha256:[a-f0-9]{64}$') is not true
    or (new.plan->'afterReference'->>'artifactId' ~ '^sha256:[a-f0-9]{64}$') is not true
    or (new.plan->'beforeReference'->>'profileId' in ('allrice-once-control-v1','allrice-recurring-control-v1')) is not true
    or new.plan->'artifactEvidence'->>'kind' is distinct from 'reviewed-native-control-compatibility-v1'
    or new.plan->'artifactEvidence'->>'generation' is distinct from new.plan->>'generation'
    or new.plan->'artifactEvidence'->'beforeReference' is distinct from new.plan->'beforeReference'
    or new.plan->'artifactEvidence'->'afterReference' is distinct from new.plan->'afterReference'
    or (new.plan->'artifactEvidence'->>'artifactVerificationDigest' ~ '^sha256:[a-f0-9]{64}$') is not true
    or (new.plan->'artifactEvidence'->>'publicHistoryVerificationDigest' ~ '^sha256:[a-f0-9]{64}$') is not true
    or new.plan->>'artifactEvidenceDigest' is distinct from allrice_native_control_document_digest(new.plan->'artifactEvidence')
    or new.plan->'workspaceDigest' is distinct from coalesce(to_jsonb(allrice_native_control_document_digest(p.workspace_snapshot)),'null'::jsonb)
    or (new.plan->'facts'->'closeFence'->>'valid') is distinct from 'true'
    or new.plan->'facts' is distinct from allrice_native_control_upgrade_facts(new.partition_id)
    or new.plan->'beforeReference' is distinct from p.reference
    or new.plan->'beforeReference'->>'artifactId'=new.plan->'afterReference'->>'artifactId'
    or ((new.plan->'beforeReference')-'artifactId') is distinct from ((new.plan->'afterReference')-'artifactId')
    or new.plan->>'generation' is distinct from 'dsh-0.2.1-rc.2-687f282'
    or (new.plan->>'createdAtMs')::bigint not between now_ms-10000 and now_ms
    or (new.plan->>'expiresAtMs')::bigint not between now_ms+1 and (new.plan->>'createdAtMs')::bigint+900000
    or exists(select 1 from jsonb_each_text(allrice_native_control_upgrade_idle()) e where e.value<>'0') then
    raise exception 'native control upgrade plan is not a closed idle snapshot' using errcode='P1950';
  end if;
  return new;
end $$;
create trigger native_control_upgrade_plan_guard before insert on allrice_native_control_upgrade_plans
  for each row execute function allrice_native_control_upgrade_plan_guard();

create function allrice_native_control_upgrade_offline_valid(value jsonb, plan jsonb) returns boolean
  language plpgsql immutable as $$
declare item jsonb; first_lock jsonb; roles text[]:='{}'; pids bigint[]:='{}';
begin
  if (value ?& array['kind','environment','planId','planDigest','observedAtMs','expiresAtMs','locks','processes','operatorEvidenceDigest']) is not true
    or jsonb_typeof(value->'observedAtMs') is distinct from 'number' or jsonb_typeof(value->'expiresAtMs') is distinct from 'number'
    or (value->>'operatorEvidenceDigest' ~ '^sha256:[a-f0-9]{64}$') is not true
    or jsonb_typeof(value->'locks') is distinct from 'array' or jsonb_typeof(value->'processes') is distinct from 'array'
    or jsonb_array_length(value->'locks') is distinct from 2 or jsonb_array_length(value->'processes') is distinct from 2 then return false; end if;
  for item in select v from jsonb_array_elements(value->'locks') e(v) loop
    if (item ?& array['path','ownerPid','ownerBirth','tokenDigest','acquiredAtMs','ownershipEvidenceDigest']) is not true
      or (item->>'path' like '/%' and length(item->>'ownerBirth')>0 and (item->>'ownerPid')::bigint>0
        and (item->>'acquiredAtMs')::bigint between 0 and (plan->>'createdAtMs')::bigint
        and item->>'tokenDigest' ~ '^sha256:[a-f0-9]{64}$'
        and item->>'ownershipEvidenceDigest' ~ '^sha256:[a-f0-9]{64}$') is not true then return false; end if;
    if first_lock is null then first_lock:=item;
    elsif item->>'path'=first_lock->>'path' or item->'ownerPid'<>first_lock->'ownerPid' or item->'ownerBirth'<>first_lock->'ownerBirth' then return false; end if;
  end loop;
  for item in select v from jsonb_array_elements(value->'processes') e(v) loop
    if (item ?& array['role','pid','birth','stopMode','stopRequestedAtMs','exitConfirmedAtMs','exitEvidenceDigest']) is not true
      or (item->>'role' in ('web','worker') and item->>'stopMode'='normal' and length(item->>'birth')>0
        and (item->>'pid')::bigint>0 and (item->>'stopRequestedAtMs')::bigint>=0
        and (item->>'stopRequestedAtMs')::bigint<=(item->>'exitConfirmedAtMs')::bigint
        and (item->>'exitConfirmedAtMs')::bigint<=(plan->>'createdAtMs')::bigint
        and item->>'exitEvidenceDigest' ~ '^sha256:[a-f0-9]{64}$') is not true then return false; end if;
    if item->>'role'=any(roles) or (item->>'pid')::bigint=any(pids) then return false; end if;
    roles:=array_append(roles,item->>'role'); pids:=array_append(pids,(item->>'pid')::bigint);
  end loop;
  return true;
end $$;

create function allrice_native_control_upgrade_guard() returns trigger language plpgsql as $$
declare plan jsonb; p allrice_native_once_partitions%rowtype; now_ms bigint;
begin
  select q.plan into plan from allrice_native_control_upgrade_plans q where q.plan_id=new.plan_id and q.plan_digest=new.plan_digest;
  select * into p from allrice_native_once_partitions where partition_id=new.partition_id for update;
  now_ms:=floor(extract(epoch from clock_timestamp())*1000);
  if plan is null or new.transaction_id<>txid_current()
    or (new.approval ?& array['kind','approved','reviewedBy','reviewedAtMs','reviewPolicyDigest','planId','planDigest','artifactEvidenceDigest','attestationDigest']) is not true
    or (new.approval->>'reviewPolicyDigest' ~ '^sha256:[a-f0-9]{64}$') is not true
    or jsonb_typeof(new.approval->'reviewedAtMs') is distinct from 'number'
    or allrice_native_control_upgrade_offline_valid(new.offline_attestation,plan) is not true
    or plan->'facts' is distinct from allrice_native_control_upgrade_facts(new.partition_id)
    or (plan->'facts'->'closeFence'->>'valid') is distinct from 'true'
    or new.before_reference is distinct from p.reference or new.before_reference is distinct from plan->'beforeReference'
    or new.after_reference is distinct from plan->'afterReference'
    or coalesce(to_jsonb(new.workspace_digest),'null'::jsonb) is distinct from plan->'workspaceDigest'
    or new.latest_journal_pin is distinct from nullif(plan->'facts'->'latestWorkspaceJournal','null'::jsonb)
    or new.previous_sequence<>(plan->'facts'->>'previousSequence')::bigint
    or (plan->>'expiresAtMs')::bigint<=now_ms
    or new.approval->>'kind' is distinct from 'native-control-upgrade-approval-v1'
    or new.approval->'approved' is distinct from 'true'::jsonb
    or coalesce(length(new.approval->>'reviewedBy'),0)=0
    or new.approval->>'planId' is distinct from new.plan_id::text or new.approval->>'planDigest' is distinct from new.plan_digest
    or new.approval->>'attestationDigest' is distinct from new.attestation_digest
    or new.approval->>'artifactEvidenceDigest' is distinct from plan->>'artifactEvidenceDigest'
    or (new.approval->>'reviewedAtMs')::bigint not between (plan->>'createdAtMs')::bigint and now_ms
    or new.offline_attestation->>'kind' is distinct from 'offlineStopped'
    or new.offline_attestation->>'environment' is distinct from 'dev'
    or new.offline_attestation->>'planId' is distinct from new.plan_id::text
    or new.offline_attestation->>'planDigest' is distinct from new.plan_digest
    or jsonb_array_length(new.offline_attestation->'locks') is distinct from 2
    or jsonb_array_length(new.offline_attestation->'processes') is distinct from 2
    or (new.offline_attestation->>'observedAtMs')::bigint not between (plan->>'createdAtMs')::bigint and now_ms
    or (new.offline_attestation->>'observedAtMs')::bigint>(new.approval->>'reviewedAtMs')::bigint
    or (new.offline_attestation->>'expiresAtMs')::bigint not between now_ms+1 and least((plan->>'expiresAtMs')::bigint,(new.offline_attestation->>'observedAtMs')::bigint+120000)
    or exists(select 1 from jsonb_each_text(allrice_native_control_upgrade_idle()) e where e.value<>'0') then
    raise exception 'native control upgrade approval, close, snapshot or offline fence rejected' using errcode='P1950';
  end if;
  return new;
end $$;
create trigger native_control_upgrade_guard before insert on allrice_native_control_upgrades
  for each row execute function allrice_native_control_upgrade_guard();

-- Preserve every original lease/epoch/close fence. The sole new exception is
-- one same-transaction ledger row for an otherwise byte-identical closed row.
create or replace function allrice_native_once_partition_guard() returns trigger language plpgsql set TimeZone='UTC' as $$
begin
  if new.partition_id<>old.partition_id then
    raise exception 'native once reference is immutable' using errcode='23514';
  end if;
  if new.reference<>old.reference then
    if (to_jsonb(new)-'reference')<>(to_jsonb(old)-'reference') or not old.closed
      or not exists(select 1 from allrice_native_control_upgrades u
        join allrice_native_control_upgrade_plans q on q.plan_id=u.plan_id
        where u.partition_id=old.partition_id and u.transaction_id=txid_current()
          and u.sequence=(select max(sequence) from allrice_native_control_upgrades where partition_id=old.partition_id)
          and u.before_reference=old.reference and u.after_reference=new.reference
          and q.plan->'facts'->>'partitionPin'=allrice_native_control_json_pin(to_jsonb(old))) then
      raise exception 'native once reference requires exact closed upgrade ledger' using errcode='P1950';
    end if;
  end if;
  if new.epoch=old.epoch then
    if new.owner_id is distinct from old.owner_id or new.token_digest is distinct from old.token_digest
      or (old.closed and not new.closed) or (old.closed and new.close_proof<>old.close_proof) then
      raise exception 'native once epoch fence' using errcode='23514';
    end if;
  elsif new.epoch<>old.epoch+1 or not old.closed or new.closed
    or new.owner_id is null or new.token_digest is null then
    raise exception 'native once acquire requires explicit close' using errcode='23514';
  end if;
  return new;
end $$;

create function allrice_native_control_upgrade_commit_fence() returns trigger language plpgsql as $$
declare facts jsonb; plan jsonb; now_ms bigint;
begin
  select q.plan into plan from allrice_native_control_upgrade_plans q where q.plan_id=new.plan_id;
  facts:=allrice_native_control_upgrade_facts(new.partition_id);
  now_ms:=floor(extract(epoch from clock_timestamp())*1000);
  if facts->'reference' is distinct from new.after_reference
    or (facts-array['reference','partitionPin','previousSequence']) is distinct from ((plan->'facts')-array['reference','partitionPin','previousSequence'])
    or (facts->>'previousSequence')::bigint<>new.sequence
    or (plan->>'expiresAtMs')::bigint<=now_ms
    or (new.offline_attestation->>'expiresAtMs')::bigint<=now_ms
    or exists(select 1 from jsonb_each_text(allrice_native_control_upgrade_idle()) e where e.value<>'0') then
    raise exception 'native control upgrade COMMIT fence lost' using errcode='P1951';
  end if;
  return new;
end $$;
create constraint trigger native_control_upgrade_commit_fence after insert on allrice_native_control_upgrades
  deferrable initially deferred for each row execute function allrice_native_control_upgrade_commit_fence();

-- Restore an old workspace journal only through the newest uninterrupted upgrade
-- chain, anchored to this exact current snapshot and entire latest journal row.
create function allrice_native_control_upgrade_workspace_allowed(target text, expected_reference jsonb,
  expected_workspace_digest text, expected_write_id text) returns boolean language plpgsql stable set TimeZone='UTC' as $$
declare p allrice_native_once_partitions%rowtype; j allrice_native_once_journal%rowtype;
  u allrice_native_control_upgrades%rowtype; cursor_reference jsonb; journal_pin jsonb;
begin
  select * into p from allrice_native_once_partitions where partition_id=target;
  select * into j from allrice_native_once_journal where partition_id=target and entry_kind='workspace'
    order by (after_snapshot->>'revision')::bigint desc limit 1;
  if p.reference is distinct from expected_reference or j.write_id is distinct from expected_write_id
    or j.after_snapshot is distinct from p.workspace_snapshot or j.after_digest is distinct from expected_workspace_digest then return false; end if;
  journal_pin:=jsonb_build_object('writeId',j.write_id,'rowPin',allrice_native_control_json_pin(to_jsonb(j)),
    'reference',j.reference,'afterDigest',j.after_digest);
  cursor_reference:=expected_reference;
  for u in select * from allrice_native_control_upgrades where partition_id=target order by sequence desc loop
    if u.after_reference is distinct from cursor_reference or u.workspace_digest is distinct from expected_workspace_digest
      or u.latest_journal_pin is distinct from journal_pin then return false; end if;
    cursor_reference:=u.before_reference;
    if cursor_reference=j.reference then return true; end if;
  end loop;
  return false;
end $$;
