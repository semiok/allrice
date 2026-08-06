# OpenClaw Skill import audit

## Frozen source

- repository: `https://github.com/openclaw/openclaw`
- commit: `e4968af845ec0a6041c98925c6a142dcf4b01ad1`
- license: MIT, retained in every imported Skill bundle
- AllRice issues: MET-53, MET-54, MET-55

## Decisions

| Source                                                        | Decision                     | Reason and adaptation                                                                                                            |
| ------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `docs/tools/web.md`                                           | instruction-level adaptation | Preserve research/citation behavior; use Codex Hosted Search, not OpenClaw provider configuration                                |
| `docs/tools/web-fetch.md`                                     | behavior reference only      | Reimplemented behind the AllRice Tool Broker with DNS pinning, SSRF blocks, redirect revalidation and untrusted-content wrapping |
| `skills/weather/SKILL.md`                                     | modified instruction import  | Remove host commands and fallbacks; use only policy-provided search/page tools                                                   |
| `skills/summarize/SKILL.md`                                   | rewritten instruction import | Remove external CLI and credential dependencies; use Rice model and authorized reads                                             |
| provider extensions and credential setup                      | excluded                     | Not required for the subscription-backed V1 path                                                                                 |
| shell, browser automation, local config and host skill loader | prohibited                   | Violates tenant isolation and deployment credential boundaries                                                                   |

The import is not a copy of the OpenClaw runtime. AllRice carries three small,
modified instruction artifacts plus their notices and license. No source
package, dependency graph, command runner, configuration directory or provider
credential is imported.
