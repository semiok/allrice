# MET-150 — Codex subscription chat stability

## September 22 closeout boundary

Final fixed-candidate validation `64413ba` also completed the real Snow/M5 development Run `0b72a009-0d70-4e2e-b903-07f23794637e`: one route attempt, three completed assistants, one successful physical command and a tested/reviewed formal delivery. Input 145,740 / output 5,559 were recorded completely; cache detail is unknown, not a certified zero. Internal Token statistics did not interrupt the task. Existing failed/unknown receipts were preserved without a manual Token reservation. PR #86 carries this policy together with the verified MET-144 fixes; after integration and Dev health/restoration verification, both scopes may close. Official quota UI remains MET-152, and Prod remains unchanged.

The user approved closing the stability scope after integration; open-ended trial observation and choosing a new internal Token cap are no longer closure gates. Official subscription window/balance/reset presentation is tracked separately in **MET-152 (Backlog)**, not claimed implemented here. Token/cache statistics are not the official remaining allowance. PR #82 (pre-dispatch startup accounting) merged as `fc721f6`; the observation-policy follow-up is in PR #86 pending integration. Dev evidence remains valid; Prod is unchanged.

## September 22 decision: Codex subscription Tokens are statistics, not admission

The user explicitly prioritizes product usability before commercialization. This decision supersedes the historical monthly-cap/manual-reservation/assistant-token-budget rules below.

- Default `ALLRICE_CODEX_TOKEN_POLICY=observe` (also when unset): server-verified Codex subscription routes do not enforce internal per-task, shared-assistant or organization/user/employee/provider monthly Token ceilings. API/unverified routes retain enforcement. Explicit `enforce` is the legacy rollback switch; invalid explicit values also enforce.
- Actual input/output/cache receipts remain immutable and distinguish known subtotals from missing receipts. Cached input remains part of input, not added twice. Missing Token receipts alone do not fail an otherwise evidenced completion or lock subsequent chats. Execution ambiguity, partial results, missing deliveries and unresolved external operations are still not successes.
- Shared model/tool-call counts, concurrency, deadline/cancellation, lease fencing, external effects/approval and actual provider quota checks remain active. Per-response generation settings and actual model context capacity are not monthly billing quotas.
- Tenant details show monthly recorded usage/cache/unknown receipts, not an internal remaining percentage. Assistant and administrative views identify Tokens as observational. Historical 5M configuration and past manual reservations are retained, not relabeled as actual usage or official Codex quota.
- The proposed **24,946 Token manual reservation** for Run `756dfee1` is **withdrawn**, not approved or applied. No new administrator budget exception is required. The failed Run and incomplete receipt stay unchanged; no side-effect replay.
- Scope: Dev only, MET-150 policy follow-up supporting MET-144. No Prod, main merge, Gemini billing, MET-145/146 or new high-privilege flag enablement.

Implementation covers Worker admission/completion, ordinary and shared assistant accounting, tool operation admission after observed Token overage, and tenant/admin presentation. Verification and deployment evidence are recorded in the issue; implementation alone does not close MET-144.

Verification/deployment: code `460a12d0f07aa081b6cced590e5a8c6d6acc155a` is deployed only to Dev at `met150-token-observe-20260922`. Full suite: 313 files / 2,812 passed (integration/browser-dependent suites separately gated); targeted isolated PostgreSQL suites, workspace typecheck, lint, DSH verification and clean production build passed. Both Dev processes explicitly use `observe`; existing security flags, credentials and `.env` are unchanged. Prod configuration hashes and process IDs matched the pre-deployment baseline.

Real Snow browser Run `105228d0-61f6-4766-843b-e3b10f8e5b48` succeeded through the verified Codex subscription route with a complete receipt. Old Run `756dfee1` retains the identical incomplete ledger hash and zero manual reviews, proving follow-up chat no longer requires a budget exception. Snow remains a member and its historical 5M setting is unchanged. The sidebar displays recorded usage instead of remaining percentage; the administrator projection marks the old unknown receipt observation-only. Private evidence: `.local/evidence/tokenobserve/` and `tokenobserve-deployment*.json`. No main merge or Prod deployment; full MET-144 cooperation acceptance remains separate.

