-- Append-only receipts for actual reference excerpts returned to an execution.
-- Binding a file or reading a scene directory does not create a receipt.
alter table allrice_employee_runs add column reference_reads jsonb,
  add check (reference_reads is null or
    (content_generation_id is not null and jsonb_typeof(reference_reads)='array'
     and jsonb_array_length(reference_reads) between 1 and 64) is true);
create function allrice_employee_reference_reads_immutable() returns trigger language plpgsql as $$
begin
  if old.reference_reads is not null and
    (new.reference_reads is null or not (new.reference_reads @> old.reference_reads)) then
    raise exception 'reference read receipts are immutable';
  end if;
  return new;
end $$;
create trigger allrice_employee_reference_reads_immutable before update on allrice_employee_runs
  for each row execute function allrice_employee_reference_reads_immutable();

-- All publication paths (export, local, cloud, assistant and browser) already
-- insert the same immutable version record. Freeze sources here, once per
-- version, so later scene reads cannot change an older artifact's provenance.
-- Caller-supplied source claims are never accepted as execution evidence.
create function allrice_artifact_reference_reads() returns trigger language plpgsql as $$
declare reads jsonb;
begin
  select er.reference_reads into reads from allrice_employee_runs er
    where er.run_id=new.run_id and er.organization_id=new.organization_id
      and er.workspace_id=new.workspace_id and er.owner_id=new.owner_id;
  new.provenance := new.provenance - 'referenceReads';
  if reads is not null then
    new.provenance := new.provenance || jsonb_build_object('referenceReads', reads);
  end if;
  return new;
end $$;
create trigger allrice_artifact_reference_reads before insert on allrice_workbench_artifacts
  for each row execute function allrice_artifact_reference_reads();
