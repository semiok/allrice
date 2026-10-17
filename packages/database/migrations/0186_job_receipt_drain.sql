-- Stop admission immediately, while retaining only the original live Worker
-- incarnation for a fixed receipt window. These are not execution extensions.
alter table allrice_jobs
  add column drain_reason text check (drain_reason in ('cancel', 'timeout')),
  add column drain_deadline_at timestamptz,
  add constraint allrice_job_drain_pair check (
    (drain_reason is null) = (drain_deadline_at is null)
  );
