-- A late question reply belongs to the Session before its next native turn exists.
-- Ordinary steers still require the exact turn and generation they target.
alter table allrice_conversation_commands alter column expected_turn_id drop not null;
alter table allrice_conversation_commands alter column expected_generation drop not null;
alter table allrice_conversation_commands add constraint allrice_command_turn_scope
  check (input_kind is not distinct from 'ask_user'
    or (expected_turn_id is not null and expected_generation is not null));
