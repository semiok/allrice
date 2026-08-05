# Database package

`@allrice/database` owns PostgreSQL connection lifecycle and migration execution.

## Implemented scope

Version 0.1 enables pgvector, migration/runtime metadata, the MET-41 identity foundation and the MET-42 tenant data foundation. Session, Message, Memory, RAG chunk, Run and storage rows carry organization/workspace/owner/visibility fields with composite tenant foreign keys. Queue, SkillHub and employee product behavior remain owned by their feature issues.

## Migration rules

- migrations are ordered immutable SQL files;
- the runner holds a PostgreSQL advisory transaction lock;
- applied filenames are recorded in `allrice_schema_migrations`;
- Web and Worker use the same package;
- AllRice has its own database user and migration history;
- no OpenRice schema, ORM model, or table is imported.
- migrations are forward-only; additive `0003` remains readable by the previous supported 0.1 application image, which is the supported application rollback path.

Run with `pnpm db:migrate` after setting `DATABASE_URL`.

## Identity security

- Passwords use versioned Node `scrypt` hashes with random salts.
- Invitation and Session bearer tokens are random and only SHA-256 hashes are persisted.
- Session creation, tenant selection and invitations are server-side operations.
- CredentialBinding stores only a vault key and non-secret metadata; Secret values belong behind the `SecretVault` interface.
- Composite tenant foreign keys prevent a child record from naming a Workspace in another Organization.

## Data and vector isolation

- File lookup first filters organization and optional selected Workspace, then applies deny-by-default resource authorization.
- pgvector recall includes organization, Workspace and owner/visibility predicates in the SQL query.
- Storage quota checks take a tenant advisory lock to prevent concurrent over-allocation.
- Signed grants are stored by nonce and are checked for object, subject, operation, expiry and revocation.
