-- Extend the existing feedback store; no duplicate message or task history.
alter table allrice_run_feedback
  add column id uuid not null default gen_random_uuid() unique,
  add column category text check (category in ('task-result', 'instruction-following',
    'product-interaction', 'service-stability', 'resource-cost', 'security-privacy-permission', 'other')),
  add column version uuid not null default gen_random_uuid(),
  add column review_status text not null default 'new'
    check (review_status in ('new', 'reviewing', 'resolved')),
  add column review_note text not null default '',
  add column reviewed_by uuid references allrice_users(id),
  add column reviewed_at timestamptz;

update allrice_run_feedback set review_status='resolved' where reviewed;
create index allrice_run_feedback_inbox on allrice_run_feedback (review_status, updated_at desc, id);
