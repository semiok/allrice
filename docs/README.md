# AllRice documentation

This directory is the collaboration entry point for AllRice. A feature is not ready to implement until its README identifies authority, tenant boundaries, API/data ownership, security requirements, acceptance criteria, and the responsible Linear issue.

## Status legend

- **Baseline implemented**: executable engineering foundation exists in 0.1.0.
- **Contract pending**: implementation must wait for MET-49.
- **Planned**: scoped in Linear, not yet implemented.
- **Deferred**: intentionally excluded from V1.

## Architecture and development

- [System architecture](architecture/README.md)
- [Development workflow](development/README.md)
- [Feature README template](templates/feature-readme-template.md)

## Feature index

| Capability              | Status                | Linear          | Documentation                                     |
| ----------------------- | --------------------- | --------------- | ------------------------------------------------- |
| Identity and tenancy    | Contract pending      | MET-41 / MET-49 | [README](features/identity/README.md)             |
| Employee workspace      | Planned               | MET-50          | [README](features/employee-workspace/README.md)   |
| Chat and Session        | Planned               | MET-50          | [README](features/chat-session/README.md)         |
| File storage            | Contract pending      | MET-42 / MET-49 | [README](features/file-storage/README.md)         |
| Memory                  | Planned               | MET-42 / MET-50 | [README](features/memory/README.md)               |
| Worker and Queue        | Baseline process only | MET-43 / MET-49 | [README](features/worker-queue/README.md)         |
| SkillHub                | Contract pending      | MET-44 / MET-49 | [README](features/skillhub/README.md)             |
| EmployeeHub             | Planned, minimal V1   | MET-45          | [README](features/employeehub/README.md)          |
| OpenRice integration    | Contract pending      | MET-49          | [README](features/openrice-integration/README.md) |
| OpenRice migration      | Planned               | MET-46          | [README](features/migration/README.md)            |
| Operations and recovery | Baseline definitions  | MET-47          | [README](features/operations/README.md)           |

## Documentation rule

Every PR that changes a feature contract or user-visible behavior must update that feature README in the same PR. A README must never claim a planned capability is already implemented.
