# EmployeeHub

> Status: **Minimal Codex-backed V1 implemented**
>
> Linear: **MET-45**

## User outcome

An employee receives a default AI employee and can run it with a stable, auditable definition. Enterprise managers can later publish and assign richer employees through OpenRice integration.

## V1 scope

- one predefined Employee named **Rice**, shown first and selected by an explicit default Assignment;
- immutable EmployeeVersion;
- one EmployeeAssignment per human employee;
- `gpt-5.6-luna` / `high` defaults with deployment overrides frozen into each published manifest;
- exact SkillVersion bindings inherited from installed, enabled SkillHub versions;
- Run linkage to EmployeeVersion, SkillVersion and PolicySnapshot;
- result and audit visibility in the employee workspace.

## Deferred

- visual employee editor;
- public/internal marketplace;
- complex multi-step manifest builder;
- broad Connector and Loop orchestration;
- cross-enterprise publishing.

## Core relationship

```text
Employee
  -> EmployeeVersion
       -> EmployeeAssignment
            -> EmployeeRun
                 -> RunStep / SkillRun / Approval / Artifact / AuditEvent
```

Published versions are immutable. Assignment grants access but does not copy private Session/Memory between human employees.

Migration `0007_employeehub_rice.sql` makes the published manifest, provider snapshot and SkillVersion IDs immutable. `allrice_employee_runs` freezes the Assignment, EmployeeVersion, provider, skill grants and prompt context for each durable Run; `allrice_employee_run_steps` mirrors its ordered RunEvent evidence. Rollback changes an Assignment to an older executable version and never rewrites history.

## Product surface and API

- `/employees` is the EmployeeHub menu. V1 shows Rice, the explicit default badge, current model/reasoning, enabled SkillHub choices and immutable version history.
- `GET|POST /api/v1/employees` lists assignments or publishes a new Rice version.
- `PATCH /api/v1/employees/:assignmentId/version` switches the exact assigned version.
- `PATCH /api/v1/employees/:assignmentId/default` explicitly changes the default without relying on list order.
- creating a Session may name an `employeeAssignmentId`; sending a Message returns `202` with its durable Run and a pending assistant Message.

The browser polls the normal Run endpoint and reloads server-authoritative Message state. Success, failure and cancellation are written back transactionally by the Queue finalizer.

## Security

The effective execution permission is the intersection of human Membership, EmployeeAssignment, immutable EmployeeVersion capability, enabled version-pinned SkillInstallation and the frozen PolicySnapshot. The Worker receives no database URL or arbitrary deployment credentials, and the Codex harness keeps shell, unified exec, full browser/CDP, multi-agent and credential elicitation disabled.

## Acceptance

TNlabs assigns the same default EmployeeVersion to User A and User B as separate assignments. Both can run it, but their Chat, Memory, files, credentials, Skill favorites and Run context remain isolated.
