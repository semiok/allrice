-- New accounts keep streaming output enabled without replacing saved choices.
alter table allrice_user_preferences
  alter column streaming_output set default true;
