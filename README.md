# AllRice

AllRice is a browser-first, self-hosted AI workspace for enterprise employees. It is an independent product and repository: no desktop client, Tauri, Rust, Cargo, DMG, or host-local user skill directories are part of the runtime.

> Current version: **0.1.0 baseline**
>
> Current delivery: **MET-51 Rice conversation runtime plus MET-53–55 governed Skills**
>
> Product plan: [AllRice MET-38](https://linear.app/metasnowsky/issue/MET-38/allrice-%E5%BC%80%E5%B7%A5%E8%AE%A1%E5%88%92%E7%8B%AC%E7%AB%8B%E5%9F%BA%E7%BA%BF%E5%A5%91%E7%BA%A6%E5%86%BB%E7%BB%93%E4%B8%8E-mvp-%E5%9E%82%E7%9B%B4%E9%97%AD%E7%8E%AF)

## What this version contains

Version 0.1.0 establishes a runnable employee loop, not the completed SaaS product:

- a Next.js `web` process with liveness and database-readiness endpoints;
- a Node.js `worker` process with health endpoints and a scheduler heartbeat module;
- shared contracts and PostgreSQL access packages;
- PostgreSQL + pgvector, mounted storage, and reverse-proxy Compose definitions;
- lint, typecheck, test, build, and CI commands;
- detailed feature documentation with implementation status, security boundaries, data ownership, APIs, and acceptance criteria.
- an invitation-only employee workspace with default versioned AI assignment, persistent Chat/Session, private attachments and explicit Memory.
- a PostgreSQL-backed Queue/Run/Event execution plane with Scheduler, Worker leases, retries, cancellation, timeout, crash recovery and SSE replay.
- an administrator-facing SkillHub with audited immutable artifacts, workspace grants and direct Rice binding;
- one ordinary-user entry, **与 Rice 工作**, backed by a persistent Codex conversation thread and tenant-scoped tools.

The Worker executes the isolated `allrice.system.echo`, version-pinned
`allrice.skill.run` and Rice `allrice.employee.run` handlers. Chat persists a
pending response, returns the durable Run immediately and restores the final
answer from PostgreSQL.

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

## Quick start for contributors

Requirements:

- Node.js 22+
- pnpm 11+
- Docker Desktop (or Docker Engine with Compose)
- Codex CLI authenticated using `codex login` with a ChatGPT subscription

```bash
git clone https://github.com/semiok/allrice.git
cd allrice
corepack enable
pnpm install
pnpm dev
```

That is the complete default setup. On the first run, `pnpm dev`:

1. loads optional overrides from the root `.env`;
2. starts an isolated PostgreSQL 17 + pgvector container on `127.0.0.1:54329`;
3. applies every migration and verifies migration state, baseline metadata, and pgvector;
4. creates the ignored local storage directory;
5. starts Web and Worker with the same environment.

Run `pnpm doctor` for prerequisite diagnostics. Copy `.env.example` to `.env` only when you need overrides; it is not required for the default path. See the [development guide](docs/development/README.md) for existing-database setup, environment variables, and troubleshooting.

Default endpoints:

| Service          | Endpoint                                 |
| ---------------- | ---------------------------------------- |
| Web              | `http://localhost:3000`                  |
| Web liveness     | `http://localhost:3000/api/health/live`  |
| Web readiness    | `http://localhost:3000/api/health/ready` |
| Worker liveness  | `http://localhost:3101/health/live`      |
| Worker readiness | `http://localhost:3101/health/ready`     |

The readiness endpoints require a working database. The liveness endpoints only prove that the process is running. Stop the development database with `pnpm db:dev:down`; its named volume is retained for the next run.

Open `http://localhost:3000/skillhub` after accepting the first administrator
invitation. Codex credentials remain in the deployment environment; AllRice
stores only secret-free connection health.

Administrators can open `http://localhost:3000/skillhub` to import an approved
Skill, add it to the workspace and configure it for Rice. The internal immutable
configuration history is not exposed to ordinary employees.

## Docker Compose

```bash
cp .env.example .env
docker compose build worker
docker compose run --rm worker codex login --device-auth
docker compose up --build --wait
```

Set a non-default `POSTGRES_PASSWORD` in `.env` before using this path outside a local machine. The proxy listens on `http://localhost:8080`. PostgreSQL and application storage use named volumes. Compose is the V1 deployment shape; Kubernetes and Redis are explicitly out of scope.

Run the isolated Linux/Compose acceptance smoke with:

```bash
pnpm test:compose
```

The smoke uses Compose project `allrice-met39` and host port `18080` by default. It verifies readiness, migrations, pgvector, two-user/two-workspace isolation, the employee Chat/File/Memory loop, restart recovery and delete propagation, then removes test containers and volumes. Override `ALLRICE_COMPOSE_PROJECT`, `ALLRICE_PROXY_PORT`, or set `ALLRICE_KEEP_COMPOSE=1` when debugging.

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

AllRice is licensed under the [Apache License 2.0](LICENSE). Third-party dependencies, Skills, assets and any future extracted files retain their own terms and attribution requirements. See the [license decision](docs/audits/allrice-license-decision.md) and [OpenRice extraction audit](docs/audits/openrice-extraction-audit.md). No OpenRice source has been copied into this baseline.