## Historical scope (superseded where explicitly stated above)

Earlier scope was ordinary Codex subscription chat on Dev; the September 21 follow-up authorized a persistent Snow-only 5,000,000 monthly configuration. Earlier enforcement decisions and evidence remain below as history.

## September 21 follow-up: rejected startup is not a dispatched model call

MET-151 exposed Run `35836b20` failing in the local assistant controller's binding checks, before the native host received an assistant binding or model prompt. The Worker had already marked execution as started and therefore produced an unknown-usage receipt. The package check itself was repaired in MET-151; this separate MET-150 patch repairs future classification, not the historical record.

- Only a **fresh native host**, a matching trusted Run/attempt, and rejection in the **local controller bind before native binding/prompt** produce the in-process `DshStartupRejection` proof. The host is dropped first. Reused hosts, runtime acquisition failures, native RPC failures, sent prompts, timeouts and missing receipts do not acquire this proof.
- The Worker accepts the proof only for the same ordinary Run/attempt, never a durable workflow. It uses the existing `undispatched` ledger path, which additionally requires this attempt's newly frozen subscription snapshot before certifying zero use. A recovered snapshot stays unknown; any existing receipt is preserved under the tenant/route locks. The failed task remains failed, but a proven unused attempt no longer blocks the next task as unknown usage. Subscription cost stays N/A.
- Neither JSON fields nor a matching error name confer proof. Cross-Run and cross-attempt objects are rejected. No error-message matching, log-based zero inference, historical rewrites, risk-review removal, quota changes or feature-flag enablement is included.
- Verification: adapter/budget/diagnostic regressions **63 passed**; Worker + isolated PostgreSQL/route-preservation suites **21 passed**; full P25 regression **16 files / 181 passed** (counts overlap). The final Worker suite additionally injects the original local-bind rejection through the **real adapter → Worker → PostgreSQL** path and asserts zero native assistant/prompt calls, failed task status, complete zero-use subscription receipt and subsequent quota admission. Other synthetic transport/identity/missing-receipt failures remain unknown. No live provider call or real tenant setting is needed for these failure-path tests.
- Worker and integration TypeScript checks, changed-file lint/format, and Worker dependency/production build passed. PR/CI/deployment status is tracked in MET-150; this implementation record does not claim a new main merge or Dev deployment. Existing Dev `b787bd9` and Prod are not changed by local tests.

User-approved next scope: MET-144 X01-A/B/C only after this small fix; MET-145 Boost and MET-146 Teamwork are deferred, not implemented or enabled. MET-150 observation work remains separately tracked.

## September 21 follow-up: Snow monthly budget and tenant-visible balance

The user explicitly requested a persistent **5,000,000 Token monthly user limit for Snow**, replacing the inherited 2,000,000 default. This is a Dev-only per-user resource override, not a global default, per-Run cap, provider subscription allowance or another temporary acceptance grant. Other resource limits, original receipts/cache counts, unknown-usage reservations, roles and execution gates remain unchanged. The configuration write and prior default are audited.

The tenant sidebar now adds the authenticated human account name and remaining percentage below the Rice employee card. Expand it to see exact recorded/remaining Tokens, monthly limit and the reset timestamp. Reads use the same current-user/current-workspace monthly ledger and effective resource limit as admission; cached input is already a subset of input, never added twice or silently subtracted. Incomplete receipts are disclosed in the details. This balance is not a guarantee that every task can start: organization/employee/provider limits and independent execution authorization still apply.

The endpoint verifies current membership and only exposes the authenticated user's balance. It never accepts a client-selected user/limit, never caches private data, and distinguishes unavailable/loading from exhausted. The UI refreshes after history completion, every 30 seconds while visible, on window focus, and on manual request. Scope changes discard prior-account data. No model calls are needed to verify this feature.

