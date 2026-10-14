-- Retirement only separates future model context. It does not revoke the
-- original Run, its immutable receipts or readable conversation history.
alter table allrice_employee_content_contexts add column retired_at timestamptz;
drop index allrice_employee_content_context_current;
create unique index allrice_employee_content_context_current
  on allrice_employee_content_contexts(session_id)
  where invalidated_at is null and retired_at is null;

-- Exact authoring provenance also excludes memory written before entry into
-- the controlled candidate tool, without hiding unrelated earlier memories.
alter table allrice_employee_runs add column method_authoring boolean not null default false;
