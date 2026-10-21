alter table allrice_chat_sessions add column pinned_at timestamptz;

create index allrice_chat_sessions_pin_page_idx on allrice_chat_sessions
  (organization_id, workspace_id,
   (pinned_at is not null and archived_at is null) desc, updated_at desc, id desc);
