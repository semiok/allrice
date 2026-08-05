# OpenRice data and Skill migration

> Status: **Planned**
>
> Linear: **MET-46**

## User outcome

An existing OpenRice user can preview and import supported data and Skills into AllRice once, with ownership, counts, checksums, failures and recovery made explicit.

## Sources

- supported OpenRice SQLite entities;
- local Library/files and RAG metadata;
- local Skills and their enabled/favorite state;
- selected non-secret settings;
- Connector account metadata without copying Keychain/token secrets.

## Import phases

1. discover source and version;
2. dry-run inventory without business writes;
3. validate ownership, type, checksum and compatibility;
4. map to AllRice Organization/Workspace/User and authoritative models;
5. execute idempotently;
6. report created, updated, skipped and failed items;
7. verify counts/checksums and recovery.

## Skill mapping

Local Skills become CatalogSkill, immutable SkillVersion, immutable SkillArtifact and target-specific SkillInstallation. Host paths and credentials are never imported into Artifact metadata.

## Security

- source is read-only;
- path traversal and symlink escape are rejected;
- secrets are redacted or require re-authorization;
- every imported record receives explicit owner and visibility;
- repeat import must not duplicate business records.

## Acceptance

Dry-run writes no business data. Re-running after partial failure converges. Reports include source version, checksum, target owner, result and recovery guidance. AllRice no longer reads OpenRice source after import.
