# Skill source reading

Server-only shared readers for public GitHub sources, bounded ZIP packages and
the current DSH `FileSystemSkillProvider`. Worker imports retain their original
paths as re-exports; Web can consume this package without importing Worker tool
handlers or chat intent rules.

This module only reads and validates source bytes. It does not install a Skill,
enable a binding, publish a Workflow, write a database row, execute package code,
or grant permission. Callers must separately authenticate the owner and instance,
freeze the preview bytes and confirm the exact source before writing.

The initial extraction retains the existing limits and error contracts. The U1
body-limit alignment and Workflow framework are separate changes; this package
does not yet provide a Web preview/confirmation endpoint.
