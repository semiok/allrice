/**
 * Reviewed exceptions for `row-lock-audit.test.ts` (MET-210 #4). Every entry
 * needs a reason a reviewer can check; the test fails on stale entries.
 */

/** GET handlers that write by design; their locks protect those writes. */
export const writingGetRoutes: readonly { route: string; reason: string }[] = [
  {
    route:
      'apps/web/app/api/v1/bridge/device/file-transfers/[kind]/[id]/route.ts',
    reason:
      'Rice Bridge device protocol, not a page read: authorizing or downloading a transfer renews the operation lease (ledger heartbeat UPDATE) in the same transaction, and its locks keep a revoked operation from being renewed.',
  },
  {
    route: 'apps/web/app/api/v1/connections/callback/route.ts',
    reason:
      'OAuth redirect callback: completeOAuthCallback stores the connector authorization (oauth_envelope/oauth_stage) and an audit row in the same transaction.',
  },
];

/** Lock clauses reviewed on a GET path (file, owner function, clause). */
export const reviewedGetLocks: readonly {
  file: string;
  owner: string;
  clause: string;
  reason: string;
}[] = [
  {
    file: 'packages/database/src/tenant-management-scope.ts',
    owner: 'checkTenantManagement',
    clause: 'for update',
    reason:
      'Runs only when options.expectedConnection is set, which only the tenant MCP mutation branch passes (lib/tenant-administration/resources-http.ts); the GET inventory never sets it.',
  },
];

/** Interface-typed calls on GET paths the audit cannot follow. */
export const reviewedUnresolvedCalls: readonly {
  target: string;
  reason: string;
}[] = [
  {
    target: 'packages/contracts/src/storage.ts get',
    reason: 'Object storage adapters read blobs; they run no SQL.',
  },
];
