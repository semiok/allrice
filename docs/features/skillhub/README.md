# SkillHub

> Status: **Contract pending**
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
- one real acceptance Skill, initially `tnalpha-content-ops` if approved.

## Deferred

- public marketplace;
- unreviewed arbitrary Git/ZIP execution;
- automatic dependency installation without policy;
- treating one acceptance Skill as evidence that all Skills are safe.

## Capability security

Each version declares an allowlist for network, filesystem, command/runtime, Secret scope, timeout and resource budget. Imports must defend against traversal, symlinks, archive bombs, SSRF, malicious scripts, dependency attacks and checksum replacement.

## Acceptance

User A's favorite does not affect User B. Disabled/uninstalled Skills disappear from selection/routing. Worker verifies Artifact checksum and frozen version. Cache deletion is recoverable. Unauthorized discovery and execution are denied and audited.
