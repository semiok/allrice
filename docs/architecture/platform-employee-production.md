# Platform employee production

> Status: **Phase A and the publish compiler implemented for MET-93**

AllRice treats an AI employee as a platform-managed product definition, not a
tenant-owned chat preference and not a mutable DSH Session preset.

## Authority

The AllRice control plane and PostgreSQL own employee definitions, immutable
revisions, tenant assignments and audit identity. DSH remains the only Harness
and receives a compiled, restricted Runtime Profile. Neither the DSH Lab Home
nor a tenant browser is an employee configuration authority.

```text
AllRice Runtime Console (platform administrator)
  -> Employee Definition draft
  -> validation and restricted DSH Runtime Profile
  -> immutable published revision
  -> tenant Employee/EmployeeVersion runtime copy
  -> new Session freezes that version
  -> DSH executes the frozen profile
```

The management surface is the **AI 员工** module on `allrice-dsh.*`. Tenant
surfaces only list employees assigned to that tenant and can start a Session;
the old `/employees` and `/chatflow/employees` configuration pages redirect to
the conversation surface.

## Initial catalog

The initial platform catalog contains exactly one system employee, **Rice**.
The retired built-in employees, assignments and SkillHub records are deleted.
The DSH-native Skill registry starts empty; a Skill must pass platform review
before it can be assembled into an employee.

## Definition and compilation

An Employee Definition contains presentation, identity, model policy,
Skill/Workflow/Knowledge references, Tool and Connector references, and an
explicit security policy. Compilation rejects unknown Tools, missing or
disabled Skills, missing Skill Tool dependencies, and local Tools when Bridge
access is disabled. Successful compilation always emits `harness: dsh` and a
credential reference rather than secret material.

## Publication boundary

Publication materializes a new immutable tenant EmployeeVersion and updates
the active assignment for new Sessions. Existing Sessions are not rebound when
an administrator publishes a new revision. This makes conversation recovery
and event replay deterministic without exposing a user-facing version picker.

## Remaining MET-93 phases

- execute the compiled profile in an isolated, credential-free test Session;
- add Provider health and DSH Plugin admission checks to the publish gate;
- add disable, assignment withdrawal, rollback and complete administrator
  difference/audit views.