Verification: 16 unit/API/UI/governance regressions and 3 isolated PostgreSQL tests passed; Web/Database typechecks, changed-file lint/format, full build and DSH distribution verification passed. Dev release `8c362bafe040346972d5aa25881c944988d9bb83` was deployed at `/Users/a123/allrice-dev-releases/met150-monthly-quota-20260921`. Public Snow login checks confirmed desktop and 390px sidebar rendering, expanded details, refresh/focus recovery, deliberate 503 -> unavailable -> recovery, anonymous 401 and unauthorized workspace 403. At verification, the ledger subtotal was 2,824,029, balance 2,175,971 (43% displayed), with two incomplete historical receipts explicitly disclosed. Prod launch configuration and processes were unchanged. No model request, main merge, extra capability enablement or user role change was made. Private deployment/UI/configuration evidence is under `.local/monthly-quota-deploy`, `.local/monthly-quota-ui` and `.local/met150-snow-quota-change.json`.

## Evidence

Run `094238ea-e262-4636-a02a-b311a71808dd` produced a complete 1,797-character final answer and complete usage receipts. Its 478,964 input Tokens included 377,856 cached input Tokens; output was 10,210. The old post-flight condition incorrectly reported `MODEL_OUTPUT_BUDGET_EXCEEDED` because cumulative input + output exceeded 136,000, although output was below 16,000. It then replaced the answer with a generic failure. This was not a provider weekly-quota response or a timeout.

## Decisions

- Keep actual input/output/cache counts intact. Cumulative multi-call usage is not the instantaneous context size. Non-cached input is not an official subscription-quota meter.
- Initial rollout: after a verified ordinary subscription task completed with a nonempty answer and complete usage, a post-flight internal Token-budget overrun became a persisted `budgetWarning`, not an exception. Subsequent follow-ups below first hid successful warnings, then removed the ordinary subscription cumulative threshold itself. Historical persisted warnings remain compatible. Existing monthly admission, timeout, loop detection, adapter output settings and provider errors remain in force.
- Unknown receipts, partial answers, unverified identity, API monetary limits and governed assistant/root settlements are not softened. Report distinct total-Token/output-Token/API-cost error codes where a refusal still applies.
- Historical answer recovery is a read-only history projection for the allowlisted Token-budget failure codes only: same tenant, owner, Session, Run and final job attempt, an `assistant.text.completed` followed by a matching `turn.completed`, and complete subscription-proven usage. Historical Run state and usage ledger remain unchanged. No model rerun and no raw reasoning extraction.

## Follow-up: normal completion is not a tenant warning

After successful Run `49fe3f09-44aa-4986-941b-bb9f1ef3585c`, the user chose to observe real tasks before tuning budgets. Completed messages no longer show the internal Token-budget warning, including already persisted successful messages. Backend warning metadata, cache-inclusive raw receipts, current thresholds, monthly admission, timeout/loop/concurrency safeguards and real failure presentation remain unchanged. Historical failed messages with a verified recovered answer retain their explanation. No cache subtraction, quota increase, database rewrite or new model call is needed for this UI correction.

## Follow-up: observe cumulative usage for ordinary subscription tasks

The next worker revision removes the arbitrary cumulative Token ceiling for server-verified ordinary Codex subscription tasks (no governed assistants and no durable workflow). Neither cumulative input + output nor cumulative output is compared with legacy `maxTotalTokens` / `maxOutputTokens` at completion. It does not substitute a 1M cap or subtract cache from receipts. Complete usage, a nonempty final answer and a non-partial outcome remain required; incomplete receipts, partial outcomes and empty responses have their own real failure codes.

Monthly admission uses an estimate of the prepared initial input plus one call's configured output allowance, not the legacy fixed whole-task amount. This is a forecast, not an atomic whole-task reservation or a guarantee against monthly overshoot. Actual multi-call/cache-inclusive usage continues to settle into the ledger; an exhausted month still denies subsequent tasks. Existing unknown-usage review holds, organization/resource limits, concurrency, provider release gates and official quota observations remain in force.

Initial input checks and adapter output settings remain. Do not claim that every Codex provider version proves a hard wire-level output cap. Worker deadlines, cancellation and loop guards are unchanged. API, workflow and governed assistant/root limits retain their previous behavior.

No migration rewrites employee policies or immutable Session snapshots: their old numeric fields are retained for compatibility and for other execution scopes, but are not used as cumulative limits for ordinary verified subscriptions. Rollback can therefore use the prior release. Existing historical warning/failed-run records remain intact.

