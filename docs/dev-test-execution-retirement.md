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

## Historical terminal chat cutoff v2

The original v1 API and CLI above still require strictly idle historical state.
An explicit v2 branch handles an already terminal development-test Run whose
old question, dispatch, operation or assistant never acquired a truthful final
receipt. It preserves those states. This is a private maintenance API, not an
employee tool, general cancellation mechanism, or a grant to use another SDK.
It requires migration `0218_terminal_test_chat_cutoff.sql`; no new table or DSH
change is involved. The existing v1 CLI does **not** accept an offline-v2 review.
A separately reviewed root maintenance owner must supply the original normal
stop, physical and cloud preservation guards before calling this branch.

Use the original exported functions with these exact shapes:

```ts
const plan = await previewNativeTestChatRetirement({
  schemaVersion: 2,
  kind: 'development-test-chat-terminal-cutoff',
  requestId, // new canonical UUID, retained for all readback
  authorizationEvidenceDigest, // exact test-scope authorization
  scopes, // 1..7 exact { contextKind:'chat', contextId, organizationId, workspaceId, ownerId }
  legacyExecutors, // one { scope, artifactId, storageNamespace } per exact scope
});
const physicalScope = nativeTerminalTestPhysicalScope(plan);
// Obtain an actual terminal-native-physical-absence-v1 proof with this exact
// requestId, plan.digest and physicalScope.digest. Never fabricate a proof.
const receipt = await applyNativeTestChatRetirement({ plan, physicalProof });
const independentReadback = await readNativeTestChatRetirement(plan);
```

The reviewed executor namespace must end with the exact
`/<organizationId>/<workspaceId>/<ownerId>/<contextId>/sessions` tuple. NULL
origin and zero bindings do not mean that no old executor or writer range needs
inspection. The operator must derive the original artifact and storage root
from actual source/journal facts and preserve every file hash and provenance.
The private API validates the proof's identity, scope and at most120-second
validity; it cannot observe the OS or validate a journal on behalf of its caller.
The source-pinned owner must retain original journal bytes/inodes, normal0
Web/Worker stop observations, complete process/writer inventories, exact
historical-cloud preservation and both original window/lock authorities.

This v2 slice accepts only implicit chats: native origin NULL, no native binding
and no executor-transition/adoption receipt. Every associated root/child Run
must be `succeeded`, `failed` or `canceled`, and every Job must be terminal; both
require their recorded completion time. Any
live Job/operation lease, unfinished model admission, live registered runtime,
uncleaned cloud attempt or enabled automation rejects the plan. Real PPT is
explicitly excluded. A nonterminal Run must first use its original canonical
cancellation path; neither an archived chat nor a terminal Job relaxes this gate.

The plan preserves complete SQL row fingerprints, full question/dispatch and
unknown consumer facts, Rungraph/Job identities, clocks, usage/budgets, messages,
origins, independent outputs and their business relationships. Apply locks the
exact context and graph, compares the whole plan again, archives only the chat
and appends an immutable0199 retirement row. It does not set `continued`,
`completed`, `settled`, runtime-idle or SDK-cleanup facts. Readback status
`completed` means only that this retirement request committed. The original
states and financial uncertainty remain unchanged, including a stale running
conversation runtime attached to a canceled Run.

Migration0218 places permanent guards on Run/Job, root/child links, employee
execution identity, question/dispatch, clocks, operations/assistant admission,
conversation runtime/input/followup, registry, native owner/binding and executor
transition writes. Guards check OLD and NEW identifiers and retain saved
Run/Job identities, preventing a later writer from detaching or transplanting
the old graph. The shared admission mutex serializes existing writers with the
exclusive cutoff; the cutoff uses NOWAIT/try-locks and rejects stale plans.
Repeatable-read and serializable admission also lock the chat source row with
NOWAIT. Cutoff writes a new row version even if already archived, so an older
snapshot receives a serialization failure rather than overlooking the new
immutable receipt. Read-committed admission keeps the shared mutex and fresh
retirement query without blocking unrelated chat-title writes.
Queue claim, runtime acquisition and native begin/continue/wake also check the
same cutoff before clock refresh, lease allocation or SDK work. This blocks old
application writers that obey the database; it cannot prevent an unrelated OS
process from executing arbitrary SDK code without consulting AllRice.

The existing chat reader verifies v2 preservation in the scanner's original
read-only transaction and returns the same scope shape as v1. Only those exact
verified contexts leave executable coverage. Archived alone, elapsed time and
missing bindings never qualify. The deadline on the physical observation is
checked when committing, not used as an expiry of the permanent retirement.
If a write acknowledgement is lost, read the original plan/request. Do not
create another request, extend a physical proof, or automatically call apply.

The isolated SQL fixture recreates the seven known QA shapes: two started
dispatches on failed execution; one started dispatch; an unknown operation on
succeeded execution; two unknown assistants/three unknown operations plus an
unfinished call; a parked succeeded dispatch; an unfinished canceled call; and
a ready question/parked dispatch/stale running runtime on canceled execution.
It preserves original pending facts,18 synthetic unknown permits, journal bytes,
two independent outputs and another unretired scope; tests direct old-writer
reopen attempts, concurrent cutoff, lost-ack readback and stale-plan rollback.
These are synthetic fixture results, not a Dev retirement or SDK-close claim.
