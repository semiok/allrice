# Database package

`@allrice/database` owns PostgreSQL connection lifecycle and migration execution.

## Implemented scope

Version 0.1 enables pgvector, migration/runtime metadata, the MET-41 identity foundation, MET-42 tenant data, MET-43 Queue/Run execution, MET-44 SkillHub and the Rice EmployeeHub/workspace. Session, Message, attachment, Memory, RAG chunk, Run, EmployeeRun and storage rows carry organization/workspace/owner fields with composite tenant foreign keys.

## Migration rules

- migrations are ordered immutable SQL files;
- the runner holds a PostgreSQL advisory transaction lock;
- applied filenames are recorded in `allrice_schema_migrations`;
- Web and Worker use the same package;
- AllRice has its own database user and migration history;
- no OpenRice schema, ORM model, or table is imported.
- migrations are forward-only; additive `0003`/`0004` remain readable by the previous supported 0.1 application image, which is the supported application rollback path.

`0004_employee_workspace.sql` adds the base Employee/Assignment and workspace records. `0007_employeehub_rice.sql` adds immutable manifest/provider/SkillVersion snapshots plus durable EmployeeRun and ordered step evidence. Rice provisioning and explicit default Assignment selection are server-side and checksum-protected.

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
