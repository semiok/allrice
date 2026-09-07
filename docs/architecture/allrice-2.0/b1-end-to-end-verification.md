# B1 governed Bridge end-to-end verification

The automated acceptance suite is
`packages/database/src/runtime-ledger/bridge-http.integration.test.ts`.
It joins the real PostgreSQL ledger, current policy/approval services, trusted
Bridge adapter, bearer-device authentication, HTTP handler, SQLite journal and
existing local filesystem executor. The only database test redirect changes
`getDatabase()` to the isolated test schema; it does not replace policy or
authentication with an allow stub.

## Run safely

Use a dedicated disposable PostgreSQL database, never a tenant database:

```sh
ALLRICE_RUN_DB_INTEGRATION=1 \
ALLRICE_TEST_DATABASE_URL=postgresql://USER@127.0.0.1:PORT/TEST_DATABASE \
pnpm exec vitest run packages/database/src/runtime-ledger/bridge-http.integration.test.ts
```

Without the explicit opt-in, the suite is skipped. It creates a random isolated
schema, applies the actual migrations, and drops only that schema at teardown.
Shared extensions are installed in `public` under an advisory lock so parallel
test suites do not accidentally place extensions in a disposable schema.
All device credentials and workspace files are synthetic. Actual writes and
journals use separate directories inside a temporary directory, removed at
teardown. One test deliberately kills its own child process with `SIGKILL` after
that process has written its synthetic file, before it can persist the result.

## Verified boundaries

The twelve cases cover:

1. Ask is durable; polling before approval does not dispatch, write or create a
   receipt. Exact approval then permits dispatch, start, real write and durable
   result. Approval is consumed and the outbox is acknowledged.
2. An accepted result response lost on the HTTP connection leaves a local
   outbox entry. Reopening SQLite and retrying delivers evidence without another
   execution or canonical outcome event.
3. Losing the start response records unknown and never executes the file write.
4. Cancellation between claim and start retains cancellation intent and prevents
   the write.
5. Expired leases become unknown, never an automatically executable replacement
   attempt.
6. Revoking and reopening the real folder grant advances its database generation;
   the old exact approval cannot dispatch or be consumed.
7. Revoking a device after the file write rejects its upload and preserves its
   local result for manual reconciliation. Revocation does not invent a canceled
   or effect-free result in PostgreSQL.
8. An administrator's new deny after dispatch prevents start despite the earlier
   approval.
9. Modified payloads, evidence hashes and stale attempts cannot change the current
   execution result. Repeated stale receipts remain rejected.
10. A different tenant and a replacement device in the same workspace cannot use
    the original device's operation lease.
11. Real process death after the file effect recovers as unknown across SQLite,
    HTTP and PostgreSQL; replay of the dispatch cannot repeat the effect.
12. Device, policy and ledger canonical digests agree for numeric and non-ASCII
    object keys as well as nested data.

## Scope limits

This is a real service/component integration test, not a deployed Next.js route,
browser UI, production rollout, ARM64 packaging, notarization or power-loss test.
Production application builds and Dev deployment remain separate release gates.
It exercises only existing file capabilities behind the default-off operation
ledger flag; no command runner, shell permission or new public operation/approval
provisioning endpoint is implied. Revoked-token evidence remains locally retained
for manual reconciliation; there is no automatic credential bypass or complete
server-side recovery path for that case in B1.

## Verification record — 2026-09-07

- Before the governed factory dependency was integrated, database typecheck
  correctly failed on the missing `runtime-governed-bridge.ts` module. No
  substitute admission implementation was installed to make it pass.
- With assembly commit `93d2282` integrated, the actual end-to-end suite passed
  **12/12** and database typecheck passed.
- After adding the pending-approval polling assertion, the combined ledger,
  governed factory, policy, device journal, HTTP client and end-to-end suites
  passed **113/113 across six files**, with real database integration enabled.
- A separate root-agent production build found that the web helper's
  `./request.js` source import was not resolved by Turbopack. The fix uses the
  actual `./request.ts` source path and was integrated from `a51a024`; TypeScript
  success alone is not recorded as proof of a production Next.js build.
- After that import and current-policy fix, the same six real-integration suites
  passed **113/113** again; database typecheck and the new test's ESLint checks
  also passed.
