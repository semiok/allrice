# SkillHub and Rice capability governance

MET-53 through MET-55 turn SkillHub into the administrator-facing capability
source for Rice. Ordinary employees work only in **与 Rice 工作**; administrators
use `/skillhub` to import an audited Skill, add it to the workspace, and bind or
unbind it from Rice.

## Security and authority

- PostgreSQL owns catalog metadata, immutable Skill versions, workspace
  installations, grants, Rice bindings and audit events.
- Storage owns the immutable
  `application/vnd.allrice.skill+json;v=1` bundle and checksum.
- Only candidates compiled into the approved allowlist can be imported. Raw
  Git URLs, ZIPs and request-supplied bundles are rejected.
- Each imported bundle pins repository, 40-character commit, path and license,
  and includes `SKILL.md`, `NOTICE.md` and `LICENSE.txt`.
- The import gate rejects host shell snippets, executable/package-manager
  dependencies, credential variables and upstream runtime requirements.
- Workspace installation requires an administrator. Binding a Skill to Rice
  updates every active Rice assignment in that workspace; new members receive
  the latest administrator configuration.

Rice's effective capabilities use an intersection rule. Core model and
authorized read tools come from the employee policy. Sensitive capabilities
such as outbound network require all of the following:

```text
Rice maximum capability
  ∩ SkillVersion declaration
  ∩ workspace installation grant
  ∩ Skill bound to the current Rice configuration
```

A Skill therefore cannot expand Rice beyond the employee manifest, and an
employee manifest cannot activate network access without a bound reviewed
Skill. The frozen binding and effective capability set are attached to every
EmployeeRun.

## Initial audited Skills

The initial set is adapted from `openclaw/openclaw` commit
`e4968af845ec0a6041c98925c6a142dcf4b01ad1` under MIT:

| Skill    | Upstream reference          | AllRice adaptation                                                       |
| -------- | --------------------------- | ------------------------------------------------------------------------ |
| 联网研究 | `docs/tools/web.md`         | Codex Hosted Search only; source links required                          |
| 天气查询 | `skills/weather/SKILL.md`   | no shell fallback; hosted search and safe page reader only               |
| 内容总结 | `skills/summarize/SKILL.md` | Rice model plus authorized workspace/page reads; no external summary CLI |

No third-party paid search provider, provider-specific API key, external
summarization service or fallback chain is included.

## Network execution

Search uses the deployment's Codex/ChatGPT subscription through Codex Hosted
Search. AllRice does not accept or store an OpenAI API key for this flow.
Browser automation, computer use, shell, unified exec, user MCP servers and
host project rules remain disabled.

`web.fetch` is a host-executed Tool Broker operation. It accepts public
HTTP(S) only, blocks credentials and nonstandard ports, resolves and pins a
public address, rejects private/link-local/metadata/reserved ranges, rechecks
every redirect, caps time and bytes, permits text formats only, strips active
HTML and wraps the result as untrusted external content. Retrieved page text is
data, never executable instructions.

Native search/page events and broker reads are normalized into safe tool
events and audit records. Raw page contents, credentials, commands and local
paths are not persisted as execution evidence.

## HTTP flow

- `GET /api/v1/skills` lists catalog, workspace installations, approved
  candidates and whether the caller can administer them.
- `POST /api/v1/skills` imports one approved candidate; arbitrary bundle input
  is rejected.
- `POST /api/v1/skills/installations` with `scope: "workspace"` installs and
  grants only capabilities declared by the pinned Skill.
- `PATCH /api/v1/skills/installations/:id` lets an administrator enable or
  disable a workspace installation.
- `POST /api/v1/employees` binds the selected installed Skill IDs to Rice. The
  immutable internal snapshot is intentionally hidden from the employee UI.

## Deferred

- public marketplace and unreviewed Git/ZIP imports;
- automatic dependency installation;
- credential-bearing or paid provider integrations;
- arbitrary shell and per-tenant command sandboxes.

Linear: **MET-53, MET-54, MET-55**
