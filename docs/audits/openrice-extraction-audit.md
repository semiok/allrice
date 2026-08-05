# OpenRice capability extraction and license audit

> Status: **Engineering audit complete; Apache-2.0 adopted; extraction approval pending reviewer sign-off**
>
> Linear: **MET-40**
>
> Audited: **2026-08-05**

## Source baseline

| Field                            | Value                                         |
| -------------------------------- | --------------------------------------------- |
| Source repository                | `https://github.com/semiok/openrice.git`      |
| Source branch                    | `main`                                        |
| Source commit                    | `ba998ea9c23740c94882b7fe7d08a58792a3e4b2`    |
| Fork commit                      | `dd834a1ecf5387fdfebbc545eb84411d0f1456b0`    |
| Fork parent / OpenLoomi baseline | `979d2b4b29f8ac015cc0e752a17204f45b3f78f9`    |
| Upstream repository              | `https://github.com/melandlabs/openloomi.git` |
| Root source license              | Apache License 2.0                            |
| AllRice maintainer               | Pumbaa / `semiok/allrice`                     |

This audit covers tracked source at the exact commit above. Build output, `node_modules`, user data, local Skills and application backups are not extraction sources.

No OpenRice source was copied into the AllRice 0.1 baseline. Future extraction must use the commit and path recorded here or a newer, separately audited baseline.

## MET-44 approved Skill record

MET-44 adds one clean-room adaptation as an import candidate rather than copying
the OpenRice Skill directory:

| Field                                   | Value                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `source_repository`                     | `https://github.com/semiok/openrice`                                                                |
| `source_commit`                         | `6149e0160893b033b4fd2d32b932b23735720949`                                                          |
| `source_path`                           | `skills/weather/SKILL.md`                                                                           |
| `source_license`                        | Apache-2.0 (OpenRice root license; the source Skill has no separate license file)                   |
| `decision`                              | R — clean-room adaptation                                                                           |
| `third_party_dependencies_and_licenses` | None; the artifact is UTF-8 instructions and NOTICE only                                            |
| `desktop_or_host_coupling_removed`      | No Tauri, symlink, home-directory discovery, shell command, or host credential lookup               |
| `AllRice_destination`                   | `apps/web/lib/skillhub/approved-skills.ts`, materialized through Storage as an immutable artifact   |
| `modifications`                         | Uses policy-exposed Codex browser tools only; requires current-data honesty and source attribution  |
| `tests`                                 | Artifact path/entrypoint validation, checksum validation, isolated materialization, Codex event map |
| `maintenance_owner`                     | M5 / `semiok/allrice`                                                                               |

The artifact contains an explicit modification/provenance NOTICE. It declares
`model:invoke` and `network:outbound`; V1 disables Codex shell and unified-exec
tools. This approval is limited to the Weather adaptation and does not approve
the OpenRice skill loader or any other Skill.

## Decision vocabulary

| Code | Decision                          | Rule                                                                                                                                                               |
| ---- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D    | Direct file-level reuse candidate | Only pure, portable files with an extraction record, retained Apache attribution, dependency review and AllRice tests. No whole package is approved automatically. |
| R    | Refactor before reuse             | Preserve useful behavior or algorithms, but reimplement around AllRice contracts, tenancy, authorization, storage and Worker boundaries.                           |
| O    | Reference or migration input only | Use to understand behavior or map old data. Do not copy production runtime code.                                                                                   |
| X    | Prohibited in AllRice V1          | Desktop, host-local, platform-specific or license-blocked runtime code must not enter the repository.                                                              |

Reviewing a module as D or R does not authorize extraction before MET-49 freezes the affected contract.

## Repository findings

The source contains 2,038 tracked files under `apps`, 393 under `packages`, 292 under `skills` and 128 under `plugins`. Static coupling scans found:

- 58 tracked files referencing Tauri APIs, `isTauri()` or desktop invocation;
- 41 tracked files coupled to SQLite or sqlite-vec;
- 157 tracked files referencing `.openloomi`, `.openrice`, home-directory discovery or host-local paths;
- 45 tracked files referencing browser local/session storage.

