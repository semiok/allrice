/**
 * Reviewed exceptions for `row-lock-audit.test.ts` (MET-210 #4). Every entry
 * needs a reason a reviewer can check; the test fails on stale entries.
 */

/** GET handlers that write by design; their locks protect those writes. */
export const writingGetRoutes: readonly { route: string; reason: string }[] = [
  {
    route: 'apps/web/app/api/v1/connections/callback/route.ts',
    reason:
      'OAuth redirect callback: completeOAuthCallback stores the connector authorization (oauth_envelope/oauth_stage) and an audit row in the same transaction.',
  },
];

const BRIDGE_FILE_TRANSFERS =
  'apps/web/app/api/v1/bridge/device/file-transfers/[kind]/[id]/route.ts';
const LEASE_RENEWAL =
  'Rice Bridge device protocol: authorizing or downloading an operation transfer renews the operation lease in its own transaction (ledger heartbeat UPDATE); its locks keep a revoked operation from being renewed. Everything else this GET reads is still audited.';

/**
 * Functions a GET route calls that run their own writing transaction; the
 * audit does not walk into them from that route only.
 */
export const writingGetCalls: readonly {
  route: string;
  file: string;
  owner: string;
  reason: string;
}[] = [
  {
    route: BRIDGE_FILE_TRANSFERS,
    file: 'packages/database/src/runtime-ledger/ledger.ts',
    owner: 'heartbeat',
    reason: LEASE_RENEWAL,
  },
  {
    route: BRIDGE_FILE_TRANSFERS,
    file: 'packages/database/src/runtime-governed-bridge.ts',
    owner: 'createGovernedBridgeOperationLedger',
    reason: `${LEASE_RENEWAL} The factory only assembles the policy admission and ledger closures the heartbeat transaction runs.`,
  },
  ...[
    'apps/web/app/api/v1/employee-instances/route.ts',
    'apps/web/app/api/v1/employees/route.ts',
    'apps/web/app/api/v1/workspace/route.ts',
  ].map((route) => ({
    route,
    file: 'packages/database/src/workspace/service.ts',
    owner: 'ensureDefaultEmployee',
    reason:
      'Provisions the default employee on first read in its own short transaction (employee-deployments advisory mutex, then insert). Only employee deployment administration shares that key; Worker admission does not.',
  })),
];

/** Lock clauses reviewed on a GET path (file, owner function, clause). */
export const reviewedGetLocks: readonly {
  file: string;
  owner: string;
  clause: string;
  reason: string;
}[] = [];

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
