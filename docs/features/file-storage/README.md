# File storage

> Status: **MET-42 foundation and MET-50 Session workflow implemented**
>
> Linear: **MET-42, MET-49, MET-50**

## User outcome

Employees upload files to a Session, reference them in Chat, download authorized files and delete their own data without seeing server filesystem paths.

## V1 implementation

V1 uses a mounted server directory behind `StoragePort`. `LocalStorageAdapter` writes verified content atomically; `S3CompatibleStorageAdapter` accepts an injected S3-compatible object client without changing callers. PostgreSQL metadata and authorization are authoritative; the host path is never returned by an API.

## Core data

`allrice_storage_objects`, `allrice_storage_quotas`, `allrice_storage_access_grants` and `allrice_audit_events` are implemented by `0003_data_storage.sql`. MET-50 migration `0004_employee_workspace.sql` adds Session file references and Message attachments.

Each object records organization, workspace, owner, visibility, object key, content type, byte size, checksum, status, retention and timestamps.

## API behavior

- `POST /api/v1/files` performs an authenticated, size/checksum-verified upload;
- `POST /api/v1/sessions/:id/attachments` validates Session ownership and an allowlisted MIME type before creating a private reference;
- `POST /api/v1/files/:id/sign` issues a 1–900 second HMAC grant after resource authorization;
- `GET /api/v1/files/:id?token=...` verifies signature, scope, expiry, nonce state and object lifecycle;
- `DELETE /api/v1/files/:id` enforces resource policy, retention and immutability, then revokes grants;
- workspace quota is serialized per tenant and defaults to 1 GiB until explicitly configured.

## Security

- normalize object keys and reject traversal or absolute paths;
- inspect size and MIME/type policy;
- prevent cross-tenant signed URL reuse;
- expire and revoke signed access after deletion;
- never put Secrets or credentials in file metadata;
- record create/read-sensitive/delete actions as required by policy.

## Failure and recovery

Failed uploads are marked deleted and do not consume active quota. Database metadata and the mounted storage volume survive independent service restarts. Backup and restore must preserve both stores; follow the [data backup and restore runbook](../../operations/data-backup-restore.md).

## Acceptance

The Compose smoke creates two users and two Workspaces and proves that an organization admin cannot sign or download a member's private file, while its owner can. A shared Session masks that private attachment from the admin. The smoke rejects invalid signed tokens, re-downloads the same checksum-backed content after PostgreSQL/Web restart, then proves deletion revokes access and removes file-sourced Memory chunks. Unit tests cover integrity failure, signed-token tampering and adapter restart.