Regression covers both 49fe3f09's exact counts and a synthetic 1.5M-input/32k-output complete result, unchanged raw receipts, old default snapshots, monthly admission without a fixed cumulative hold, successful real-PostgreSQL settlement and subsequent monthly exhaustion, incomplete receipts and retained assistant/root protections. No intentionally inflated live model task is needed to test these arithmetic boundaries.

## Per-Run usage in the Runtime Console

The existing durable model-usage ledger records input, cached input and output per route attempt. The admin Session timeline now projects these receipts per Run, across all attempts, without adding a second accounting ledger or rewriting historical records. Totals are `input + output`; cache is a subset of input and is never added again. Queries aggregate separately from timeline events and join organization/workspace/Run identities so that repeated events do not multiply usage. Root receipts are not summed again with child ledgers.

Each Run shows total/confirmed Token usage, cached input, input including cache, output and attempt count. No receipt is displayed as unavailable, not zero. Missing or incomplete attempt receipts make the aggregate incomplete. Positive recorded cached input remains visible even when the full cache breakdown is unknown, explicitly labeled recorded/incomplete; unknown zero placeholders remain null, never proof of zero cache. A running Run is explicitly provisional even if earlier attempts have settled. Historical Runs display their existing receipts immediately. Statistics are observations, not a subscription-allowance estimate or a renewed budget warning.

## Tool result budget

- Central Broker policy covers large research results and selected read-only workspace data, not approvals, commands, changesets or Skill instructions.
- Above 12,000 characters, return valid JSON with an explicitly incomplete, bounded preview, source metadata and a full-result reference. Preserve leading/trailing array samples and label omitted middle entries.
- Store exact UTF-8 result bytes up to 2 MB using existing tenant-private storage/export metadata, workspace quota and authenticated downloads. Include originating Run and tool-call identity in provenance. If storage or quota fails, explicitly report that the full result was **not saved**; do not send the unbounded result back into the model context.
- `workspace.file.read` now returns at most 4,000 characters by default/per page; `offset`, `totalCharacters`, `truncated` and `nextOffset` are explicit. Existing file-read authorization still applies. No extra storage-read or execution permission is granted.
- Ordinary native DSH `web_search` must also pass through the Broker; its previous direct hosted-search path bypassed result bounding. The provider hosted-search endpoint remains the same; no second agent loop is introduced.
- Existing upstream compaction behavior remains unchanged. This fix bounds newly produced results; it does not rewrite old native transcripts or pretend to have retroactively compacted them.

## Verification

Unit tests cover budget classification, truthful cache accounting, warning eligibility, no softening of incomplete/assistant/API results, bounded previews and unchanged small/control results. Isolated PostgreSQL + real local-storage tests cover warning delivery/audit events, historical recovery, cross-tenant/owner/attempt denial, exact byte-preserving full results, pagination and storage quota failure. React server rendering checks visible answer + warning for new and historical messages. A real pinned DSH subprocess + synthetic loopback provider checks native search -> Broker -> bounded result -> next model request, with invalid-input denial. Real Codex Dev smoke is a separate deployment acceptance step, not replaced by synthetic tests.

Rollback: switch Dev launch services back to the prior immutable release; no database migration or accounting rewrite is required. Prod stays untouched.

## Integration follow-up (2026-09-21)

PR #76 packages the previously Dev-verified stability fixes and includes the two legacy subscription fixture corrections from #73. PR #77 packages the monthly balance separately after #73 → #74 → #75. MET-150 remains under observation; merging its completed code does not close the observation work.

The first #77 CI exposed the missing monthly-quota endpoint in the isolated workbench HTTP fixture. The fixture now returns a scoped synthetic receipt and asserts the current workspace; unknown requests are still rejected. A full-workbench balance/reload test was added. A targeted mobile regression also exposed focus escaping past the new quota summary: the sidebar trap now includes summary elements and excludes children of closed details. The regression failed before the complete fix and passed after it. Local subscription/receipt PostgreSQL checks: 40 passed; full Chromium workbench/composer checks after adding the quota fixture: 31 passed; final CI is required before merge. No model task or tenant permission change was used for these tests.
