# Database package

`@allrice/database` owns PostgreSQL connection lifecycle and migration execution.

## Baseline scope

Version 0.1.0 enables pgvector and creates only migration/runtime metadata. It intentionally does not create Identity, Chat, Queue, SkillHub, EmployeeHub, or Audit business tables before MET-49 freezes their contracts.

## Migration rules

- migrations are ordered immutable SQL files;
- the runner holds a PostgreSQL advisory transaction lock;
- applied filenames are recorded in `allrice_schema_migrations`;
- Web and Worker use the same package;
- AllRice has its own database user and migration history;
- no OpenRice schema, ORM model, or table is imported.

Run with `pnpm db:migrate` after setting `DATABASE_URL`.
