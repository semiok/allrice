# Database domain boundaries

`src/index.ts` is the package's stable public facade. New database code belongs
in a domain directory and is exported through that directory's `index.ts`:

- `capabilities/`: capabilities and connector bindings
- `conversation/`: ChatFlow sessions, checkpoints, usage, and wakeups
- `employees/`: employee configuration, quality, and release state
- `execution/`: queueing, workflows, routing, and tool execution
- `memory/`: memory and knowledge retrieval
- `providers/`: model providers and DSH runtime inventory
- `workspace/`: tenant workspace, files, assignments, and memory recall
- `platform-content/`: reviewed operational content synchronization (not schema
  migration history)

The modules in these directories contain the canonical implementation,
including the larger workspace, platform employee, and P1 execution services.
Their former root files are compatibility-only re-export facades so existing
imports keep working during the staged reorganization. Split large services
only along transaction boundaries; do not duplicate implementation just to
make the directory tree look complete.

Schema migrations and operational product content are separate concerns.
Historical SQL migrations are immutable. Reviewed Skill/employee product
content is synchronized from its canonical catalog after migrations and is
validated against rollback and same-version drift.
