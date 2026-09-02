# Acceptance suites

Acceptance scripts are grouped by product capability rather than the Linear
issue that first introduced them:

- `platform/`: release gates, authorization and governance.
- `chatflow/`: Session continuity and event-stream behavior.
- `routing/`: Provider selection and explicit fallback.
- `ui/`: public SaaS surfaces and legacy-route boundaries.
- `runtime/`: DSH process inventory and runtime-console behavior.

The historical `scripts/met*.{mjs,ts}` files remain as small compatibility
entry points. New checks belong in the relevant capability folder and should
receive a semantic package script such as `acceptance:chatflow`.
