# Database package

`@allrice/database` owns PostgreSQL connection lifecycle and migration execution.

## Implemented scope

Version 0.1 enables pgvector, migration/runtime metadata and the MET-41 identity foundation: User, Organization, Workspace, Project, Membership, Invitation, Session, PolicySnapshot, Settings, CredentialBinding metadata and AuditEvent. Queue, SkillHub and employee business tables remain owned by their feature issues.

## Migration rules

- migrations are ordered immutable SQL files;
- the runner holds a PostgreSQL advisory transaction lock;
- applied filenames are recorded in `allrice_schema_migrations`;
- Web and Worker use the same package;
- AllRice has its own database user and migration history;
- no OpenRice schema, ORM model, or table is imported.

Run with `pnpm db:migrate` after setting `DATABASE_URL`.

## Identity security

- Passwords use versioned Node `scrypt` hashes with random salts.
- Invitation and Session bearer tokens are random and only SHA-256 hashes are persisted.
- Session creation, tenant selection and invitations are server-side operations.
- CredentialBinding stores only a vault key and non-secret metadata; Secret values belong behind the `SecretVault` interface.
- Composite tenant foreign keys prevent a child record from naming a Workspace in another Organization.
