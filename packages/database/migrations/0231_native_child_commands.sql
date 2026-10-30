-- N4: existing request/receipt ledger only; no child execution state or queue.
alter table allrice_conversation_commands
  add column target_run_id uuid,
  add column native_input jsonb,
  alter column followup_run_id drop not null,
  alter column client_user_message_id drop not null,
  alter column expected_turn_id drop not null,
  alter column message drop not null,
  drop constraint allrice_conversation_commands_command_type_check,
  add foreign key (organization_id,workspace_id,target_run_id)
    references allrice_runs(organization_id,workspace_id,id),
  add constraint conversation_command_shape check (
    (command_type='steer' and target_run_id is null and native_input is null
      and followup_run_id is not null and client_user_message_id is not null
      and expected_turn_id is not null and message is not null)
    or (command_type in ('child_prompt','child_interrupt')
      and target_run_id is not null and native_input is not null
      and followup_run_id is null and client_user_message_id is null
      and expected_turn_id is null and message is null and input_kind is null
      and delivery_attempts in (0,1)
      and (native_input#>>'{scope,rootRunId}'=target_run_id::text) is true
      and (native_input#>>'{scope,generation}'=expected_generation::text) is true
      and (native_input#>>'{input,requestId}'=id::text) is true
      and ('child_'||(native_input#>>'{input,kind}')=command_type) is true)
  );

create function allrice_child_command_immutable() returns trigger language plpgsql as $$
begin
  if (old.command_type<>'steer' or new.command_type<>'steer') and
    row(new.id,new.organization_id,new.workspace_id,new.session_id,new.owner_id,
      new.command_type,new.target_run_id,new.expected_generation,new.native_input)
    is distinct from
    row(old.id,old.organization_id,old.workspace_id,old.session_id,old.owner_id,
      old.command_type,old.target_run_id,old.expected_generation,old.native_input)
  then raise exception 'immutable native child command'; end if;
  return new;
end $$;
create trigger immutable_native_child_command before update on allrice_conversation_commands
  for each row execute function allrice_child_command_immutable();
