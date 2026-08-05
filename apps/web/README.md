# Web application

The Web application is the employee-facing AllRice process. Version 0.1.0 provides the application shell and health endpoints only.

## Responsibilities

- browser UI and HTTP APIs;
- authentication/session host after MET-41;
- employee workspace after MET-50;
- RunEvent SSE endpoint after MET-43;
- authorization before every resource query;
- no direct execution of long-running AI or Skill work.

## Health endpoints

- `GET /api/health/live`: process liveness; does not contact dependencies.
- `GET /api/health/ready`: database readiness; returns 503 when PostgreSQL is unavailable.

## Boundary

The Web process may create persistent jobs, but the Worker claims and executes them. Browser-supplied role, owner, organization, workspace, EmployeeVersion, SkillVersion, or Policy data is never trusted without server authorization.

See [Employee workspace](../../docs/features/employee-workspace/README.md) and [Worker queue](../../docs/features/worker-queue/README.md).
