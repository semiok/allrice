# Web application

The Web application is the employee-facing AllRice process. It provides the Rice workspace and durable Run-backed Chat APIs. DSH-native Skills are assembled in the platform administration plane.

## Responsibilities

- browser UI and HTTP APIs;
- authentication/session host from MET-41;
- employee workspace from MET-50 and EmployeeHub from MET-45;
- Run/RunEvent APIs from MET-43;
- authorization before every resource query;
- no direct execution of long-running AI or Skill work.

## Health endpoints

- `GET /api/health/live`: process liveness; does not contact dependencies.
- `GET /api/health/ready`: database readiness; returns 503 when PostgreSQL is unavailable.

## Boundary

The Web process may create persistent jobs, but the Worker claims and executes them. Browser-supplied role, owner, organization, workspace, EmployeeVersion, DSH-native Skill, or Policy data is never trusted without server authorization.

See [Employee workspace](../../docs/features/employee-workspace/README.md) and [Worker queue](../../docs/features/worker-queue/README.md).
