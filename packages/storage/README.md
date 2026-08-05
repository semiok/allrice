# Storage package

`@allrice/storage` implements the MET-42 object-store boundary.

- `LocalStorageAdapter` stores tenant-prefixed opaque keys below `ALLRICE_STORAGE_ROOT`, writes atomically and verifies byte size plus SHA-256 before commit.
- `S3CompatibleStorageAdapter` uses the same `StoragePort` contract with an injected S3-compatible client, so application and database code do not depend on a vendor SDK.
- `SignedAccessService` issues short-lived HMAC grants bound to object, subject, operation, nonce and expiry. Production must provide `ALLRICE_STORAGE_SIGNING_SECRET` with at least 32 random bytes.
- `BackupPort` and versioned manifests define the database/object snapshot handoff described in the [backup runbook](../../docs/operations/data-backup-restore.md).

PostgreSQL metadata remains authoritative. Adapter callers must authorize the resource and persist/revoke the signed-grant nonce through `@allrice/database`; possession of an object key alone never grants access.
