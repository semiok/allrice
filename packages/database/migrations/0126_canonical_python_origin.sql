-- Keep original model arguments separate from the compact command delegation.
-- The existing UPDATE/DELETE immutability trigger also protects this column.
alter table allrice_cloud_execution_inputs
  add column original_arguments jsonb;
