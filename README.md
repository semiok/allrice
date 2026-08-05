# AllRice

AllRice is a browser-first, self-hosted AI workspace for enterprise employees. It is an independent product and repository: no desktop client, Tauri, Rust, Cargo, DMG, or host-local user skill directories are part of the runtime.

> Current version: **0.1.0 baseline**
>
> Current delivery: **MET-39 engineering foundation**
>
> Product plan: [AllRice MET-38](https://linear.app/metasnowsky/issue/MET-38/allrice-%E5%BC%80%E5%B7%A5%E8%AE%A1%E5%88%92%E7%8B%AC%E7%AB%8B%E5%9F%BA%E7%BA%BF%E5%A5%91%E7%BA%A6%E5%86%BB%E7%BB%93%E4%B8%8E-mvp-%E5%9E%82%E7%9B%B4%E9%97%AD%E7%8E%AF)

## What this version contains

Version 0.1.0 establishes a runnable foundation, not the completed SaaS product:

- a Next.js `web` process with liveness and database-readiness endpoints;
- a Node.js `worker` process with health endpoints and a scheduler heartbeat module;
- shared contracts and PostgreSQL access packages;
- PostgreSQL + pgvector, mounted storage, and reverse-proxy Compose definitions;
- lint, typecheck, test, build, and CI commands;
- detailed feature documentation with implementation status, security boundaries, data ownership, APIs, and acceptance criteria.

The worker intentionally does not execute business jobs yet. Queue, authorization, Run/Event, SkillHub, SSE replay, and Storage contracts must first be frozen in [MET-49](https://linear.app/metasnowsky/issue/MET-49/v1-%E6%A0%B8%E5%BF%83%E5%A5%91%E7%BA%A6%E5%86%BB%E7%BB%93%E7%A7%9F%E6%88%B7%E6%8E%88%E6%9D%83queueruneventskillhub-%E4%B8%8E-storage).

## Product boundary

| Product  | Audience             | Responsibility                                                                     |
| -------- | -------------------- | ---------------------------------------------------------------------------------- |
| OpenRice | Enterprise managers  | Organization governance, policy, publishing, assignment, audit, operations         |
| AllRice  | Enterprise employees | Personal AI employee, Chat/Session, files, Memory, Skills, task execution, results |

AllRice 0.1 runs independently with its own database and local invitation model. A future OpenRice integration must use versioned APIs, signed tokens, events, or explicit synchronization. The products must not share business tables, ORM models, migration history, or runtime directories.

## Architecture

```text
Browser
  -> reverse proxy
  -> web (Next.js UI / API / Auth / SSE)
       -> PostgreSQL + pgvector
       -> mounted object storage
       -> persistent job records
            -> worker (AI / Skill / Scheduler / Memory / Artifact)
```

Application processes are `web` and `worker`. Scheduler is a module inside the Worker in V1. PostgreSQL, mounted storage, and the reverse proxy are infrastructure services.

## Repository layout

```text
allrice/
├── apps/
│   ├── web/                 # employee web application and HTTP API
│   └── worker/              # background execution and scheduler host
├── packages/
│   ├── contracts/           # shared runtime-safe contracts
│   └── database/            # PostgreSQL connection and migrations
├── docs/
│   ├── architecture/        # system boundaries and decisions
│   ├── development/         # local development and contribution workflow
│   └── features/            # one detailed README per product capability
├── infra/
│   ├── docker/              # container build files
│   └── proxy/               # reverse-proxy configuration
└── compose.yaml
```

## Local development

Requirements:

- Node.js 22+
- pnpm 11+
- PostgreSQL 17 with pgvector, or Docker Compose

```bash
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm dev
```

Default endpoints:

| Service          | Endpoint                                 |
| ---------------- | ---------------------------------------- |
| Web              | `http://localhost:3000`                  |
| Web liveness     | `http://localhost:3000/api/health/live`  |
| Web readiness    | `http://localhost:3000/api/health/ready` |
| Worker liveness  | `http://localhost:3101/health/live`      |
| Worker readiness | `http://localhost:3101/health/ready`     |

The readiness endpoints require `DATABASE_URL`. The liveness endpoints only prove that the process is running.

## Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

The proxy listens on `http://localhost:8080`. PostgreSQL and application storage use named volumes. Compose is the V1 deployment shape; Kubernetes and Redis are explicitly out of scope.

## Validation

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Feature documentation

Start at [docs/README.md](docs/README.md). Every feature document records:

- implementation status;
- product scope and non-goals;
- authority and tenant boundary;
- expected data and API contracts;
- security requirements;
- acceptance criteria;
- owning Linear issue.

## Development rules

- Do not copy the OpenRice repository wholesale.
- Any extracted code must record source repository, source commit, path, license, dependencies, and maintenance owner.
- Business data must be server-authoritative; `localStorage` is limited to non-sensitive UI preferences.
- Every resource query must apply organization, workspace, owner, visibility, and authorization rules.
- Do not implement business Queue, Skill, or Storage schemas before MET-49 freezes their contracts.
- Use focused branches and pull requests. Do not merge feature work directly into `main`.

## License

The project license and any reusable OpenRice code provenance are pending the MET-40 source and license audit. No OpenRice source has been copied into this baseline.
