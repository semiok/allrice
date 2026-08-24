# AllRice local database backups

This directory is reserved for local development backups and is intentionally
excluded from version control. SQL and dump files can contain tenant-scoped
conversations, employee prompts, automation records, and other local data.

Generate backups locally when needed, keep them outside the public repository,
and restore them only into a controlled development environment. The checked-in
source of truth for database structure is the migration set under
`packages/database/migrations/`.
