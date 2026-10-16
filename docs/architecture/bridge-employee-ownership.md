# Bridge ownership in an organization

A Bridge belongs to `(organization_id, owner_id)`. Pairing a replacement computer
revokes only that employee's previous computer in the same company. Other
employees can pair concurrently. PostgreSQL enforces one active device for this
key, and pairing serializes on the same key. A pending one-time code is checked
again against the active account, membership, organization and execution scope
when consumed.

`workspace_id` remains an internal binding for existing execution evidence,
folder grants and file permissions. It does not define device replacement.
Migration 0179 removes the old workspace-wide unique index and policy, normalizes
the legacy personal labels of organization default scopes, and removes expired
pairing/connection caches. Company conversations, files and terminal execution
receipts retain their original IDs and bindings. Previously revoked device
credentials are never automatically re-enabled.

Only the device API's explicit credential rejection stops reconnecting and
enables re-pairing. Transport failures, proxy errors and unreadable credentials
retain the current identity. The desktop controller stops the old runtime,
rechecks its credential with the original service, then consumes the user's new
one-time code. Successful pairing uses a new device and journal namespace;
unsuccessful pairing retains the old configuration and evidence.
