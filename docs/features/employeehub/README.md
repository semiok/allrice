# EmployeeHub

> Status: **Employee Definition V2 / Phase 1.1 implemented**
>
> Linear: **MET-45, MET-60, MET-63**

## Product model

Rice is the default general-purpose employee. Administrators define and assign
specialized employees; ordinary members use only the employees assigned to
them. Employees have no user-facing version concept. AllRice keeps immutable
internal revisions solely for reproducible execution, rollback and audit.

An Employee Definition contains:

- name, description, appearance and applicable scenarios;
- identity, mission, work style, behavior rules and safety boundaries;
- runtime policy (harness, provider, model, reasoning and timeout);
- Skill, Tool, Knowledge and Workflow bindings;
- data scopes, connector identity modes and approval policy.

## Administration boundary

- Active workspace or organization administrators may create, configure,
  enable, disable and assign specialized employees.
- Ordinary members and viewers cannot mutate Employee Definitions or
  assignments.
- Rice cannot be disabled or removed through the assignment API.
- Specialized built-in templates are available in the administrator directory
  but are not automatically granted to every user.
- A member sees a specialized employee in the workspace only after an explicit
  administrator assignment.

## Immutable execution snapshot

Every accepted EmployeeRun freezes an `EmployeeExecutionSnapshot` before it is
queued. The snapshot includes:

- exact Employee Definition revision and checksum;
- exact assignment, assignee, assigning administrator and assignment time;
- runtime and capability policy;
- exact SkillVersion grants and Tool / Knowledge / Workflow bindings;
- organization, workspace, actor and PolicySnapshot identifiers;
- the employee-scoped user profile used for that run.

The database rejects later mutation of the snapshot. A later configuration or
assignment change affects only new work and cannot rewrite historical runs.
During rolling deployment, an older Web/Worker process receives a frozen legacy
snapshot automatically instead of failing a message; the new runtime always
writes the complete V2-derived snapshot explicitly.

## Core relationship

```text
Employee Definition
  -> immutable internal revision
       -> administrator Assignment
            -> Session
                 -> EmployeeRun + immutable ExecutionSnapshot
                      -> RunStep / SkillRun / Approval / Artifact / AuditEvent
```

Assignment grants use of the employee but never copies private Session, Memory,
files or credentials between users.

## API

- `GET /api/v1/employees` returns the caller's assignments. Administrators also
  receive the employee directory, member directory and configurable Skills.
- `POST /api/v1/employees` creates a specialized employee or publishes an
  immutable internal revision; both operations require an administrator.
- `PUT /api/v1/employees/:employeeId/assignments` replaces the employee's
  member assignments and requires an administrator.
- `PATCH /api/v1/employees/:employeeId/status` enables or disables a specialized
  employee and requires an administrator.
- `PATCH /api/v1/employees/:assignmentId/default` lets a user choose among the
  employees already assigned to them.

## Security invariant

Effective execution permission is the intersection of human Membership,
EmployeeAssignment, Employee Definition capabilities, enabled and pinned
SkillInstallation grants, tenant policy and the frozen PolicySnapshot. The
worker receives no database URL, host shell or arbitrary deployment credentials.

## Acceptance

An administrator can configure a specialized employee and assign it to User A
without exposing it to User B. Rice remains available to both users. A run
started by User A can later be reproduced from its snapshot even if the
administrator changes the employee, Skill grants or assignments.
