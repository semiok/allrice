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

## Audited Skills

The audited catalog contains the following OpenClaw-adapted baseline skills and
AllRice workplace workflows. All entries are pinned to
`openclaw/openclaw` commit `e4968af845ec0a6041c98925c6a142dcf4b01ad1` under MIT:

| Skill    | Upstream reference          | AllRice adaptation                                                       |
| -------- | --------------------------- | ------------------------------------------------------------------------ |
| 联网研究 | `docs/tools/web.md`         | Codex Hosted Search only; source links required                          |
| 天气查询 | `skills/weather/SKILL.md`   | no shell fallback; hosted search and safe page reader only               |
| 内容总结 | `skills/summarize/SKILL.md` | Rice model plus authorized workspace/page reads; no external summary CLI |

The workplace workflow catalog additionally includes:

- 会议纪要助手、文档写作与润色、翻译与本地化、周报月报生成；
- 任务拆解与项目计划、需求分析与 PRD、PDF 与合同审阅、知识库整理；
- 数据分析与报表解读、表格清洗与标准化、客服工单分类、招聘 JD 与简历初筛；
- 市场与竞品研究、行业情报与政策监测、内容创作助手、风险与合规检查；
- 日程与提醒规划、定期经营简报、文档归档助手、项目进度跟踪；
- 演示文稿生成助手。

这些工作流使用 OpenClaw 的 AgentSkills 格式作为参考，由 AllRice 审核适配，
只通过租户范围内的模型、工作区存储、Hosted Search 和自动化能力运行。
演示文稿技能在渲染器可用时可生成可编辑的 PowerPoint 文件；否则输出完整的
幻灯片结构、页面文案、演讲备注和图表建议，并明确说明未生成二进制文件。

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
