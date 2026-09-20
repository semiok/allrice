# MET-150 — Codex subscription chat stability

Scope: ordinary Codex subscription chat on Dev. No Gemini billing work, feature-flag enablement, quota increases, assistant/root-budget changes, or Prod deployment.

## Evidence

Run `094238ea-e262-4636-a02a-b311a71808dd` produced a complete 1,797-character final answer and complete usage receipts. Its 478,964 input Tokens included 377,856 cached input Tokens; output was 10,210. The old post-flight condition incorrectly reported `MODEL_OUTPUT_BUDGET_EXCEEDED` because cumulative input + output exceeded 136,000, although output was below 16,000. It then replaced the answer with a generic failure. This was not a provider weekly-quota response or a timeout.

## Decisions

- Keep actual input/output/cache counts intact. Cumulative multi-call usage is not the instantaneous context size. Non-cached input is not an official subscription-quota meter.
- After a verified ordinary subscription task completes with a nonempty answer and complete usage, a post-flight internal Token-budget overrun becomes a persisted `budgetWarning`, not an exception. The result, final message and `run.succeeded` event carry the warning. Existing monthly admission, timeout, loop detection, per-call output limits and provider errors remain in force. This post-flight threshold is **not a hard upper bound on actual aggregate usage**.
- Unknown receipts, partial answers, unverified identity, API monetary limits and governed assistant/root settlements are not softened. Report distinct total-Token/output-Token/API-cost error codes where a refusal still applies.
- Historical answer recovery is a read-only history projection for the allowlisted Token-budget failure codes only: same tenant, owner, Session, Run and final job attempt, an `assistant.text.completed` followed by a matching `turn.completed`, and complete subscription-proven usage. Historical Run state and usage ledger remain unchanged. No model rerun and no raw reasoning extraction.

## Follow-up: normal completion is not a tenant warning

After successful Run `49fe3f09-44aa-4986-941b-bb9f1ef3585c`, the user chose to observe real tasks before tuning budgets. Completed messages no longer show the internal Token-budget warning, including already persisted successful messages. Backend warning metadata, cache-inclusive raw receipts, current thresholds, monthly admission, timeout/loop/concurrency safeguards and real failure presentation remain unchanged. Historical failed messages with a verified recovered answer retain their explanation. No cache subtraction, quota increase, database rewrite or new model call is needed for this UI correction.

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
