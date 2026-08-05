# SkillHub

MET-44 implements the first production-shaped SkillHub slice. It deliberately
supports one execution provider only: the Codex CLI authenticated with a
ChatGPT/Codex subscription.

## Authority and immutability

- PostgreSQL owns catalog metadata, version state, installations, capability
  grants, provider health, and the Run-to-SkillVersion binding.
- Storage owns the immutable `application/vnd.allrice.skill+json;v=1`
  artifact. Every execution rechecks its size and SHA-256 checksum before
  materializing it.
- A published SkillVersion cannot change its artifact, source, capabilities,
  compatibility, version number, or publication timestamp. An update creates a
  new version.
- An installation is user/workspace scoped and pins one exact SkillVersion.
  Future AI employees should compose these pinned IDs; they must not inherit a
  mutable directory.

## Codex subscription authorization

AllRice does not accept, proxy, or store OpenAI API keys. Authenticate the
deployment's Worker directly:

```bash
codex login
codex login status
```

For a Compose deployment, the dedicated `codex-data` volume is the credential
boundary:

```bash
docker compose run --rm worker codex login --device-auth
docker compose up -d
```

Set `ALLRICE_CODEX_AUTH_HOME` when running without Compose. It must point to a
deployment-owned credential directory. The browser and database see only the
Worker's normalized status (`connected`, `disconnected`, `error`, `unknown`),
CLI version, detail code, and check time.

Each SkillRun invokes:

```text
codex exec --json --ephemeral --ignore-user-config --ignore-rules \
  --sandbox workspace-write --cd <isolated-attempt> --model <configured> ...
```

User plugins, config, project rules, and persisted Codex sessions are disabled.
The bypass-sandbox flag is never allowed. The credential directory is supplied
to the Codex process for authentication but is not copied into the run working
directory or model prompt.

The V1 Weather slice also disables Codex shell/unified-exec tools. This prevents
model-generated commands from reading the deployment credential directory;
`network:outbound` enables only the Codex browser tool. Adding filesystem or
command-capable Skills requires a separately isolated credential broker/runtime
and is intentionally deferred rather than weakening this boundary.

## OpenRice import policy

The first candidate is a modified Weather instruction derived from
`semiok/openrice` commit
`6149e0160893b033b4fd2d32b932b23735720949`, under Apache-2.0. Its artifact
contains an explicit NOTICE and declares `model:invoke` and
`network:outbound`.

Imports are per-skill. AllRice does not copy OpenRice's Tauri/home-directory
loader, symlinks, user config, OpenLoomi local-token skills, the macOS CUA
driver, or the Office skill originals with restrictive Anthropic license files.

The v1 artifact format accepts at most 64 regular UTF-8 files and 2 MB at
runtime. Paths must be relative, cannot contain backslashes or `..`, and must
contain exactly one `SKILL.md` entrypoint. Symlinks and executable entries do
not exist in the format.

## HTTP flow

- `GET/POST /api/v1/skills` lists and imports catalog versions (publish requires
  an organization/workspace admin).
- `POST /api/v1/skills/installations` pins a version and grants only capabilities
  declared by that version.
- `POST /api/v1/skills/runs` freezes the provider and SkillVersion snapshot into
  a MET-43 durable Run.
- `GET /api/v1/admin/providers/codex` exposes secret-free Worker health to
  administrators.

Use `/skillhub` for the acceptance flow: import the approved candidate, install
it, then execute a prompt and observe the durable Run result.

> Status: **MET-44 Codex-only implementation in progress**
>
> Linear: **MET-44, MET-49**

## User outcome

Employees browse authorized Skills, install or receive them, mark personal favorites and execute an immutable reviewed version through the Worker.

## Authority model

```text
CatalogSkill
  -> SkillVersion (immutable)
       -> SkillArtifact (immutable bytes + checksum)
            -> SkillInstallation
```

Favorite, enabled and pinned version belong to SkillInstallation. They never mutate shared `SKILL.md` or Artifact content. Worker-local directories are disposable materialized cache.

## V1 scope

- authorized Skill list and detail;
- installation to personal or Workspace target;
- enable/disable, favorite and pinned version;
- reviewed platform-provided Skills;
- execution evidence in SkillRun/RunEvent/Artifact/Audit;
- one real acceptance Skill, initially the audited OpenRice Weather adaptation.

## Deferred

- public marketplace;
- unreviewed arbitrary Git/ZIP execution;
- automatic dependency installation without policy;
- treating one acceptance Skill as evidence that all Skills are safe.

## Capability security

Each version declares an allowlist for network, filesystem, command/runtime, Secret scope, timeout and resource budget. Imports must defend against traversal, symlinks, archive bombs, SSRF, malicious scripts, dependency attacks and checksum replacement.

## Acceptance

User A's favorite does not affect User B. Disabled/uninstalled Skills disappear from selection/routing. Worker verifies Artifact checksum and frozen version. Cache deletion is recoverable. Unauthorized discovery and execution are denied and audited.
