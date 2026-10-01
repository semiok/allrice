-- Use the existing task clock/resource projection for local admission waits.
alter table allrice_task_resource_waits drop constraint allrice_task_resource_waits_reason_check;
alter table allrice_task_resource_waits add constraint allrice_task_resource_waits_reason_check
  check (reason in ('sandbox_capacity','memory_pressure','fair_queue','local_busy','local_preparing','none'));
