-- MET-266: one shared host admission/version authority; no Agent/job state.
alter table person_virtual_machines
  add column admission_version uuid,
  add column admission_state jsonb not null default '{}'::jsonb,
  add column admission_revision bigint not null default 0 check (admission_revision >= 0);

create table person_vm_admission_permits (
  permit_id uuid primary key,
  person_id uuid not null references person_virtual_machines(person_id),
  vm_id uuid not null,
  organization_id uuid not null,
  instance_id uuid not null,
  lease_epoch bigint not null,
  participant text not null check (participant in ('gateway','entry')),
  operation_id text not null check (length(operation_id) > 0),
  owner_ref uuid not null,
  disposition text not null check (disposition in ('queued','active','deferred')),
  freeze_id uuid,
  freeze_version uuid,
  created_at timestamptz not null default now(),
  unique(person_id, instance_id, lease_epoch, participant, operation_id),
  check ((disposition = 'deferred') = (freeze_id is not null and freeze_version is not null))
);
create index person_vm_admission_person on person_vm_admission_permits(person_id);

-- A hint only: subscribers always re-read durable state after setup/reconnect.
create function person_vm_admission_changed() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  perform pg_notify('allrice_person_vm_admission', new.person_id::text);
  return new;
end;
$$;
create trigger person_vm_admission_changed after update of
  admission_revision, admission_version, instance_id, lease_epoch, phase, lease_owner, holds
  on person_virtual_machines for each row execute function person_vm_admission_changed();
