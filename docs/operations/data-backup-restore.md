# Data backup and restore

PostgreSQL and object storage form one authoritative backup set. A database dump without the matching storage snapshot is incomplete.

## Backup interface

`@allrice/storage` exposes `BackupPort` plus validated version-1 manifest readers/writers. A production backup implementation must produce:

- an encrypted PostgreSQL custom-format dump;
- an encrypted snapshot of the configured local mount or S3-compatible bucket prefix;
- the applied schema version, both artifact references and a SHA-256 checksum in one manifest.

## Reference local procedure

1. Put write APIs and workers into maintenance mode while reads may continue.
2. Record `select name from allrice_schema_migrations order by name`.
3. Run `pg_dump --format=custom --no-owner --file allrice.dump "$DATABASE_URL"`.
4. Snapshot `ALLRICE_STORAGE_ROOT` without following external symlinks.
5. Hash both artifacts, write the manifest, copy all three to encrypted off-host storage, then resume writes.

Never place credentials, signed URLs or invitation/session tokens in a manifest.

## Restore and verification

1. Restore into a new PostgreSQL database and a new empty storage root/bucket prefix.
2. Restore the database dump, then the object snapshot.
3. Point a compatible AllRice image at the restored stores and run `pnpm db:migrate` followed by `pnpm db:verify`.
4. Compare the manifest schema version and artifact checksums.
5. Sample objects from `allrice_storage_objects`, verify stored SHA-256 and ownership, then exercise signed access as the owner and denial as another user.
6. Switch traffic only after readiness and the sample checks pass. Retain the old stores until the recovery window ends.

Migrations are forward-only. The supported rollback for additive schemas `0003` and `0004` is the previous compatible 0.1 application image; do not drop columns or edit `allrice_schema_migrations` during an incident.
