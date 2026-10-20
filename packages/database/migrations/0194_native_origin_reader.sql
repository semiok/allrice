-- Preserve business origin and actual first writer separately. This is only
-- an exact approved unbound-origin adoption, not an update to any old writer.
alter table allrice_native_session_bindings
  add column origin_reader_approval_digest text
  check (origin_reader_approval_digest is null or
    (origin_reader_approval_digest ~ '^sha256:[a-f0-9]{64}$'
      and context_kind='chat' and binding_basis='business_root_origin'
      and distribution_generation='dsh-0.2.1-rc.2-687f282' and profile_id='restricted'));
-- The existing immutable-row trigger also protects this new evidence field.
