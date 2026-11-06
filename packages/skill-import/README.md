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
body-limit alignment and Workflow framework are separate changes.

`SkillPreviewTokens` attests exact source bytes, provenance, owner/workspace,
instance and update target for the browser preview endpoint. It is stateless:
the source bytes travel inside the signed payload, with an 8 MB decoded limit;
no temporary objects, database rows or cleanup lifecycle are created. The token
is not encrypted and must be treated as private source content, kept in page
memory, never logged or rendered. An 8 MB source produces about 10.7 MB of
base64url payload plus bounded metadata.

The Web preview reads only a root `SKILL.md`; the optional `rootOnly` GitHub
reader mode does not alter existing chat callers. The preview neither grants
write access nor proves that a later installation will succeed. Confirmation
must verify this signature and scope, reparse the exact returned bytes, recheck
current authority, collisions, capacity, CAS and revocation under writer locks,
then write using the existing storage and installation transactions. It must
not refetch a moving GitHub branch. No confirmation endpoint exists in this
slice; multi-instance update impact remains a separate decision.
