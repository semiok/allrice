# Development workflow

The supported fresh-clone path is intentionally executable, not a sequence of manual database steps:

```bash
git clone https://github.com/semiok/allrice.git
cd allrice
corepack enable
pnpm install
pnpm dev
```

An `.env` file is optional. The default path provisions a private development database, migrates and verifies it, creates local storage, then starts both application processes.

## Requirements

- Node.js 22+
- pnpm 11+
- Docker Desktop, or Docker Engine with the Compose plugin
- Codex CLI, signed in with the ChatGPT subscription account used for SkillRun

AllRice does not use an OpenAI API key. Before the first local start, run:

```bash
codex login
codex login status
```

This is a one-time deployment authorization step; `pnpm doctor` verifies it.

The repository pins pnpm in `package.json` and the Node major in `.nvmrc`. Run `pnpm doctor` before setup when diagnosing a teammate's machine.

## Default database: Docker Compose

`pnpm dev` uses `compose.dev.yaml` when `DATABASE_URL` is blank. It starts `pgvector/pgvector:pg17` with these development-only defaults:

| Setting       | Default                                      |
| ------------- | -------------------------------------------- |
| Host          | `127.0.0.1`                                  |
| Port          | `54329`                                      |
| Database      | `allrice`                                    |
| User/password | `allrice` / `allrice`                        |
| Compose name  | `allrice-dev`                                |
| Data          | named volume `allrice-dev_postgres-dev-data` |

The port binds only to loopback and is deliberately different from PostgreSQL's standard `5432`, so it does not collide with a typical local installation.

Install Docker Desktop on macOS or Windows, or Docker Engine plus the Compose plugin on Linux. Start Docker once, then run `pnpm dev`; no separate PostgreSQL or pgvector installation is needed.

Use `pnpm db:dev:down` to stop the container. This keeps its database volume. Removing that volume is destructive and is therefore not part of the normal setup command.

## Using an existing PostgreSQL database

The database must be PostgreSQL 17 with the pgvector extension available. Create a database and user, ensure the user owns the database (or can create extensions), then add the connection string to the ignored root `.env`:

```dotenv
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DATABASE
```

Then run:

```bash
pnpm db:setup
pnpm dev
```

With `DATABASE_URL` set, AllRice never starts or stops Docker. `db:setup` applies ordered migrations under a PostgreSQL advisory lock and runs a read-only schema verification. If your managed PostgreSQL provider prevents the application user from creating extensions, ask an administrator to run `CREATE EXTENSION vector;` once.

For a native local installation, install PostgreSQL 17 and the matching pgvector package using your operating system's package manager, start PostgreSQL, create the user/database, and use the same `DATABASE_URL` flow. Docker remains the reference development path because it pins both versions and is tested in CI.

## Environment variables

Copy `.env.example` to `.env` only when changing defaults. The bootstrap script loads this root file and passes one consistent environment to migration, Web, and Worker.

| Variable                          | Default             | Purpose                                                         |
| --------------------------------- | ------------------- | --------------------------------------------------------------- |
| `DATABASE_URL`                    | blank               | Existing database override; blank enables the dev container     |
| `ALLRICE_DEV_DB_PORT`             | `54329`             | Loopback host port for the development database                 |
| `POSTGRES_DB`                     | `allrice`           | Database created by Compose                                     |
| `POSTGRES_USER`                   | `allrice`           | Database user created by Compose                                |
| `POSTGRES_PASSWORD`               | `allrice`           | Local default; must be changed for shared/production deployment |
| `ALLRICE_WEB_PORT`                | `3000`              | Native Web development port                                     |
| `ALLRICE_WORKER_PORT`             | `3101`              | Native Worker health port                                       |
| `ALLRICE_WORKER_POLL_INTERVAL_MS` | `1000`              | Persistent Queue maintenance and claim cadence                  |
| `ALLRICE_WORKER_LEASE_MS`         | `30000`             | Worker claim lease duration                                     |
| `ALLRICE_WORKER_HEARTBEAT_MS`     | `10000`             | Active execution heartbeat cadence                              |
| `ALLRICE_WORKER_CONCURRENCY`      | `1`                 | Maximum executions per Worker process                           |
| `ALLRICE_EXECUTION_ROOT`          | `.local/executions` | Ignored tenant/run/attempt scratch root                         |
| `ALLRICE_STORAGE_ROOT`            | `.local/storage`    | Ignored native-development storage directory                    |
| `ALLRICE_CODEX_COMMAND`           | `codex`             | Codex CLI executable                                            |
| `ALLRICE_CODEX_AUTH_HOME`         | current `~/.codex`  | Deployment-owned subscription credential directory              |
| `ALLRICE_CODEX_MODEL`             | `gpt-5.6-luna`      | Model pinned into new Skill and Employee versions/runs          |
| `ALLRICE_CODEX_REASONING_EFFORT`  | `high`              | Reasoning pinned into new Skill and Employee versions/runs      |
| `ALLRICE_STORAGE_SIGNING_SECRET`  | dev-only fallback   | HMAC secret; required in production, minimum 32 bytes           |
| `ALLRICE_PROXY_PORT`              | `8080`              | Host port for the full Compose deployment                       |

