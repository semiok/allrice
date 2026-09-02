# AllRice documentation

This directory is the collaboration entry point for AllRice. A feature is not ready to implement until its README identifies authority, tenant boundaries, API/data ownership, security requirements, acceptance criteria, and the responsible Linear issue.

## Status legend

- **Baseline implemented**: executable engineering foundation exists in 0.1.0.
- **Feature implemented**: the user workflow and its tenant/recovery acceptance path exist.
- **Contract pending**: implementation must wait for MET-49.
- **Planned**: scoped in Linear, not yet implemented.
- **Deferred**: intentionally excluded from V1.

## Architecture and development

- [System architecture](architecture/README.md)
- [AllRice ChatFlow Runtime](architecture/chatflow-runtime.md)
- [Platform-managed model pool](architecture/platform-model-pool.md)
- [Platform employee production](architecture/platform-employee-production.md)
- [V1 core contracts](architecture/v1-core-contracts.md)
- [V1 contract test matrix](architecture/v1-contract-test-matrix.md)
- [Development workflow](development/README.md)
- [OpenRice extraction and license audit](audits/openrice-extraction-audit.md)
- [AllRice Apache-2.0 license decision](audits/allrice-license-decision.md)
- [MET-62 production acceptance](operations/met62-production-acceptance.md)
- [Rice conversation harness and Tool Broker](features/agent-conversation/README.md)
- [Cloud WeChat article research](features/wechat-research/README.md)
- [OpenClaw Skill import audit](audits/openclaw-skill-import-audit.md)
- [Phase 0 readiness review](audits/phase0-readiness-review.md)
- [Feature README template](templates/feature-readme-template.md)

## Feature index

| Capability              | Status                          | Linear          | Documentation                                          |
| ----------------------- | ------------------------------- | --------------- | ------------------------------------------------------ |
| Identity and tenancy    | Foundation implemented          | MET-41 / MET-49 | [README](features/identity/README.md)                  |
| Employee workspace      | Rice tenant work surface        | MET-50 / MET-93 | [README](features/employee-workspace/README.md)        |
| Chat and Session        | Feature implemented             | MET-50          | [README](features/chat-session/README.md)              |
| File storage            | Workflow implemented            | MET-42 / MET-50 | [README](features/file-storage/README.md)              |
| Memory                  | Workflow implemented            | MET-42 / MET-50 | [README](features/memory/README.md)                    |
| Worker and Queue        | Feature implemented             | MET-43 / MET-49 | [README](features/worker-queue/README.md)              |
| DSH-native Skills       | Platform registry reset         | MET-92 / MET-93 | [README](architecture/platform-employee-production.md) |
| WeChat article research | Cloud-native Skill implemented  | MET-96          | [README](features/wechat-research/README.md)           |
| Employee production     | Phase A + compiler implemented  | MET-93          | [README](architecture/platform-employee-production.md) |
| OpenRice integration    | Boundary frozen                 | MET-49          | [README](features/openrice-integration/README.md)      |
| OpenRice migration      | Planned                         | MET-46          | [README](features/migration/README.md)                 |
| Operations and recovery | Baseline definitions            | MET-47          | [README](features/operations/README.md)                |
| ChatFlow Runtime        | Single-path 3.0 implemented     | MET-88          | [README](architecture/chatflow-runtime.md)             |
| Platform model pool     | Governed routing implemented    | MET-80–84       | [README](architecture/platform-model-pool.md)          |
| SaaS conversation UI    | Tenant work surface implemented | MET-86 / MET-93 | [README](architecture/chatflow-runtime.md)             |

## Documentation rule

Every PR that changes a feature contract or user-visible behavior must update that feature README in the same PR. A README must never claim a planned capability is already implemented.
