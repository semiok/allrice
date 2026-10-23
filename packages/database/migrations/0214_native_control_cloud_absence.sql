-- Exact local-operator control exception. 0202 and global raw idle stay unchanged.
-- No outcome, cleanup, usage, financial settlement or historical ledger is written.
create table allrice_native_control_cloud_absences (
  plan_id uuid primary key,
  partition_id text not null references allrice_native_once_partitions,
  credential_digest text not null unique check (credential_digest ~ '^sha256:[a-f0-9]{64}$'),
  before_reference jsonb not null,
  after_reference jsonb not null,
  credential jsonb not null check (jsonb_typeof(credential)='object' and octet_length(credential::text)<=1048576),
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (plan_id,partition_id) references allrice_native_control_upgrade_plans(plan_id,partition_id) deferrable initially deferred,
  check (credential_digest=allrice_native_control_document_digest(credential))
);
revoke insert,update,delete on allrice_native_control_cloud_absences from public;
create trigger native_control_cloud_absence_immutable before update or delete on allrice_native_control_cloud_absences
  for each row execute function allrice_native_once_immutable();

-- The pinned reader's original timestamp representation and all original row
-- bytes. SQL does not claim OS absence or pretend its transaction is read-only.
create function allrice_native_control_historical_cloud_snapshot() returns jsonb
  language sql volatile set TimeZone='Asia/Shanghai' as $$
  select jsonb_build_object(
    'uncleanedOperationIds',(select coalesce(jsonb_agg(operation_id::text order by operation_id),'[]'::jsonb) from allrice_cloud_execution_attempts where cleanup_confirmed_at is null),
    'attempt',(select jsonb_build_object('operationId',operation_id::text,'containerId',container_id,'outcomeIsNull',outcome is null,'cleanupConfirmedAt',cleanup_confirmed_at::text,'rowSha256',encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex'),'leaseTokenSha256',encode(sha256(convert_to(lease_token,'UTF8')),'hex')) from allrice_cloud_execution_attempts a where operation_id='44cff0b1-a2db-4953-a7b0-8e74c9f414ec'),
    'operation',(select jsonb_build_object('operationId',id::text,'runId',run_id::text,'rootRunId',root_run_id::text,'attemptId',attempt_id::text,'status',snapshot->>'status','leaseExpiresAt',lease_expires_at::text,'leaseExpired',lease_expires_at<=clock_timestamp(),'rowSha256',encode(sha256(convert_to(to_jsonb(o)::text,'UTF8')),'hex'),'snapshotSha256',encode(sha256(convert_to(snapshot::text,'UTF8')),'hex')) from allrice_runtime_operations o where id='44cff0b1-a2db-4953-a7b0-8e74c9f414ec'),
    'input',(select jsonb_build_object('operationId',operation_id::text,'runId',run_id::text,'jobId',job_id::text,'attemptId',binding->'attempt'->>'attemptId','rowSha256',encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex'),'jobLeaseTokenSha256',encode(sha256(convert_to(job_lease_token::text,'UTF8')),'hex')) from allrice_cloud_execution_inputs i where operation_id='44cff0b1-a2db-4953-a7b0-8e74c9f414ec'),
    'job',(select jsonb_build_object('id',id::text,'runId',run_id::text,'status',status,'leaseExpiresAt',lease_expires_at::text,'leaseExpired',lease_expires_at is null or lease_expires_at<=clock_timestamp(),'rowSha256',encode(sha256(convert_to(to_jsonb(j)::text,'UTF8')),'hex')) from allrice_jobs j where id='6a42bf8b-9a3b-432a-9fb1-e4123bbccc8a'),
    'run',(select jsonb_build_object('id',id::text,'state',state,'completedAt',completed_at::text,'rowSha256',encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')) from allrice_runs r where id='0c350e53-4ad8-4e57-bdc0-f4472e74d0d3'),
    'receipts',(select jsonb_build_object('count',count(*)::int,'ids',coalesce(jsonb_agg(receipt_id::text order by receipt_id),'[]'::jsonb),'rowsSha256',encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) order by receipt_id),'[]'::jsonb)::text,'UTF8')),'hex')) from allrice_runtime_operation_receipts r where operation_id='44cff0b1-a2db-4953-a7b0-8e74c9f414ec'))