These counts are triage signals, not proof that every unflagged file is portable. Transitive imports and data-authority assumptions still require file-level review.

## Capability matrix

| Capability                                   | Source paths                                                                                                             | Decision                         | Coupling and required change                                                                                                                                                                                  | AllRice owner          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Web shell and employee UI                    | `apps/web/app/(chat)/**`, `apps/web/components/**`, `apps/web/hooks/**`                                                  | R, with selected D UI primitives | Many pages assume desktop feature gates, host paths, local state and OpenRice data models. Retain interaction patterns only; bind business state to server APIs and AllRice authorization.                    | MET-50                 |
| Web API routes                               | `apps/web/app/api/**`, `apps/web/app/(chat)/api/**`, `apps/web/app/(auth)/api/**`                                        | R                                | Routes mix authentication, SQLite/PostgreSQL access, connector processes and local runtime state. Rebuild behind RequestContext, repositories and versioned error contracts.                                  | MET-41, MET-42, MET-50 |
| Authentication and session                   | `apps/web/lib/auth/**`, `apps/web/lib/session/**`, auth routes                                                           | O / R                            | Existing behavior is useful as a test inventory, but AllRice needs invitation-only tenancy, new cookie/issuer/audience namespace and deny-by-default authorization.                                           | MET-41, MET-49         |
| Agent model routing and accounting           | `packages/ai/src/agent/model/**`, `routing/**`, `billing/**`, `apps/web/lib/ai/provider*`                                | R                                | Mostly server-capable, but currently callable from the Web runtime and lacks AllRice ExecutionContext, PolicySnapshot and durable Run ownership. Move execution to Worker.                                    | MET-43                 |
| Native/CLI agent bridges                     | `apps/web/lib/ai/extensions/agent/**`, `apps/web/lib/ai/native-agent/**`, `packages/ai/src/agent/native-*`, `sandbox/**` | R, high risk                     | Spawns host CLIs and can inherit broad filesystem, environment and credential access. Reuse only behind Worker isolation, capability allowlists, time/budget limits and versioned artifacts.                  | MET-43, MET-44         |
| Chat and message persistence                 | `apps/web/lib/ai/chat/**`, `apps/web/lib/chat/**`, chat routes and components                                            | R                                | Message behavior is useful, but persistence and identifiers do not satisfy tenant ownership, idempotency and recovery contracts.                                                                              | MET-50                 |
| Memory algorithms                            | `packages/ai/src/memory/**`, `packages/ai/memory-consolidation/src/**`, `apps/web/lib/memory/**`                         | R                                | Scoring, consolidation and evidence algorithms are candidates. Replace stores with tenant-scoped ports; attach source, owner, visibility and deletion propagation.                                            | MET-42, MET-50         |
| RAG and embeddings                           | `packages/ai/rag/src/**`, `packages/rag/src/**`, `apps/web/lib/ai/rag/**`                                                | R                                | Keep parser/chunking concepts and evaluate `pgvector-store`; reject SQLite/Chroma/local-transformer authority. Every query and mutation needs tenant filtering and source traceability.                       | MET-42, MET-50         |
| Files and object storage                     | `apps/web/lib/files/**`, `apps/web/lib/storage/**`, `packages/storage/**`, file routes                                   | R                                | Current implementations include host paths and public Vercel Blob behavior. AllRice requires opaque object keys, authorization or signed access, quota, checksum, retention and local/S3-compatible adapters. | MET-42                 |
| PostgreSQL schema and repositories           | `apps/web/lib/db/schema.pg.ts`, `queries.ts`, PostgreSQL migrations                                                      | O                                | The large OpenRice schema lacks the frozen AllRice ownership model and contains unrelated billing, connector and desktop-era history. Use only as behavior and migration mapping input.                       | MET-42, MET-49         |
| SQLite and IndexedDB                         | `apps/web/lib/db/schema-sqlite.ts`, `migrations-sqlite/**`, `packages/sqlite/**`, `packages/indexeddb/**`                | O                                | These are legacy source formats for MET-46. They are not AllRice runtime dependencies or schema templates.                                                                                                    | MET-46                 |
| Loop and proactive scheduling                | `apps/web/lib/loop/**`, loop routes/pages                                                                                | O for V1; R later                | Host-path, CLI, connector and in-memory assumptions are widespread. Extract decision semantics only after persistent Queue/Run contracts exist.                                                               | Future after MET-43    |
| Worker, Queue and Scheduler concepts         | scheduled-job routes, `apps/web/lib/cron/**`, `apps/web/lib/loop/scheduler.ts`                                           | O / R                            | Existing scheduling runs in the Web/desktop runtime and is not a durable lease-based queue. Use as acceptance-case inventory; implement Queue/Worker state machine in AllRice.                                | MET-43, MET-49         |
| Connector core contracts                     | `packages/integrations/src/**`, `channels/src/**`                                                                        | R                                | Adapter/event concepts are useful. Add tenant-scoped accounts, CredentialBinding, server lifecycle, rate limits, idempotency and audit. Connectors are not required for V1.                                   | Deferred               |
| Server-capable connectors                    | Calendar, Gmail, Google Docs, Feishu, DingTalk, Slack/API integrations, RSS                                              | R / D for pure parsers           | Review each connector separately. OAuth tokens and listener state must move to encrypted tenant-scoped bindings; background sync belongs in Worker.                                                           | Deferred               |
| Device/local messaging connectors            | `packages/integrations/imessage/**`, local Telegram/WhatsApp state, native listeners                                     | X for V1                         | iMessage/macOS and user-session listeners violate browser/Linux-only scope. WhatsApp also pulls GPL-licensed libsignal and needs separate legal review.                                                       | Deferred / MET-48      |
| Skill content                                | `skills/**`                                                                                                              | O; later per-Skill R/D import    | Do not copy the directory wholesale. Import an individually approved Skill through CatalogSkill → SkillVersion → SkillArtifact → SkillInstallation, with checksum, source, license and security scanning.     | MET-44, MET-46         |
| Skill discovery and state                    | workspace Skill routes/pages, `apps/web/lib/ai/skills/**`                                                                | X as implemented; R conceptually | Host-directory scans, Tauri folder selection and shared metadata/SKILL.md mutation are forbidden. Build the SkillHub authority model instead.                                                                 | MET-44, MET-49         |
| Agent plugins                                | `plugins/**`                                                                                                             | O                                | Plugins assume a local OpenRice/OpenLoomi runtime and local setup paths. Protocol ideas may inform future remote APIs, but packages are not AllRice runtime code.                                             | Deferred               |
| Audit and security utilities                 | `packages/audit/**`, `packages/security/**`, `apps/web/lib/credentials/**`                                               | R                                | SSRF and encryption logic may be extracted file by file. Replace file-based audit logs and host key management with tenant-aware AuditEvent and Secret Vault interfaces.                                      | MET-41, MET-45, MET-49 |
| Marketing application                        | `apps/marketing/**`                                                                                                      | O                                | Separate product/brand surface with non-V1 dependencies, including GSAP's non-OSI standard license.                                                                                                           | Deferred               |
| Desktop runtime                              | `apps/web/src-tauri/**`                                                                                                  | X                                | Rust, Tauri commands, updater, packaging, tray, window and native permissions are explicitly outside AllRice.                                                                                                 | MET-48                 |
| Pet, Chronicle, shortcuts and screen capture | pet/chronicle routes and components, `apps/web/lib/chronicle/**`, `lib/shortcuts/**`                                     | X                                | Desktop attention UI, macOS permissions and screen capture have no V1 server/browser replacement. Decision/Inbox concepts may be redesigned later without copying desktop code.                               | MET-48 / Deferred      |

