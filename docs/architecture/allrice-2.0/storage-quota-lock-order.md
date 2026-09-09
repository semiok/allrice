# Storage increments: one quota gate, separate identity locks

All eight increment entrypoints acquire the same transaction advisory lock,
`hashtextextended(organizationId + ':' + workspaceId, 42)`, before row admission
locks. It is not a policy grant. Existing owner, membership, archive, Run/job,
target, exact approval and end-of-I/O checks are unchanged.

| Increment entry                              | First lock in its publication transaction | Following locks                                              |
| -------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| `createStorageMetadata`                      | quota                                     | metadata insertion                                           |
| `registerToolBrokerExport` (direct delivery) | quota                                     | chat session / platform test, version lineage                |
| `publishWorkbenchArtifact`                   | quota                                     | session, identity SHARE, optional derived operation, Run/job |
| `publishCloudOperationArtifacts`             | quota                                     | runtime root, stopped attempt, policy, identity, session     |
| `publishBrowserObservationArtifact`          | quota                                     | current identity, grant, browser workspace, Run/job, session |
| `captureLocalBrowserFile`                    | quota                                     | current controller, exact capture / STARTed operation        |
| `registerManagedBrowserEvidenceArtifact`     | quota                                     | exact running task and job lease                             |
| `registerWorkflowArtifact`                   | quota                                     | workflow Run, existing immutable object identity             |

Only the three publishers in the table pass an already-open transaction to
`registerToolBrokerExport`; they own the quota gate **before** session, root,
operation or browser locks. The export helper's second acquisition is reentrant,
not a remedy for calling it after an unrelated lock. The Worker direct delivery
handler passes no transaction, so the helper opens and locks its own transaction.
New callers must preserve this first-acquisition rule.

Browser/preview authority can continue identity SHARE → grant → browser workspace
→ Run/job → preview's reused process authority / session SHARE. Read-only
authority never waits for the storage quota gate. `assertWorkbenchSession`
retains its session UPDATE serialization (feedback limits and version admission)
but uses workspace SHARE for both reads and writes. Storage quota no longer
upgrades that identity row to UPDATE, removing the tenant/session and
tenant/browser upgrade cycles. Artifact policy and ledger lock order are not
weakened or replaced by automatic deadlock retries.

Accounting is `sum(size_bytes) WHERE state <> 'deleted'`: pending uploads reserve
bytes, pending→ready does not reserve again, and tombstones release quota.
Ready transitions accept only pending rows, never deleted rows. Concurrent
deletion can conservatively leave a publisher seeing the old usage until commit;
it cannot create an uncharged increase. Workflow references to an already-ready,
scope/checksum/size-identical object do not double charge. Rollback and commit
release the transaction gate; unrelated tenant/workspace keys remain independent.

Validation is PostgreSQL in a disposable schema, no personal accounts or models:
all eight real entrypoints are traced to a first-position gate and quota denial;
four cross-source concurrent pairs admit only one fitting increment; pending,
ready, tombstone, retry, rollback and independent-tenant behavior are checked.
An explicitly scheduled session-reader/browser-publisher interleaving reproduces
the old PostgreSQL deadlock and completes after this change. Cloud result journals
in these quota tests are synthetic stopped-result fixtures, not evidence that a
physical cloud runner was executed.
