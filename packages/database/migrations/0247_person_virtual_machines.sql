-- MET-266: host storage / ownership leases / one-way audit, not Agent state.
-- Global person identity is unique. No employee FK/cascade can delete a person's disk.
create table person_virtual_machines (
  person_id uuid primary key,
  vm_id uuid not null unique,
  organization_id uuid not null,
  phase text not null check (phase in ('stopped','starting','running','cold','failed','deleted')),
  disk_tier text not null check (disk_tier in ('warm','cold')),
  disk_retained boolean not null default true,
  native_created boolean not null default false,
  instance_id uuid,
  lease_epoch bigint not null default 0 check (lease_epoch >= 0),
  lease_owner uuid,
  lease_expires_at timestamptz,
  egress_receipt jsonb,
  gateway_ports jsonb not null default '[]'::jsonb check (jsonb_typeof(gateway_ports) = 'array'),
  holds jsonb not null default '[]'::jsonb check (jsonb_typeof(holds) = 'array'),
  last_activity_at timestamptz not null default now(),
  stopped_at timestamptz,
  idle_since timestamptz,
  activity_observed_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((lease_owner is null) = (lease_expires_at is null)),
  check (phase <> 'running' or (instance_id is not null and egress_receipt is not null and native_created))
);

create table person_vm_audit (
  id bigint generated always as identity primary key,
  vm_id uuid not null,
  person_id uuid not null,
  organization_id uuid not null,
  request_id uuid not null,
  action text not null,
  result text not null check (result in ('started','succeeded','failed','denied')),
  error_code text,
  lease_epoch bigint not null,
  created_at timestamptz not null default now()
);
create index person_vm_audit_vm on person_vm_audit(vm_id, id);
