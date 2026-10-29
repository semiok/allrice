-- MET-210 executor-first retirement. The legacy executor is removed in code.
-- All 17 legacy tables, their rows and generic provenance remain passive history;
-- this migration neither destroys them nor manufactures physical stop evidence.
-- Future data destruction requires its own forward migration and release review.
-- Remove the retired preference, preserving each cloud/computer value. Never
-- translate it to nativePreferences, a new opt-in, a depth or a capability grant.
update allrice_member_work_automation set settings=settings-'assistants'
  where settings ? 'assistants';
-- Existing operation confirmation choices remain exact; only the obsolete key
-- is removed from their frozen snapshot. No policy decision or receipt changes.
alter table allrice_runtime_operations disable trigger allrice_operation_member_automation_immutable;
update allrice_runtime_operations set member_automation=member_automation#-'{settings,assistants}'
  where member_automation->'settings' ? 'assistants';
alter table allrice_runtime_operations enable trigger allrice_operation_member_automation_immutable;
update allrice_runs set input=input-'assistantConfiguration' where input ? 'assistantConfiguration';
update allrice_jobs set payload=payload#-'{input,assistantConfiguration}' where payload->'input' ? 'assistantConfiguration';

-- Remove the obsolete installable entry; frozen bundles referenced by ordinary
-- historical employee versions remain historical content, never a live tool.
update allrice_platform_dsh_skills set enabled=false,updated_at=clock_timestamp()
where id='d78b3556-821a-5550-bf13-d9dd84b9bbe0' and source='allrice' and enabled;