## Direct-reuse candidates

No entire OpenRice package is approved for direct reuse. The following are technically portable candidates for later file-level extraction:

- pure UI primitives under `apps/web/components/ui/**` that have no Tauri, host-path, browser-storage or OpenRice data-model imports;
- pure RSS normalization and OPML parsing in `packages/integrations/rss/src/normalize.ts`, `opml.ts` and `tagging.ts`;
- pure filter/schema utilities in `packages/insights/src/**` after removing OpenRice-specific entity names;
- pure runtime formatting/state-machine helpers under `packages/ai/src/agent/runtime-instructions/**` after MET-49 defines the consuming contracts.

Only the UI/runtime-helper candidates are plausibly relevant to V1. RSS and Insights remain deferred.

## License review

OpenRice's root source is Apache-2.0. AllRice has adopted Apache-2.0 under the recorded [license decision](allrice-license-decision.md). This aligns source terms without making AllRice a derivative work or authorizing wholesale copying. Every extracted file still requires provenance, dependency review, retained notices and a modification record.

A production dependency scan (`pnpm licenses list --prod --json`) reported 1,579 dependency entries. Most are permissive, but the following require explicit review before any related code or dependency is imported:

| License signal          | Dependency                                         | Version        | Disposition                                                                    |
| ----------------------- | -------------------------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| GPL-3.0                 | `libsignal`                                        | 6.0.0          | Do not import with WhatsApp connector without legal approval.                  |
| GPL-3.0-or-later        | `@cryptography/aes`                                | 0.1.1          | Do not import until dependency path and distribution obligations are reviewed. |
| LGPL-3.0-or-later       | `@img/sharp-libvips-darwin-x64`                    | 1.2.4          | Desktop binary; not needed for Linux V1. Review if Sharp packaging changes.    |
| Custom standard license | `gsap`                                             | 3.15.0         | Exclude from V1 and any copied marketing/UI implementation.                    |
| Unknown                 | `@anthropic-ai/claude-agent-sdk` and Darwin binary | 0.2.141        | Verify published license before choosing the Worker runtime.                   |
| Unknown                 | Chroma default embedding packages                  | 0.1.9 / 0.1.11 | Exclude; AllRice V1 uses pgvector and separately selected embedding providers. |
| Unknown                 | `@browserbasehq/sdk`, `urlsafe-base64`             | 2.10.0 / 1.0.0 | Exclude unless a later feature requires and clears them.                       |

