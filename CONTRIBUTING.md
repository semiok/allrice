# Contributing to AllRice

Start with the [fresh-clone development workflow](docs/development/README.md). A contributor should be able to run `corepack enable`, `pnpm install`, and `pnpm dev` without undocumented database steps.

Every contribution must:

1. reference an AllRice Linear issue;
2. stay within that issue's product and security boundary;
3. update the relevant feature README;
4. include allow and deny tests for authorization changes;
5. include restart/recovery coverage for persisted execution changes;
6. pass format, lint, typecheck, tests and build;
7. use a focused pull request and wait for review before merge.

Before opening a pull request, run:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Changes to migrations, runtime environment, Docker images, ports, health checks, or startup behavior must also update `.env.example` and the development guide. Database changes must pass both `pnpm db:setup` from an empty development volume and the CI Compose smoke test.

Use a focused issue branch, reference the owning Linear issue in the pull request, and list the commands actually run. Do not commit `.env`, local storage, database volumes, credentials, or generated build output.

OpenRice and AllRice are independent products. Reused code must follow the provenance and boundary rules in [the OpenRice extraction audit](docs/audits/openrice-extraction-audit.md); do not copy OpenRice wholesale. The pull request must record the source repository, commit, path, license, dependencies, and modifications. Untraceable source copying is rejected.
