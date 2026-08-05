# File storage

> Status: **MET-49 contract frozen; implementation pending MET-42**
>
> Linear: **MET-42, MET-49**

## User outcome

Employees upload files to a Session, reference them in Chat, download authorized files and delete their own data without seeing server filesystem paths.

## V1 implementation

V1 uses a mounted server directory behind a Storage interface. Object keys, metadata and authorization are authoritative; the host path is an implementation detail. The same interface must support a future S3-compatible backend.

## Core data

```text
files
file_references
artifacts
audit_events
```

Each object records organization, workspace, owner, visibility, object key, content type, byte size, checksum, status, retention and timestamps.

## API behavior

- initialize/complete upload;
- authenticated upload proxy or signed upload;
- short-lived signed download or authenticated download proxy;
- metadata lookup without host path;
- delete with reference/retention checks;
- quota and allowed-type errors.

## Security

- normalize object keys and reject traversal or absolute paths;
- inspect size and MIME/type policy;
- prevent cross-tenant signed URL reuse;
- expire and revoke signed access after deletion;
- never put Secrets or credentials in file metadata;
- record create/read-sensitive/delete actions as required by policy.

## Failure and recovery

Incomplete uploads are collectible. Parsing failure does not prevent download or deletion. Backup and restore must preserve both database metadata and objects with checksum verification.

## Acceptance

User A cannot access User B's file by URL, guessed ID, object key or vector reference. Old signed access fails after expiry/deletion. Backup/restore returns matching checksums and ownership.
