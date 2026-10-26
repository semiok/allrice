-- MET-214: invitation links are retired. Accounts are created by platform
-- administrators (organization people) or, for the first account, by the
-- trusted `identity:bootstrap` command. Rows held only token hashes of links
-- that nothing can accept any more; memberships and users are not touched.
drop table if exists allrice_invitations;
