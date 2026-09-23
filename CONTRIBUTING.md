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

Reused third-party code must follow the repository's provenance and license
rules. The pull request must record the source repository, commit, path,
license, dependencies, and modifications. Untraceable source copying is
rejected.

For every DSH upgrade or adapter/patch addition or removal, update the
[DSH reuse and replacement decisions](docs/architecture/dsh-reuse-and-replacement.md)
in the same PR. Record the exact upstream revision, compatibility evidence,
retirement conditions and rollback boundary; an unchanged decision still needs
the new review version and reason. Use the
[upstream governance procedure](docs/operations/dsh-upstream-governance.md)
and run `pnpm dsh:golden-replay`. Keep historical replay fixtures immutable;
generating new fixtures from the candidate does not prove old-session compatibility.