OpenRice has no tracked root `NOTICE` file. Several bundled Skills carry their own license files; every imported Skill must preserve its own license independently of the root repository license.

This is an engineering license inventory, not legal advice. GPL, custom and unknown results remain hard extraction gates until maintainer/legal review records a decision.

## Extraction record required for every copied file

Every extraction PR must record:

```text
source_repository
source_commit
source_path
source_license
third_party_dependencies_and_licenses
decision (D or R)
desktop_or_host_coupling_removed
AllRice_destination
modifications
tests
maintenance_owner
```

The PR must also retain required attribution, mark modified Apache files, and prove the destination does not introduce Tauri, Rust, Cargo, desktop packaging, host-local Skill authority or shared OpenRice runtime state.

## Inputs to MET-49

This audit makes the following recommendations binding inputs for contract review:

1. Define AllRice tenant, authorization, Queue, Run/Event, SSE, SkillHub and Storage contracts from the AllRice product model, not from OpenRice tables or routes.
2. Extract algorithms behind new ports; never import OpenRice repositories, migrations or host-path conventions as authority.
3. Keep Web request handling separate from Worker execution, including model/Skill/connector invocations.
4. Treat OpenRice SQLite, local files and Skill directories only as read-only MET-46 migration sources.
5. Exclude all desktop runtime code and all GPL/custom/unknown dependencies until separately approved.
6. Apply the AllRice Apache-2.0 attribution policy and add a repository `NOTICE` file if a future imported source carries applicable notice content.

## Review gate

Before large-scale extraction begins, lindong must review:

- the D/R/O/X decisions;
- the AllRice license and attribution approach;
- whether any V1 capability requires a dependency currently marked GPL, custom or unknown;
- the MET-49 contract inputs above.

Until that review is recorded, this audit permits architecture and clean-room implementation but not bulk OpenRice source migration.
