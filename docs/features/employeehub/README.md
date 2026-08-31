# EmployeeHub

> Status: **Rice-only baseline; platform employee administration planned in MET-93**
>
> Linear: **MET-45, MET-60, MET-61, MET-63, MET-68**

## Product model

Rice is currently the only employee. Specialized employees will be created,
assembled and published from the platform administration plane in MET-93;
ordinary tenants only use employees assigned to them. Employees have no
user-facing version concept. AllRice keeps immutable internal revisions solely
for reproducible execution and audit.

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
- exact DSH-native Skill snapshots and Tool / Knowledge / Workflow bindings;
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
                      -> RunStep / native DSH event / Approval / AuditEvent
```

Assignment grants use of the employee but never copies private Session, Memory,
files or credentials between users.

## API

- `GET /api/v1/employees` returns the caller's assignments. Administrators also
  receive the current Rice assignment.
- `PUT /api/v1/employees/:employeeId/assignments` replaces the employee's
  member assignments and requires an administrator.
- `PATCH /api/v1/employees/:employeeId/status` enables or disables a specialized
  employee and requires an administrator.
- `PATCH /api/v1/employees/:assignmentId/default` lets a user choose among the
  employees already assigned to them.
- `GET|PUT /api/v1/employees/:employeeId/capabilities` reads or atomically
  replaces exact Agent Skill, Workflow and Knowledge revision bindings for an
  administrator.
- MET-93 provides the platform-only employee definition, DSH assembly, debug,
  publication and tenant-assignment APIs.

The capability lifecycle, Knowledge ACL and execution-freezing rules are in
[Agent capability foundation](../../architecture/agent-capability-foundation.md).

## Security invariant

Effective execution permission is the intersection of human Membership,
EmployeeAssignment, Employee Definition capabilities, enabled DSH-native Skill
bindings, tenant policy and the frozen PolicySnapshot. The
worker receives no database URL, host shell or arbitrary deployment credentials.

## Acceptance

An administrator can configure a specialized employee and assign it to User A
without exposing it to User B. Rice remains available to both users. A run
started by User A can later be reproduced from its snapshot even if the
administrator changes the employee, Skill grants or assignments.
