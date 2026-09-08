# B4 UI/status corrective release — 2026-09-08

This is a correction to B4 Dev acceptance, not a new execution-capability
release or the start of B5. Keep all eight execution flags OFF. Do not change
Bridge packages, tenant pairing/grants, migrations, model credentials or Skills.

## Report and findings

- ChatFlow requested `runtime/local-commands` once per historical assistant Run
  even when the capability was disabled. The API's intentional 404 was caught
  in JavaScript but still generated browser console/network errors.
- A live Bridge without an authorized folder was labelled offline in the
  composer, while the modal correctly showed its device presence as online.
  Existing offline grants could also take precedence over a live device.
- Two read-only Dev observations at 12:09:57Z and 12:11:38Z showed the M5
  device's heartbeat advancing, with zero active folder grants. Only
  authenticated device heartbeat/claim calls advance presence; the devices GET
  does not. This proves continuing use of the paired device credential, not
  which remote process is running. Do not force the device offline or revoke it.
- Refresh responses lacked explicit server cache prevention and race guards.
  These are hardened here; cached responses were not established as the cause
  of this specific report.

## Changes

- Server-rendered ChatFlow uses the same three-flag capability check as the API.
  Disabled local-command panels never mount or fetch. API authorization and
  disabled responses remain unchanged; cloud historical panels are retained.
- Device connectivity and folder authorization are projected separately. Online
  without a folder stays green; offline/unknown hides remembered folder names.
- Manual refresh supersedes older polling, cannot be preempted by a background
  timer, times out after 20 seconds, and cannot write into another tenant scope.
  Failures show unknown rather than treating the old snapshot as current.
- The modal reports successful refresh time, last heartbeat and the established
  90-second presence window. Refresh errors clear on successful refresh without
  clearing unrelated chat errors. The devices API explicitly sends private,
  no-store responses, including errors.
- Missing, revoked, expired or anomalous future heartbeats are not online.
  The existing 90-second expiry is not shortened or extended.

## Regression gates

Run shared-package builds before CLI subprocess tests, then typecheck/lint and
the unit suite. In the first clean-worktree run five desktop startup fixtures
timed out; after the dependency build the full suite passed (1,315 tests;
349 explicitly gated/platform tests skipped). No desktop production code or
test timeout was changed to obtain that result.

The new `bridge-presence.integration.test.ts` covers real isolated PostgreSQL:
six cases for presence, expiry, future/null timestamps, tenant/owner isolation,
revocation and authenticated heartbeat recovery. Unit tests also cover the
shared feature gate, historical panel mounting, presentation and refresh races.

Run `pnpm exec tsx scripts/acceptance/ui/b4-status-regression.ts` after building
Web. It uses an isolated disposable schema and browser profile, a real signed
synthetic portal and real API responses. Two Sessions contain eight historical
assistant Run IDs. It verifies session switching/reload/polling, no disabled
local-command requests, no unexpected HTTP or console errors, actual heartbeat
expiry, preserved-but-hidden offline grants, manual recovery, and an explicitly
injected network failure. The injected failure is recorded separately from
normal zero-error browsing. No Worker/model/VM or live tenant is involved.

Final Dev rollout additionally requires a clean merged SHA/build manifest,
unchanged execution flags and Bridge ZIP hashes, protected-data comparisons,
and read-only browser verification of actual Snow history and Bridge refresh.
Private deployment evidence records the exact build, checks and screenshots;
this document alone does not assert that deployment has occurred.
