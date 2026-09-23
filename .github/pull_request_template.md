## Linear issue

- MET-

## What changed

-

## Runtime and data impact

- [ ] No environment, port, Docker, health-check, storage, or database change
- [ ] Runtime changes are reflected in `.env.example` and `docs/development/README.md`
- [ ] Database changes include an ordered migration and pass setup from an empty database

Describe any new variable, secret, service, migration, backfill, rollback, or compatibility concern:

## Validation performed

- [ ] `pnpm format:check`
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm db:setup` from an empty development database (when runtime/data changes)
- [ ] `pnpm test:compose` (when runtime/data changes)

## Documentation and provenance

- [ ] Relevant feature documentation and acceptance status are updated
- [ ] Reused external/OpenRice code records repository, commit, path, license, dependencies, and modifications
- [ ] DSH dependency, profile or patch changes update [reuse and replacement decisions](https://github.com/semiok/allrice/blob/main/docs/architecture/dsh-reuse-and-replacement.md), including reviewed version, retained patches and retirement evidence (or explain why not applicable)
