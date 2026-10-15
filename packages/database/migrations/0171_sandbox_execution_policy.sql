-- NULL is inheritance. Existing quota overrides must not become explicit
-- ten-minute sandbox limits merely because this migration ran.
alter table allrice_model_resource_limits
  add column max_sandbox_execution_ms integer
    check (max_sandbox_execution_ms in (600000,1800000,3600000));
