# EmployeeHub

> Status: **Planned; minimal V1 only**
>
> Linear: **MET-45**

## User outcome

An employee receives a default AI employee and can run it with a stable, auditable definition. Enterprise managers can later publish and assign richer employees through OpenRice integration.

## V1 scope

- one predefined Employee;
- immutable EmployeeVersion;
- one EmployeeAssignment per human employee;
- fixed model/system instructions/capabilities;
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

## Security

The effective execution permission is the intersection of human Membership, EmployeeAssignment, EmployeeVersion capability, SkillInstallation, Connector grant, Credential scope and current PolicySnapshot.

## Acceptance

TNlabs assigns the same default EmployeeVersion to User A and User B as separate assignments. Both can run it, but their Chat, Memory, files, credentials, Skill favorites and Run context remain isolated.
