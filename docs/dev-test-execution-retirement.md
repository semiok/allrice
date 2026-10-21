# Retiring a development-test chat's execution

This operator ends execution for an explicitly approved development-test chat.
It archives the chat and records a terminal receipt. Messages, original native
origins and bindings, logs, accounts, company data and independent deliverables
stay in their existing stores. It is not an employee tool or a general archive
command. Archiving alone does not release an executable-package dependency.

Only `chat` is supported in this slice. Other native context kinds and scheduler
control partitions remain protected by the existing coverage check. This does
not establish the final single-package result.

## Sequence

1. Use the current reviewed source, full CI, normal Dev deployment and actual
   function acceptance. Before migration 0199, run the **previous release's**
   reference verifier. With both producers normally stopped and fenced, apply
   migrations, run the new verifier, then start and verify the new services.
   The new verifier must not run against an unmigrated database.
2. Hold the existing QA window and verify the actual main/release identities,
   service health and idle state. An unfinished or unknown execution must be
   resolved using the existing stop/cleanup/readback flow first. Do not erase
   historical unknown receipts to make this check pass.
3. Write a private (0600) request with a fresh `requestId`, the SHA256 digest of
   the user's scope authorization, and exact `scopes`, each containing
   `contextKind: "chat"`, `contextId`, `organizationId`, `workspaceId`, `ownerId`.
4. Run the operator's `preview` mode with `--root`, `--input` and a new `--output`.
   Review every scope, origin, binding and preservation fingerprint. In-flight
   work blocks preview/apply. A later binding, message, file, storage state or
   independent business-reference change invalidates this exact plan.
5. Write the root review described below. Run `apply` once, using the plan as
   `--input` and new receipt path as `--output`. Read back the original receipt
   if any response is lost; never start a new request to hide an unknown result.
6. Verify real history/artifact reads, immutable original provenance, rejection
   of restoration/new messages/native bindings, and unaffected other chats.
   Re-run executable coverage; it separately lists verified retired contexts.
   Package/configuration retirement still requires the existing deployment
   fence, reference and physical-process checks and official cleanup tool.

All modes are disabled unless explicitly selected. `preview` and `readback` are
read-only. Apply is restricted to the local `allrice_dev` database and the current
Dev source/release. Its durable intent prevents a repeated CLI invocation from
reissuing an uncertain write. The database operation is also transactional and
checks the same request and plan digest on repeat.

## Root review

The private review is bound by `--review-sha` and has these exact fields:

- `kind: "allrice-dev-test-chat-retirement-review"`, `rootReviewed: true`,
  `reviewedBy: "root"`, `developmentTestScopesApproved: true`.
- `releaseDirectory`, `releaseSha`, `sourceTree`, `operatorSha256`, `planPath`,
  `planSha256`, `authorizationEvidenceDigest`.
- `activeReleasePath`, `qaLockPath`, `deploymentLockPath` point to the existing
  files under `~/allrice-dev/.local`; `qaOwner` is the exact live lock object.
- `healthUrls` are, in order, `http://127.0.0.1:3001/api/health/ready` and
  `http://127.0.0.1:3102/health/ready`.

The operator verifies the review, clean Git tree, live owner PID/start/nonce,
actual release and both service identities, producer counts and current jobs,
cloud cleanup, tests, runtime leases and authorization flows before mutation.
The review is operational evidence, not an alternative authorization system.
