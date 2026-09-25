-- Presentation preferences belong to the account, across employees/workspaces.
create table allrice_user_preferences (
  user_id uuid primary key references allrice_users(id) on delete cascade,
  streaming_output boolean not null default false,
  updated_at timestamptz not null default now()
);