$$;

-- This revision is for the NOT-YET-APPLIED 0214 only. Preserve all raw rows;
-- the reviewed source independently performs actual same-daemon GETs. SQL
-- validates exact durable scope/identity/evidence, never attests an OS itself.
create function allrice_native_control_cloud_inventory_identity(v jsonb) returns jsonb
language plpgsql immutable as $$
declare c jsonb; result jsonb:='[]'::jsonb;
begin
  if jsonb_typeof(v->'body') is distinct from 'array' or jsonb_array_length(v->'body')>128 then return null; end if;
  if (select count(distinct x->>'Id') from jsonb_array_elements(v->'body') x)<>jsonb_array_length(v->'body') then return null; end if;
  for c in select x from jsonb_array_elements(v->'body') x order by x->>'Id' loop
    if jsonb_typeof(c) is distinct from 'object' or (c->>'Id' ~ '^[a-f0-9]{64}$') is not true
      or jsonb_typeof(c->'Names') is distinct from 'array' or jsonb_typeof(c->'Mounts') is distinct from 'array'
      or exists(select 1 from jsonb_array_elements(c->'Names') n where jsonb_typeof(n)<>'string')
      or exists(select 1 from jsonb_array_elements(c->'Mounts') m where jsonb_typeof(m)<>'object' or jsonb_typeof(m->'Destination') is distinct from 'string') then return null; end if;
    result:=result||jsonb_build_array((c-array['Status','Names','Mounts'])||jsonb_build_object(
      'Names',(select coalesce(jsonb_agg(n order by n),'[]'::jsonb) from jsonb_array_elements(c->'Names') n),
      'Mounts',(select coalesce(jsonb_agg(m order by m->>'Destination'),'[]'::jsonb) from jsonb_array_elements(c->'Mounts') m)));
  end loop;
  return result;
end $$;

create function allrice_native_control_cloud_inventory_valid(o jsonb,a jsonb) returns boolean
language plpgsql stable set TimeZone='UTC' as $$
declare c jsonb; labels jsonb; owned boolean; owned_count integer:=0; p jsonb:=a->'inventoryPreservation';
  s jsonb:=o->'preservedExitedContainer'; identity jsonb; expected jsonb;
