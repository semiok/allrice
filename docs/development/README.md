# Development workflow

## Requirements

- Node.js 22+
- pnpm 11+
- PostgreSQL 17 with pgvector, or Docker Compose

## Setup

```bash
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm dev
```

`pnpm dev` starts Web and Worker. Without PostgreSQL, liveness endpoints work while readiness endpoints return 503. That distinction is intentional.

## Commands

| Command             | Purpose                                             |
| ------------------- | --------------------------------------------------- |
| `pnpm dev`          | Run Web and Worker                                  |
| `pnpm db:migrate`   | Apply ordered SQL migrations under an advisory lock |
| `pnpm format:check` | Verify formatting                                   |
| `pnpm lint`         | Run static rules                                    |
| `pnpm typecheck`    | Typecheck every workspace package                   |
| `pnpm test`         | Run unit/contract tests                             |
| `pnpm build`        | Build packages and applications                     |

## Branches and pull requests

- Work from current `main` on a focused issue branch.
- M5 branches use `m5/MET-<id>-<description>`.
- A PR must reference its Linear issue and list validation performed.
- Do not merge your own PR unless explicitly authorized.
- Do not combine unrelated user changes.

## Code extraction

Do not copy OpenRice wholesale. Before extracting code, MET-40 must record source repository, commit, path, license, dependencies, coupling classification, compatibility markers, and future maintenance owner.

## Definition of documented

A feature PR updates its feature README with:

1. current implementation status;
2. user and product scope;
3. authority and tenant boundary;
4. data/API/event changes;
5. security and privacy behavior;
6. operational and migration impact;
7. acceptance tests;
8. Linear issue and follow-up gaps.

Use the [feature README template](../templates/feature-readme-template.md).
