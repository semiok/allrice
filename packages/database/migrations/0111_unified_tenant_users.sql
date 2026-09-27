-- Current tenant membership has one regular user role. Historical snapshots and
-- explicitly read-only memberships are retained; platform authority is separate.
update allrice_memberships
set role = 'member', updated_at = clock_timestamp()
where role = 'admin';

-- Invitations issued before this change must not restore a tenant-admin role.
update allrice_invitations set role = 'member' where role = 'admin';
