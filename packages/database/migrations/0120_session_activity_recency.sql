-- Employee publication/assignment refresh used to touch every chat's updated_at.
-- DSH's native row uses that value for both recency and relative-time labels.
-- Reconstruct the latest actual conversation activity, keeping explicit user
-- edits/archives and empty-session creation. Do not modify messages or versions.
-- Lock session writes while reconstructing so a concurrent send cannot be aged.
lock table allrice_chat_sessions in share row exclusive mode;

with activity as (
  select s.id, greatest(
    s.created_at,
    s.archived_at,
    (select max(m.created_at) from allrice_messages m
      where m.session_id = s.id and m.organization_id = s.organization_id
        and m.workspace_id = s.workspace_id),
    (select max(a.occurred_at) from allrice_audit_events a
      where a.resource_type = 'chat_session' and a.resource_id = s.id
        and a.organization_id = s.organization_id and a.workspace_id = s.workspace_id
        and a.action in ('session.update', 'session.archive')
        and a.decision = 'allowed')
  ) as last_activity_at
  from allrice_chat_sessions s
)
update allrice_chat_sessions s
set updated_at = activity.last_activity_at
from activity
where s.id = activity.id and s.updated_at > activity.last_activity_at;
