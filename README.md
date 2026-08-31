# AllRice

AllRice is a browser-first, self-hosted AI workspace for enterprise employees. It is an independent product and repository: no desktop client, Tauri, Rust, Cargo, DMG, or host-local user skill directories are part of the runtime.

> Current version: **0.1.0 baseline**
>
> Current delivery: **ChatFlow 3.0, platform model governance and the SaaS employee framework**
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
- an empty-by-default, platform-managed DSH-native Skill registry with
  employee-level assembly and immutable per-Run snapshots;
- one ordinary-user entry, **与 Rice 工作**, backed by a persistent DSH conversation session and tenant-scoped tools.
- a platform-managed model pool with per-employee selection and immutable
  Session routing snapshots; the default is **GPT-5.6 Luna · 极高** through
  the DSH `openai-codex` Provider route.
- a role-aware SaaS shell: members, tenant administrators and platform
  administrators use one application but receive different authorized controls.
- `/chatflow` is the only tenant conversation product UI. Employee production
  lives in the platform-only `allrice-dsh.*` Runtime Console; tenant employee
  configuration routes redirect back to ChatFlow. `/workspace` redirects to
  ChatFlow 3.0 and there is no product-level legacy chat fallback.
- platform quotas, durable usage accounting, explicit fallback, Provider
  circuit breakers and audited emergency kill switches.

The Worker executes the isolated `allrice.system.echo` and Rice
`allrice.employee.run` handlers. Skills are version-pinned employee capabilities,
not a second standalone Harness. Chat persists a
pending response, returns the durable Run immediately and restores the final
answer from PostgreSQL.

## Product boundary

| Product  | Audience             | Responsibility                                                                     |
| -------- | -------------------- | ---------------------------------------------------------------------------------- |
| OpenRice | Enterprise managers  | Organization governance, policy, publishing, assignment, audit, operations         |
| AllRice  | Enterprise employees | Personal AI employee, Chat/Session, files, Memory, Skills, task execution, results |

AllRice 0.1 runs independently with its own database and local invitation model. A future OpenRice integration must use versioned APIs, signed tokens, events, or explicit synchronization. The products must not share business tables, ORM models, migration history, or runtime directories.

## Architecture

AllRice uses **ChatFlow Runtime** as its Provider-neutral SaaS conversation
control plane. ChatFlow manages Session, Run, event delivery, context recovery,
authorization and Provider routing while DSH is the single execution Harness.
Codex subscription, MiniMax and later APIs are Provider routes inside DSH, not
peer Harnesses. ChatFlow 3.0 persists a sanitized DSH-native event stream and
projects it in native order without reassembling a second execution UX; see the
[ChatFlow Runtime architecture](docs/architecture/chatflow-runtime.md).
Provider connections and employee model selection are defined in the
[platform model pool architecture](docs/architecture/platform-model-pool.md).

```text
Browser
  -> reverse proxy
  -> web (Next.js UI / API / Auth / SSE)
       -> PostgreSQL + pgvector
       -> mounted object storage
       -> persistent job records
            -> ChatFlow Runtime
                 -> worker (Session / Run / Event / recovery)
                 -> DSH Harness -> Provider Router
                      -> openai-codex / openai-compatible / deepseek-official
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
- a platform administrator who can complete DSH's Codex subscription OAuth

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

Open `http://localhost:3000/chatflow` after accepting the first administrator
invitation. The platform administrator authorizes the Codex subscription from
the model console. DSH stores and refreshes the OAuth grant in its private
credential store; AllRice stores only public flow state, connection health and
opaque deployment references.

Reusable employee capabilities are provided through DSH-native Skills. They
are assembled by the platform administration plane and are not managed through
a tenant-facing capability marketplace.

Run the MET-62 product and runtime gate with `pnpm met62:verify`. Set
`ALLRICE_ACCEPTANCE_BASE_URL=http://localhost:3000` to include deployed HTTP
readiness and new-UI route checks.

## Docker Compose

```bash
cp .env.example .env
docker compose build worker
docker compose up --build --wait
```

After first sign-in, authorize the Codex subscription from the AllRice platform
model console. Do not copy a Codex CLI token into the application container.

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