Do not commit `.env`; it is ignored because it may contain credentials.

## Bootstrap the first administrator

AllRice has no production Auto Guest or default password. After `pnpm db:setup`, set the five `ALLRICE_BOOTSTRAP_*` values shown in `.env.example`, then run:

```bash
pnpm identity:bootstrap
```

The command creates or reuses the Organization and default Workspace, then prints a one-time administrator invitation token. Open `/accept-invitation?token=...` and activate the account within 24 hours. Only the token hash is stored. Subsequent invitations are created through `POST /api/v1/admin/invitations` by an authenticated administrator.

Never put the printed token in source control, issue comments or logs retained by shared CI.

## What startup verifies

Before Web or Worker starts, the bootstrap checks database connectivity, applies all SQL files in order, and confirms:

- every repository migration is recorded, with no missing or unexpected entries;
- the pgvector extension is installed;
- baseline runtime metadata is readable and has the expected version.

This prevents the misleading state where liveness passes but a teammate is developing against an empty or stale database.

## Commands

| Command                   | Purpose                                             |
| ------------------------- | --------------------------------------------------- |
| `pnpm doctor`             | Check Node, pnpm, Codex login, and database path    |
| `pnpm doctor:ci`          | Check non-secret core bootstrap prerequisites       |
| `pnpm dev`                | Prepare the database, then run Web and Worker       |
| `pnpm db:setup`           | Start/default or use/external DB, migrate, verify   |
| `pnpm db:verify`          | Verify migrations, baseline metadata, and pgvector  |
| `pnpm db:dev:up`          | Start only the isolated development database        |
| `pnpm db:dev:down`        | Stop it while retaining its named data volume       |
| `pnpm db:migrate`         | Apply ordered SQL migrations under an advisory lock |
| `pnpm identity:bootstrap` | Create the first one-time admin invitation          |
| `pnpm format:check`       | Verify formatting                                   |
| `pnpm lint`               | Run static rules                                    |
| `pnpm typecheck`          | Typecheck every workspace package                   |
| `pnpm test`               | Run unit/contract tests                             |
| `pnpm build`              | Build packages and applications                     |

## Troubleshooting

- **`Docker Compose is required`**: install and start Docker Desktop, then confirm `docker compose version` works. Or configure an existing database with `DATABASE_URL`.
- **Port `54329` is already allocated**: set `ALLRICE_DEV_DB_PORT` to another free port in `.env`. The bootstrap constructs the matching connection URL automatically.
- **`permission denied to create extension vector`**: have a PostgreSQL administrator install pgvector and run `CREATE EXTENSION vector;` in the AllRice database.
- **Migration mismatch**: run `pnpm db:setup`. Do not edit migration history or the database migration table by hand.
- **SkillHub provider status says `run_codex_login`**: run `codex login` as the Worker deployment user. For Compose, run `docker compose run --rm worker codex login --device-auth` so the credential is stored in the dedicated named volume.
- **SkillHub provider status says `codex_cli_not_found`**: install the Codex CLI or set `ALLRICE_CODEX_COMMAND` to its absolute executable path.
- **Web/Worker port already used**: override `ALLRICE_WEB_PORT` or `ALLRICE_WORKER_PORT` in `.env`.
- **Liveness is 200 but readiness is 503**: run `pnpm db:verify`; readiness deliberately includes database connectivity.

The full containerized acceptance path is `pnpm test:compose`. It builds
production images, starts a fresh database, verifies repeatable migrations and
pgvector, exercises the employee Workspace with two users and two Workspaces,
then validates durable Run submission, retry, cancellation, timeout, SSE replay
and an ungraceful Worker crash. It finally restarts PostgreSQL and Web and
verifies business data persistence plus delete propagation.

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