begin
  identity:=allrice_native_control_cloud_inventory_identity(o->'inventory');
  if identity is null then return false; end if;
  -- Original empty-inventory credentials retain their exact default path.
  if jsonb_array_length(identity)=0 then
    return not (o ? 'preservedExitedContainer' or o ? 'exitedEvidenceDigest' or a ? 'inventoryPreservation');
  end if;
  if (o->>'inventoryNonce' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') is not true
    or a->>'inventoryNonce' is distinct from o->>'inventoryNonce'
    or (o->>'sharedVerifierSha256' ~ '^[a-f0-9]{64}$') is not true
    or a->>'inventoryVerifierSha256' is distinct from o->>'sharedVerifierSha256' then return false; end if;
  for c in select x from jsonb_array_elements(o#>'{inventory,body}') x loop
    if (jsonb_typeof(c->'Labels') in ('object','null')) is not true or (c->>'State' in ('created','restarting','running','removing','paused','exited','dead')) is not true then return false; end if;
    labels:=case when jsonb_typeof(c->'Labels')='object' then c->'Labels' else '{}'::jsonb end;
    owned:=c->>'Id'='c059c14ced1dcd6664c7131382a5ef0975c7c6ce1245932892dd921c45a070be'
      or exists(select 1 from jsonb_array_elements_text(c->'Names') n where n ~ '^/allrice-cloud(-|$)')
      or labels->>'xyz.bplabs.allrice.backend'='cloud-gvisor-v1'
      or exists(select 1 from jsonb_object_keys(labels) k where starts_with(k,'xyz.bplabs.allrice.cloud.'));
    if owned then
      owned_count:=owned_count+1;
      if owned_count<>1 or c->>'Id'<>'c059c14ced1dcd6664c7131382a5ef0975c7c6ce1245932892dd921c45a070be'
        or c->'Names'<>'["/allrice-cloud-91e4fa1c-14af-499a-a2dd-d1989ce056b9"]'::jsonb
        or c->>'State'<>'exited' then return false; end if;
      expected:=c;
    end if;
  end loop;
  -- Noncloud infrastructure is not a cloud reservation. The complete raw list
  -- remains SHA-bound by the source approval and compared again by the operator.
  if owned_count=0 then return not (o ? 'preservedExitedContainer' or o ? 'exitedEvidenceDigest' or a ? 'inventoryPreservation'); end if;
  if (p->>'kind'='native-control-exact-exited-container-preservation-v1'
    and p->'enabled'='true'::jsonb and p->'rootReviewed'='true'::jsonb and p->>'reviewedBy'='root'
    and p->>'phase'='prepare' and p->'planDigest'='null'::jsonb and p->'credentialDigest'='null'::jsonb
    and p->>'planId'=o->>'planId' and p->>'partitionId'=o->>'partitionId'
    and p->'beforeReference'=o->'beforeReference' and p->'afterReference'=o->'afterReference'
    and p->>'nonce'=o->>'inventoryNonce' and p->>'inventoryVerifierSha256'=o->>'sharedVerifierSha256'
    and p->>'releaseSha'=a->>'releaseSha' and p->>'sourceTree'=a->>'sourceTree'
    and p->>'offlineProofDigest'=a->>'offlineProofDigest'
    and p->>'reviewedAtMs'=a->>'reviewedAtMs' and p->>'expiresAtMs'=o->>'expiresAtMs'
    and p->>'locksDigest'=allrice_native_control_document_digest(o->'locks')
    and p->>'processesDigest'=allrice_native_control_document_digest(o->'processes')
    and p->>'inventoryDigest'=allrice_native_control_document_digest(o->'inventory')
    and p->>'exitedEvidenceDigest'=o->>'exitedEvidenceDigest'
    and p->>'exitedEvidenceFileDigest' ~ '^sha256:[a-f0-9]{64}$'
    and o->>'exitedEvidenceDigest' ~ '^sha256:[a-f0-9]{64}$'
    and p->>'inspectDigest'=s->>'inspectDigest' and s->>'inspectDigest' ~ '^sha256:[a-f0-9]{64}$'
    and p->>'physicalIdentityDigest'=s->>'physicalIdentityDigest'
    and s->>'physicalIdentityDigest'=allrice_native_control_document_digest(o->'physical')
    and p->>'containerId'=expected->>'Id' and s->>'containerId'=expected->>'Id'
    and p->>'containerName'='/allrice-cloud-91e4fa1c-14af-499a-a2dd-d1989ce056b9'
    and s->>'containerName'=p->>'containerName' and s->>'state'='exited' and s->'pid'='0'::jsonb
    and s->'rawOwnedCloudContainers'='1'::jsonb and s->'preservedExitedContainers'='1'::jsonb
    and s->'unclassifiedOwnedCloudContainers'='0'::jsonb
    and s->'historicalOutcomeKnown'='false'::jsonb and s->'cleanupClaimed'='false'::jsonb and s->'containerRemoved'='false'::jsonb
    and s#>>'{identity,id}'=expected->>'Id' and s#>>'{identity,name}'=p->>'containerName'
    and s#>>'{identity,status}'='200'
    and s#>>'{identity,created}'='2026-10-04T02:24:40.086837435Z'
    and s#>>'{identity,state,Status}'='exited' and s#>'{identity,state,Pid}'='0'::jsonb
    and s#>'{identity,state,ExitCode}'='124'::jsonb
    and s#>'{identity,state,Running}'='false'::jsonb and s#>'{identity,state,Paused}'='false'::jsonb
    and s#>'{identity,state,Restarting}'='false'::jsonb and s#>'{identity,state,Dead}'='false'::jsonb
    and s#>'{identity,state,OOMKilled}'='false'::jsonb and s#>>'{identity,state,Error}'=''
    and s#>>'{identity,state,StartedAt}'='2026-10-04T02:24:40.454070212Z'
    and s#>>'{identity,state,FinishedAt}'='2026-10-04T02:24:45.291475245Z'
    and s#>>'{identity,restartPolicy,Name}'='no' and s#>'{identity,restartPolicy,MaximumRetryCount}'='0'::jsonb
    and s#>'{identity,autoRemove}'='false'::jsonb and s#>>'{identity,networkMode}'='none'
    and s#>'{identity,labels}'=expected->'Labels'
    and s#>>'{identity,labels,xyz.bplabs.allrice.backend}'='cloud-gvisor-v1'
    and s#>>'{identity,labels,xyz.bplabs.allrice.cloud.attempt}'='91e4fa1c-14af-499a-a2dd-d1989ce056b9'
    and s#>'{identity,mounts}'=(select jsonb_agg(jsonb_build_object('Type',m->'Type','Name',m->'Name','Source',m->'Source','Destination',m->'Destination','RW',m->'RW') order by m->>'Destination') from jsonb_array_elements(expected->'Mounts') m)
    and floor(extract(epoch from (s->>'observedAt')::timestamptz)*1000)::bigint between (o->>'observedAtMs')::bigint and (a->>'reviewedAtMs')::bigint
    and p#>>'{historicalPin,sha256}'='96f8c32c29a9cef5324f97845e8a7861f46b778952ee9067778ae2481235a2da'
    and p#>>'{inspectPin,sha256}'='cd2ca6577a2941c4316787987c45087137dc3ee0a6cca0b72a0a42bd87843d2b'
    and p#>>'{inventoryPin,sha256}'='b59255b4d7a25c7ddf1babdf7b574e4ed85cc62b6d0e1d1671290ac203525b6d'
    and s->'historicalPin'=p->'historicalPin' and s->'inspectPin'=p->'inspectPin' and s->'inventoryPin'=p->'inventoryPin') is not true then return false; end if;
  return true;
end $$;

create function allrice_native_control_cloud_absence_guard() returns trigger
  language plpgsql set TimeZone='UTC' as $$
declare o jsonb:=new.credential->'observation'; a jsonb:=new.credential->'approval';
  snap jsonb; facts jsonb; raw jsonb; now_ms bigint; h jsonb; roles text[]:='{}';
begin
  now_ms:=floor(extract(epoch from clock_timestamp())*1000);
  snap:=allrice_native_control_historical_cloud_snapshot(); facts:=allrice_native_control_upgrade_facts(new.partition_id);
  raw:=allrice_native_control_upgrade_idle();
  if (new.credential->>'kind'='native-control-cloud-absence-credential-v1'
    and o->>'kind'='native-control-cloud-absence-observation-v1'
    and o->>'planId'=new.plan_id::text and o->>'partitionId'=new.partition_id
    and o->'beforeReference'=new.before_reference and o->'afterReference'=new.after_reference
    and o->>'operationId'='44cff0b1-a2db-4953-a7b0-8e74c9f414ec'
    and o->'readerPin'->>'sha256'='96957a756e54118896bd3b75586c62d57b6f725ef263821e5a493ebed59163e9'
    and o->'baselinePin'->>'sha256'='22e6ba2d85ce9ec1a917b1c032478ccc97fa300070cbbd9a4a97121cea9bd5ce'
    and o->'sqlSnapshot'->'scope'=jsonb_build_object('database',current_database(),'schema',current_schema(),'readOnly','on')
    and ((o->'sqlSnapshot')-'scope')=snap
    and snap->'uncleanedOperationIds'='["44cff0b1-a2db-4953-a7b0-8e74c9f414ec"]'::jsonb
    and snap->'attempt'->'containerId'='null'::jsonb and snap->'attempt'->'outcomeIsNull'='true'::jsonb
    and snap->'attempt'->'cleanupConfirmedAt'='null'::jsonb
    and snap->'operation'->>'status'='unknown' and snap->'operation'->'leaseExpired'='true'::jsonb
    and snap->'operation'->>'runId'='0c350e53-4ad8-4e57-bdc0-f4472e74d0d3'
    and snap->'operation'->>'rootRunId'='0c350e53-4ad8-4e57-bdc0-f4472e74d0d3'
    and snap->'operation'->>'attemptId'='6275fd00-d4d6-4440-a340-95662caaa7b8'
    and snap->'input'->>'operationId'='44cff0b1-a2db-4953-a7b0-8e74c9f414ec'
    and snap->'input'->>'runId'='0c350e53-4ad8-4e57-bdc0-f4472e74d0d3'
    and snap->'input'->>'jobId'='6a42bf8b-9a3b-432a-9fb1-e4123bbccc8a'
    and snap->'input'->>'attemptId'='6275fd00-d4d6-4440-a340-95662caaa7b8'
    and snap->'job'->>'status'='failed' and snap->'job'->'leaseExpired'='true'::jsonb
    and snap->'run'->>'state'='failed' and jsonb_typeof(snap->'run'->'completedAt')='string'
    and snap->'receipts'->>'count'='2'
    and snap->'receipts'->'ids'='["4ab77a79-4be3-409b-a49c-4c24c0d1b9ad","5d9c2725-e96f-4e4a-a91a-8df5119b5417"]'::jsonb
    and o->'controlFacts'=facts and facts->'reference'=new.before_reference and facts->'closeFence'->'valid'='true'::jsonb
    and jsonb_typeof(o->'observedAtMs')='number' and jsonb_typeof(o->'expiresAtMs')='number'
    and (o->>'observedAtMs')::bigint between now_ms-120000 and now_ms
    and (o->>'expiresAtMs')::bigint between now_ms+1 and (o->>'observedAtMs')::bigint+120000
    and o->'inventory'->>'socketPath'=o->'physical'->>'configuredSocket'
    and o->'inventory'->>'status'='200' and allrice_native_control_cloud_inventory_valid(o,a)
    and o->'physical'->>'nameProbeStatus'='404' and o->'physical'->>'labelProbeStatus'='200'
    and o->'physical'->'labelMatchIds'='[]'::jsonb
    and o->'physical'->>'containerName'='allrice-cloud-6275fd00-d4d6-4440-a340-95662caaa7b8'
    and o->'historicalOutcomeKnown'='false'::jsonb and o->'cleanupClaimed'='false'::jsonb
    and o->'globalResourceIdleProven'='false'::jsonb
    and a->>'kind'='native-control-cloud-absence-source-approval-v1' and a->>'reviewedBy'='root'
    and a->>'observationDigest'=allrice_native_control_document_digest(o)
    and a->>'reviewPolicyDigest' ~ '^sha256:[a-f0-9]{64}$'
    and a->>'offlineProofDigest' ~ '^sha256:[a-f0-9]{64}$'
    and a->>'operatorSha256' ~ '^[a-f0-9]{64}$' and a->>'verifierSha256' ~ '^[a-f0-9]{64}$'
    and a->>'releaseSha' ~ '^[a-f0-9]{40}$' and a->>'sourceTree' ~ '^[a-f0-9]{40}$'
    and (a->>'reviewedAtMs')::bigint between (o->>'observedAtMs')::bigint and now_ms
    and jsonb_typeof(o->'lifecycle')='array' and jsonb_array_length(o->'lifecycle')=2
    and o->'lifecyclePin'->>'sha256' ~ '^[a-f0-9]{64}$') is not true
    or raw->>'clouds'<>'1' or exists(select 1 from jsonb_each_text(raw-'clouds') e where e.value<>'0')
    or allrice_native_control_upgrade_offline_valid(jsonb_build_object(
      'kind','offlineStopped','environment','dev','planId',new.plan_id,'planDigest',new.credential_digest,
      'observedAtMs',o->'observedAtMs','expiresAtMs',o->'expiresAtMs','locks',o->'locks','processes',o->'processes',
      'operatorEvidenceDigest',a->>'offlineProofDigest'),jsonb_build_object('createdAtMs',o->'observedAtMs')) is not true then
    raise exception 'native control exact cloud absence credential rejected' using errcode='P1952';
  end if;
  for h in select v from jsonb_array_elements(o->'lifecycle') e(v) loop
    if (h->'identity'->>'service' in ('web','worker') and not (h->'identity'->>'service'=any(roles))
      and h->'identity'->>'environment'='dev' and length(h->'identity'->>'bootId')>0
      and h->'producerLifecycle'->>'role'=h->'identity'->>'service'
      and h->'producerLifecycle'->'instance'->>'bootId'=h->'identity'->>'bootId'
      and h->'producerLifecycle'->>'releaseAdmission'='disabled'
      and h->'producerLifecycle'->'unknownOutcomes'='[]'::jsonb
      and (h->'producerLifecycle'->>'activeRoots')::bigint=0 and (h->'producerLifecycle'->>'pendingRoots')::bigint=0
      and (h->'producerLifecycle'->>'unresolvedRoots')::bigint=0 and (h->'producerLifecycle'->>'retainedChildren')::bigint=0
      and exists(select 1 from jsonb_array_elements(o->'processes') p where p->>'role'=h->'identity'->>'service' and p->'pid'=h->'identity'->'pid')) is not true then
      raise exception 'native control lifecycle credential rejected' using errcode='P1952';
    end if;
    roles:=array_append(roles,h->'identity'->>'service');
  end loop;
  return new;
end $$;
create trigger native_control_cloud_absence_guard before insert on allrice_native_control_cloud_absences
  for each row execute function allrice_native_control_cloud_absence_guard();

-- Scope only this immutable plan/tuple/credential. No GUC or global allowlist.
create function allrice_native_control_cloud_coverage(plan jsonb, offline jsonb default null) returns jsonb
  language plpgsql volatile as $$
declare raw jsonb:=allrice_native_control_upgrade_idle(); c allrice_native_control_cloud_absences%rowtype;
  o jsonb; preserved integer:=0; now_ms bigint:=floor(extract(epoch from clock_timestamp())*1000);
begin
  select * into c from allrice_native_control_cloud_absences
    where plan_id=(plan->>'planId')::uuid and partition_id=plan->>'partitionId'
      and credential_digest=plan->>'historicalCloudAbsenceDigest';
  if found then
    o:=c.credential->'observation';
    if raw->>'clouds'='1' and c.before_reference=plan->'beforeReference' and c.after_reference=plan->'afterReference'
      and o->'controlFacts'=plan->'facts' and (o->>'expiresAtMs')::bigint>now_ms
      and (offline is null or (offline->'locks'=o->'locks' and offline->'processes'=o->'processes'))
      and ((o->'sqlSnapshot')-'scope')=allrice_native_control_historical_cloud_snapshot() then preserved:=1; end if;
  end if;
  return jsonb_build_object('raw',raw,'rawUncleanedCloudAttempts',(raw->>'clouds')::integer,
    'preservedUnresolvedCloudAttempts',preserved,'unpreservedCloudAttempts',(raw->>'clouds')::integer-preserved,
    'historicalOutcomeKnown',false,'cleanupClaimed',false);
end $$;
create function allrice_native_control_upgrade_idle_for(plan jsonb, offline jsonb default null) returns jsonb
  language sql volatile as $$
    select (v->'raw')||jsonb_build_object('clouds',(v->>'unpreservedCloudAttempts')::integer)
    from (select allrice_native_control_cloud_coverage(plan,offline) v) q
$$;

-- Original guard bodies; only the three idle calls gain exact plan scope.
create or replace function allrice_native_control_upgrade_plan_guard() returns trigger language plpgsql as $$
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
    or exists(select 1 from jsonb_each_text(allrice_native_control_upgrade_idle_for(new.plan)) e where e.value<>'0') then
    raise exception 'native control upgrade plan is not a closed idle snapshot' using errcode='P1950';
  end if;
  return new;
end $$;

create or replace function allrice_native_control_upgrade_guard() returns trigger language plpgsql as $$
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
    or exists(select 1 from jsonb_each_text(allrice_native_control_upgrade_idle_for(plan,new.offline_attestation)) e where e.value<>'0') then
    raise exception 'native control upgrade approval, close, snapshot or offline fence rejected' using errcode='P1950';
  end if;
  return new;
end $$;

create or replace function allrice_native_control_upgrade_commit_fence() returns trigger language plpgsql as $$
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
    or exists(select 1 from jsonb_each_text(allrice_native_control_upgrade_idle_for(plan,new.offline_attestation)) e where e.value<>'0') then
    raise exception 'native control upgrade COMMIT fence lost' using errcode='P1951';
  end if;
  return new;
end $$;
