-- MET-151: retain all existing overrides; allow the same user in two tenants
-- to receive independent limits. NULL organization rows remain platform defaults.
alter table allrice_model_resource_limits
  drop constraint allrice_model_resource_limits_scope_type_scope_id_key;
create unique index allrice_model_resource_limits_tenant_scope_key
  on allrice_model_resource_limits(organization_id,scope_type,scope_id)
  where organization_id is not null;
create unique index allrice_model_resource_limits_platform_scope_key
  on allrice_model_resource_limits(scope_type,scope_id)
  where organization_id is null;
