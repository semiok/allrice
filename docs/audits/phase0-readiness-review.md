# Phase 0 readiness review

> Status: **Ready for pull-request review**
>
> Scope: **MET-39 and MET-40**
>
> Reviewed: **2026-08-05**

## Review scope

This review covers the AllRice 0.1 baseline completion changes after the
initial repository merge: Linux/Compose startup, contributor bootstrap,
environment handling, database migration verification, third-party provenance
rules and repository licensing.

## Findings and resolutions

| Finding                                                                                                                 | Risk                                                                        | Resolution                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| The documented native startup required manual `.env` propagation and could leave Web/Worker live but database-not-ready | A fresh clone did not reliably reproduce a working environment              | `pnpm dev` now loads one environment, provisions an isolated database when needed, migrates, verifies and starts both processes |
| Native storage default pointed at the container path `/var/lib/allrice/storage`                                         | Local development could fail on permissions or write outside the repository | Native default is the ignored `.local/storage`; Compose keeps the container path explicitly                                     |
| Migration success did not prove the expected ledger, baseline metadata or pgvector state                                | Drift or partial setup could pass unnoticed                                 | `pnpm db:verify` checks repository migrations, metadata and pgvector before service startup                                     |
| CI did not exercise the contributor bootstrap or a full empty-database Linux stack                                      | Documentation and Docker definitions could regress independently            | CI now runs the developer bootstrap and a separate production Compose smoke with readiness checks                               |
| The repository had no declared license                                                                                  | Contributions and future third-party extraction had ambiguous terms         | AllRice adopted Apache-2.0 and recorded attribution/dependency policy                                                           |
| External source reuse lacked a file-level provenance rule                                                               | Host-path, schema and license coupling could leak into AllRice              | MET-40 records prohibited surfaces and per-file provenance requirements                                                         |
| Development signal forwarding sent duplicate SIGINT to watched Worker processes                                         | Interactive shutdown produced forced-kill noise                             | The launcher only forwards service-manager SIGTERM; terminal SIGINT follows the foreground process group                        |

No external product source was copied by these changes.

## Acceptance evidence

- `pnpm format:check`, lint, typecheck, unit tests and production builds pass.
- A fresh isolated PostgreSQL 17 database applied `0001_baseline.sql` and verified pgvector 0.8.6.
- Re-running setup is idempotent.
- Native Web and Worker readiness both returned HTTP 200 using the provisioned database.
- The Linux/Compose smoke built production images, started an empty database, completed migration, verified Web/Worker readiness, migration state and pgvector, then removed test containers and volumes.
- The current AllRice production dependency inventory was reviewed while selecting Apache-2.0; third-party terms remain independently binding.

## Remaining gate

lindong must review the Apache-2.0 attribution policy and dependency
exclusions before any bulk third-party extraction. No external source
extraction is authorized until that sign-off is recorded.
