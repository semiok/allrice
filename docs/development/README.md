# Development workflow

The fresh-clone path prepares the native Worker before database setup:

```bash
git clone https://github.com/semiok/allrice.git
cd allrice
corepack enable
pnpm install
pnpm --filter @allrice/worker... build
node apps/worker/scripts/prepare-native-artifact.mjs --root="$PWD"
# Review the measured ID; put this line with its actual digest in .env:
# ALLRICE_DSH_NATIVE_ARTIFACT_ID=sha256:<reviewed 64-character digest>
pnpm dev
```

The ID must be explicitly supplied in `.env` or the environment; new births
record it. Missing preparation is rejected before database setup. The default path then provisions a
private development database, migrates and verifies it, creates local storage
and starts the isolated Office renderer and both application processes.

Worker development uses `node --watch dist/index.js`, the same compiled entry as
normal startup, without a TypeScript loader exemption. While editing Worker
TypeScript, run `pnpm --filter @allrice/worker exec tsc -p tsconfig.build.json --watch`
in a second terminal. Node restarts when compiled files change. Changes to native
modules, profiles, imported contracts JavaScript or resolved dependencies require
repeating preparation, reviewing the ID, and restarting with that ID. Preparation
uses the versioned execution boundary described in
[native artifact retention](../architecture/dsh-native-retention.md#schema-v2-execution-content):
unrelated settings, business data, declarations/maps and unused lock metadata do
not create a different native ID. The preparation command never
automatically approves shared Dev or Prod, and neither development nor production
startup bypasses native content verification.

## Requirements

- Node.js 22+
- pnpm matching the repository's `packageManager` pin (currently 10.33.3)
- Docker Desktop, or Docker Engine with the Compose plugin
- a platform administrator who can complete DSH's Codex subscription OAuth

AllRice does not require an OpenAI API key or Codex CLI for employee model
execution. After the first local start, sign in as a platform administrator and
authorize the Codex subscription in the model console. The browser sees only a
public device-code challenge; DSH stores and refreshes the OAuth grant in its
private credential store.

The repository pins pnpm in `package.json` and the Node major in `.nvmrc`. Run `pnpm doctor` before setup when diagnosing a teammate's machine.

### Repository source receipt before pushing

After committing a clean candidate, run the same immutable source capture used
at the beginning of every CI job:

```bash
node scripts/acceptance/platform/repository-ci.mjs capture --output=.local/repository-ci/prepush.json
```

The complete tracked tree is retained. The private repository source profile
allows at most 4,096 files, 2,000,000 bytes per file and 40,000,000 total source
bytes; expanded JSON is bounded at 60,000,000 bytes and gzip archives remain
bounded at 12,000,000 bytes. CI and product limits have a shared regression
check. These limits do not change ordinary project, Bridge or cloud wire limits.

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

With `DATABASE_URL` set, database setup never starts or stops Docker. `pnpm dev` still starts the Office renderer unless `ALLRICE_OFFICE_RENDERER_URL` points to an existing private service. `db:setup` applies ordered migrations under a PostgreSQL advisory lock and runs a read-only schema verification. If your managed PostgreSQL provider prevents the application user from creating extensions, ask an administrator to run `CREATE EXTENSION vector;` once.

For a native local installation, install PostgreSQL 17 and the matching pgvector package using your operating system's package manager, start PostgreSQL, create the user/database, and use the same `DATABASE_URL` flow. Docker remains the reference development path because it pins both versions and is tested in CI.

## Environment variables

Native contexts bind to the DSH generation and the journal contract, not to an
artifact ID (MET-221). `ALLRICE_DSH_NATIVE_ARTIFACT_ID` is the reviewed seal of a
release: Web records it on new births and the Worker remeasures it at startup.
Every same-generation context runs on that primary; the artifact IDs recorded on
origins, pins, Runs and control references are provenance only. Checked final
delivery applies to every eligible Run. `ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID` and
`ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS` are retired and ignored; non-empty
`ALLRICE_DSH_RETAINED_*` or `ALLRICE_DSH_ORIGIN_READER_*` settings refuse the
Worker start. See [DSH reuse decisions](../architecture/dsh-reuse-and-replacement.md).

Worker startup emits bounded `[MET-195] worker startup` JSON records with the
same service boot ID, PID, ordered stages, elapsed/CPU time and instrumented read
counters. Missing counters remain null. They do not include paths, file content,
credentials or raw errors, and do not skip validation or change readiness.

Worker emits one bounded `[AllRice:run-timing]` record for each DSH Harness
execution, including failures and parked user questions. The scope is
`harness-execute`, starting at the adapter rather than queue admission. It
records preparation, native IPC chunk arrival, first visible text, the final
native turn ending and reply publication. Content-check durations are grouped
by phase; `sumMs` includes overlapping calls, while `unionMs` counts their
overlap once. Model-chain durations bracket Worker progress receipts and can
include native middleware, authorization and IPC. They are not Provider
inference or network-only timings. Unsupported socket/send/first-Provider-event
fields remain `null`; existing native model-timing records remain separate.
These observations add no database events, do not include message contents or
credentials, and never change retries, authorization or execution outcomes.

MET-157 Office content is synchronized by the normal `db:setup` / `content:sync`
workflow. Deploy its application changes and catalog together: the catalog
records replacements for the two legacy document Skills, and the employee
editor/compiler resolves them for new drafts. Existing published packages stay
frozen. Office adds no SQL migration. PR3 uses an isolated LibreOffice/UNO/Poppler service,
started by default in Compose and `pnpm dev`, on loopback port 3112.
`ALLRICE_OFFICE_RENDERER_URL` selects an existing private renderer when needed;
it is not an enable switch. Host Python/LibreOffice installation is unnecessary;
see [Office setup and rollback](../features/office/README.md).

Copy `.env.example` to `.env` only when changing defaults. The bootstrap script loads this root file and passes one consistent environment to migration, Web, and Worker.

| Variable                             | Default               | Purpose                                                         |
| ------------------------------------ | --------------------- | --------------------------------------------------------------- |
| `DATABASE_URL`                       | blank                 | Existing database override; blank enables the dev container     |
| `ALLRICE_DEV_DB_PORT`                | `54329`               | Loopback host port for the development database                 |
| `POSTGRES_DB`                        | `allrice`             | Database created by Compose                                     |
| `POSTGRES_USER`                      | `allrice`             | Database user created by Compose                                |
| `POSTGRES_PASSWORD`                  | `allrice`             | Local default; must be changed for shared/production deployment |
| `ALLRICE_WEB_PORT`                   | `3000`                | Native Web development port                                     |
| `ALLRICE_WORKER_PORT`                | `3101`                | Native Worker health port                                       |
| `ALLRICE_WORKER_POLL_INTERVAL_MS`    | `1000`                | Persistent Queue maintenance and claim cadence                  |
| `ALLRICE_WORKER_LEASE_MS`            | `30000`               | Worker claim lease duration                                     |
| `ALLRICE_WORKER_HEARTBEAT_MS`        | `10000`               | Active execution heartbeat cadence                              |
| `ALLRICE_WORKER_CONCURRENCY`         | `1`                   | Maximum executions per Worker process                           |
| `ALLRICE_EXECUTION_ROOT`             | `.local/executions`   | Ignored tenant/run/attempt scratch root                         |
| `ALLRICE_STORAGE_ROOT`               | `.local/storage`      | Ignored native-development storage directory                    |
| `ALLRICE_DSH_CODEX_MODEL`            | `gpt-5.6-luna`        | DSH Codex Provider model pinned into new employee runs          |
| `ALLRICE_DSH_CODEX_REASONING_EFFORT` | `xhigh`               | DSH Codex Provider reasoning effort                             |
| `ALLRICE_DSH_PLATFORM_HOME`          | `.local/dsh-platform` | Private DSH Provider credential/configuration directory         |
| `ALLRICE_DSH_HTTP_PROXY`             | unset                 | Explicit HTTP egress proxy for DSH child processes              |
| `ALLRICE_DSH_HTTPS_PROXY`            | unset                 | Explicit HTTPS egress proxy for DSH child processes             |
| `ALLRICE_DSH_NO_PROXY`               | unset                 | Optional proxy bypass list for DSH child processes              |
| `ALLRICE_DSH_IDLE_CLOSE_MINUTES`     | `30`                  | Close a conversation's idle DSH process; `0` disables           |
| `ALLRICE_STORAGE_SIGNING_SECRET`     | dev-only fallback     | HMAC secret; required in production, minimum 32 bytes           |
| `ALLRICE_PROXY_PORT`                 | `8080`                | Host port for the full Compose deployment                       |

Do not commit `.env`; it is ignored because it may contain credentials.

## Bootstrap the first administrator

AllRice has no production Auto Guest, default password or invitation links. After `pnpm db:setup`, set the non-secret `ALLRICE_BOOTSTRAP_*` values shown in `.env.example` in your local `.env` (the command reads it, like `pnpm dev`; variables already set in the shell win) and add the same email to `ALLRICE_PLATFORM_ADMIN_EMAILS`. Keep the password out of `.env`: write it to a file only you can read and pass its path, then run:

```bash
ALLRICE_BOOTSTRAP_ADMIN_PASSWORD_FILE=~/.allrice-first-password pnpm identity:bootstrap
```

The command checks every value first, then in one transaction creates or reuses the Organization and default Workspace and creates the account with that username and password (at least 8 characters; the platform administrator's portal username is reserved). If an account with that email already exists, it is left unchanged. The output has only IDs, `accountCreated` and `platformAdmin`. Sign in with the username or email; further accounts are added by the platform administrator under the company's people in the admin console (`POST /api/v1/admin/organizations/{id}/people`).

Deployments with the portal login enabled (`ALLRICE_PORTAL_AUTH_ENABLED=1`) do not need this command: the platform administrator signs in on the admin entry (`allrice-admin.bplabs.xyz`, a host in `ALLRICE_ADMIN_PORTAL_HOSTS`, or locally with `ALLRICE_LOCAL_PORTAL=runtime-console`) with `ALLRICE_PLATFORM_ADMIN_USER` / `ALLRICE_PLATFORM_ADMIN_PASSWORD`, and `ALLRICE_PLATFORM_BOOTSTRAP_EMAIL` must be listed in `ALLRICE_PLATFORM_ADMIN_EMAILS`.

## What startup verifies

Before Web or Worker starts, the bootstrap checks database connectivity, applies all SQL files in order, and confirms:

- every repository migration is recorded, with no missing or unexpected entries;
- the pgvector extension is installed;
- baseline runtime metadata is readable and has the expected version.

This prevents the misleading state where liveness passes but a teammate is developing against an empty or stale database.

## Commands

| Command                   | Purpose                                               |
| ------------------------- | ----------------------------------------------------- |
| `pnpm doctor`             | Check Node, pnpm, Codex login, and database path      |
| `pnpm doctor:ci`          | Check non-secret core bootstrap prerequisites         |
| `pnpm dev`                | Prepare the database, then run Web and Worker         |
| `pnpm db:setup`           | Start/default or use/external DB, migrate, verify     |
| `pnpm db:verify`          | Verify migrations, baseline metadata, and pgvector    |
| `pnpm db:dev:up`          | Start only the isolated development database          |
| `pnpm db:dev:down`        | Stop it while retaining its named data volume         |
| `pnpm db:migrate`         | Apply ordered SQL migrations under an advisory lock   |
| `pnpm content:sync`       | Idempotently sync reviewed platform Skill content     |
| `pnpm db:prepare`         | Migrate, sync platform content, then verify           |
| `pnpm identity:bootstrap` | Create the first account with a username and password |
| `pnpm format:check`       | Verify formatting                                     |
| `pnpm lint`               | Run static rules                                      |
| `pnpm typecheck`          | Typecheck every workspace package                     |
| `pnpm test`               | Run unit/contract tests                               |
| `pnpm build`              | Build packages and applications                       |

## Unified desktop workbench schema (MET198)

现有 `ALLRICE_WORKBENCH_ENABLED` 工作台使用
`0201_workbench_file_policies.sql` 管理显式文件共享、参考来源绑定及幂等回执。
切换匹配 Web 版本前仍按正常 `pnpm db:migrate` / `pnpm db:setup` 流程处理，
不回填或推测修改旧文件/聊天权限。本次紧凑列表、14px 桌面对话、统一图标、
会话条件时钟及真实人类终端扩展不新增 SQL migration，也不重做手机导航。

终端目标客户端为 `0.6.0-dev.58`，网页只采用在线且声明
`humanTerminalVersion: 1` 的设备，旧包或离线时引导现有电脑设置。
Web cookie/Origin、真实登录、会话和目录授权先由服务端核实，再经既有 Bridge WSS
连接固定 DSH `0.2.1-rc.2` 人类终端；授权目录仅选择初始 cwd，不构成 OS 沙箱。
该路径不创建 Agent Run、不调用模型、不自动重放输入；临时失联保留 PTY，
关闭标签、确定撤权或 Bridge 退出进入相应清理，unknown 不当作撤权或已停止。

Web 的原生终端资产须通过 `pnpm dsh-ui:verify`；macOS x64/arm64 SEA/App 必须连同
对应 `.terminal-runtime` 固定 manifest 副资源一起打包、校验和验收。
终端浏览器、Web/Bridge 传输及数据库权限回归已接入相应测试入口，
仍需对最终候选逐架构验证真实 PTY，并在 Dev 用普通隔离账号检查实际页面与授权。
本地回归不代表 Dev 或双架构发布验收已完成，原生执行身份也不能借 UI 验收绕过既有测量流程。
行为、复用来源和退出/恢复边界见
[原生工作台说明](../features/native-workbench/README.md#met-198桌面统一工作台)。

## Persistent native context and Run diagnostics (MET200)

DSH bootstrap 去重只依据已采纳的公开 `user/message` 来源摘要回执，按 SQL
会话、原生代际、消息 ID 和内容摘要匹配。压缩或进程重启后从原始 journal
恢复这些覆盖事实；无覆盖证据的历史和变更后的 checkpoint 仍保守导入。
本轮请求、当前记忆和授权规则照常生效，不用本地进程是否 fresh 代替恢复事实。

云 MCP 的连接、工具全名、描述及风险仍保留在目录中；支持的原生 carrier
通过 `cloud.mcp.call` 的 `action: "describe"` 按需取得精确 `inputSchema`。
元数据选择复用执行路径的 frozen/current 工具与权限校验，不创建远端 operation。
目录和查询结果都携带 `schemaDigest`；schema 变化会改变运行配置指纹并要求重新查询。
schema 查询由主员工执行；委派 MCP 读取时一并提供精确 schema，子助手仍仅能执行
本轮已冻结的只读工具，不能自行 describe、管理连接或写入。
必须同时确认批准 artifact 的验证器和工具声明支持该 action；旧 carrier
或能力未知时保留完整 schema。真实 token 与延迟改善须以 Dev 实测为准。

后台只读接口 `GET /api/v1/runs/{id}/diagnostics?workspaceId={workspaceId}`
复用普通 Run 登录与读取权限，并仅允许 Run 本人读取原生诊断，同公司其他成员
不能读取。Web 将真实会话令牌转发至部署配置 `ALLRICE_WORKER_INTERNAL_URL`
（未设置时为本机 Worker 端口，Compose 使用 `http://worker:3101`）。Worker
独立认证并在读取后复核登录和 Run 所有权。请求不能指定磁盘路径、reader、
artifact 或原生日志切片，绑定全部由可信数据库确定。

读取采用该 Run 固定、已批准 artifact 的公开 persistence read handle 和
`expandAssistantStream`；不启动 Agent/模型，不迁移 journal，不补造中断结束事件。
只返回精确 Run/attempt/generation/thread/seq 归属的事件元数据、流块类型/索引/
数量/时间及原生用量。已证明独占的 Run turn 可展开对应 step、重试及压缩元数据；
歧义、缺失回执、未批准 reader、需要迁移或大小超限均明确为 partial/unavailable。
不返回 prompt、输出/推理正文、工具参数/结果、凭证或存储路径。原生时间为墙钟
毫秒，`providerWire` 始终未知；原生 `inputTokens`、`cacheReadTokens` 与
`cacheWriteTokens` 为分项事实，不替代产品账本。运行中未持久化部分同样未知。
该接口不新增 SQL migration、生命周期或前端，固定 native artifact 的发布仍走
既有测量与批准流程。

## Troubleshooting

- **`Docker Compose is required`**: install and start Docker Desktop, then confirm `docker compose version` works. Or configure an existing database with `DATABASE_URL`.
- **Port `54329` is already allocated**: set `ALLRICE_DEV_DB_PORT` to another free port in `.env`. The bootstrap constructs the matching connection URL automatically.
- **`permission denied to create extension vector`**: have a PostgreSQL administrator install pgvector and run `CREATE EXTENSION vector;` in the AllRice database.
- **Migration mismatch**: run `pnpm db:setup`. Do not edit migration history or the database migration table by hand.
- **Codex Provider says authorization is required**: sign in as a platform administrator, open the model console and complete the DSH device-code flow. Do not copy a Codex CLI credential file.
- **DSH credential status is disconnected**: verify the Worker can write `ALLRICE_DSH_PLATFORM_HOME`, then restart the authorization flow from the model console.
- **Web/Worker port already used**: override `ALLRICE_WEB_PORT` or `ALLRICE_WORKER_PORT` in `.env`.
- **Liveness is 200 but readiness is 503**: run `pnpm db:verify`; readiness deliberately includes database connectivity.

The full containerized acceptance path is `pnpm test:compose`. It builds
production images, starts a fresh database, verifies repeatable migrations and
pgvector, exercises the employee Workspace with two users and two Workspaces,
then validates durable Run submission, retry, cancellation, timeout, SSE replay
and an ungraceful Worker crash. It finally restarts PostgreSQL and Web and
verifies business data persistence plus delete propagation.

## Managed dependency resolution

Managed public dependency resolution uses the existing
`ALLRICE_SANDBOX_NETWORK_ENABLED` and `ALLRICE_SANDBOX_EXECUTION_V1_ENABLED`
flags, plus the existing scoped cloud execution grant. Sandbox runtime requests
now use automatic backend destination screening; tenants do not enter websites
in settings. Explicit administrator-installed cloud restrictions still apply.
Web/Worker must reach the TLS-verified malware-filtering DoH endpoint
`security.cloudflare-dns.com` at `1.1.1.2:443`; no API key is used. Resolver
outages fail with a distinct check-unavailable result, without an unfiltered
fallback. The existing network flag remains the emergency disable control. See
[automatic sandbox networking](../architecture/met188-bridge-sandbox-control.md).
This change adds no listening port,
credential or migration. Deploy the matching cloud watchdog while the VM is idle;
its attestation must include `projectResolution: 1`. Only the fixed, hash-checked
resolver may use a 256 MiB executable temporary filesystem. Ordinary scripts keep
their existing temporary filesystem restrictions. Missing guard support fails
closed instead of falling back to an unguarded resolver. Keep the prior guard
for rollback and retain accepted Bridge packages: this server slice does not
enable new client network/budget capabilities. See
[managed dependency resolution](../architecture/met189-managed-dependencies.md)
for the admission, installation and diagnostic boundaries.

## Branches and pull requests

- Work from current `main` on a focused issue branch.
- M5 branches use `m5/MET-<id>-<description>`.
- A PR must reference its Linear issue and list validation performed.
- Do not merge your own PR unless explicitly authorized.
- Do not combine unrelated user changes.

## Code extraction

Before extracting third-party code, record the source repository, commit, path,
license, dependencies, coupling classification, compatibility markers and
future maintenance owner. Bulk copying without a file-level provenance and
dependency review is prohibited.

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
