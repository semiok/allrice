# AllRice employee Web composition

This DSH `0.2.1-rc.2` package supplies the M1-13 employee presentation and an
independent `allrice-web` profile. It does not switch the active 3.x entry.
M1-12 owns installation into the authenticated host, routing, and rollout.

M1-14 additionally exports `bindEmployeeSidebar(ctx, port)` from the native
client module and `EmployeeClientNavigation` from `./employee-client`. The
authenticated owner must provide the live employee/thread/archive projection
and real create/details/navigation/settings commands. Until that service is
provided the plugin does not replace the native sidebar. No transport or SSO
mount is installed by this package.

The new sidebar reuses the existing AllRice Frame/View/settings button and
the existing 0.1.1-derived `dsh-upstream` styles/Rows already in the repository;
these are not new rc.2 source copies or private package CSS imports. The 3.x
wrappers keep their existing SSE/subagent readers and settings page. The native
bundle imports only the shared presentation. Automation opens the native
`schedules` panel; settings dispatches to the later employee settings owner.

The root owner must abort actual HTTP/WS/resources, release native session
references and await Client/Cordis disposal before creating another key. The
port deliberately supplies no URL, namespace shortcut, token or default route.
`dispose()` preserves and rejects a recorded cleanup failure, including a late
root returned after cancellation; repeated disposal does not retry destruction.
Full module/ownership and recovery contracts are in
[`allrice-employee-sidebar.md`](../../docs/development/allrice-employee-sidebar.md).

The bundle disables Trajectory and both Open In plugins, selects Chinese,
and initializes compact chat usage presentation. The client shades only the
session-log-download header utility, permission/model selectors, and the two
usage/activity dock pills. Host log export, model/permission services,
accounting, account usage, and native subagent catalog tokens remain intact.
Process folding, tool details, questions, documents, and the composer use the
native implementation.

The native General `performance-usage` setting can override the initial
`compact` preference. M1-17 owns whether employees see that settings entry,
following SETTINGS-MAP. The Usage/Cache dock cells stay shaded independently.

The theme layer maps the existing AllRice secondary/tertiary text colors.
Dark colors come from native static palette tokens; other aliases, font
families, sizes, and the user's light/dark/system preference remain native.
Removing the plugin disposes its slot contributions and theme layer.

## Build and install

From the repository root:

```sh
pnpm --filter @allrice/dsh-web-composition build
pnpm --filter @allrice/dsh-web-composition pack --pack-destination /absolute/output
```

Create an independent `$DSH_HOME/profiles/allrice-web` directory and copy
`profiles/allrice-web/package.json` into it. Install the resulting local tarball
there with the profile's pinned pnpm 10.33.3:
`pnpm add /absolute/output/allrice-dsh-web-composition-0.1.0.tgz`.
The Host's same-generation DSH installation supplies the base and Web bundles.
Launch that installation with `dsh --profile allrice-web --no-open`; the
authentication/routing owner supplies its normal host arguments and identity.
This package never creates a HOME, copies credentials, chooses a port, selects
a session, or sends a model request.

## Public contract and ownership

Host exports `apply`; the browser artifact exposes Cordis `inject`/`apply`.
Public assets are `./cordis.patch.yml`, `./profile`, and `./package.json`.
There is no business service, MCP tool, database, event projection, admin route,
or new permission configuration. Profile removal follows native composition;
UI hiding does not revoke an API permission.

## Verification

`pnpm --filter @allrice/dsh-web-composition typecheck` and `lint` check the
package sources. `pnpm exec vitest run packages/dsh-web-composition/tests/composition.test.ts`
checks the public composition contract and disposal. The opt-in installed-profile
browser suite uses `ALLRICE_RUN_BROWSER_INTEGRATION=1`; its self-contained
histories are test data and are excluded from the packed product.

```sh
ALLRICE_RUN_BROWSER_INTEGRATION=1 pnpm exec vitest run packages/dsh-web-composition/tests/installed-profile.browser.test.ts --maxWorkers=1
```

The browser suite builds and installs a real tarball into a disposable profile,
uses native persistence to replay static histories, and checks native process
disclosure, draft retention, an answered question record, and a delivered
Markdown file's sidebar preview. It does not test question timing/admission,
editing or authenticated product routing. It closes its browser/Host and removes
its own temporary profile, including any native Web-generated token document.
It never reads or copies credential files and makes no model request.

The default Host comes from this package's locked DSH development dependency.
`ALLRICE_DSH_WEB_HOST_ANCHOR` may explicitly point to an already installed
same-generation Host's package.json; no local QA path is built in.
`ALLRICE_BROWSER_EXECUTABLE` can select an existing Chromium executable, as in
the repository's M5 runner. No browser is downloaded by this suite.
`ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR` optionally selects the evidence parent.
The sidebar suite otherwise uses a fresh directory under
`os.tmpdir()/allrice-composition-evidence`, prints its absolute location, and
retains it after browser/credential-root cleanup. It includes original failure
screenshots/JSON, source identities and replay pages; it contains no Host tokens.

`employee-sidebar.browser.test.ts` also compiles the actual 3.x `ChatSidebar`
and imported AllRice app/UI/contracts sources from fixed base
`d8f6ed3fa01bdd6e5d72e55702eb703e5e670d00` using `git show`. The baseline and
native side share `tests/fixtures/sidebar-data.mjs`, time, dimensions and themes.
It writes `legacy-base-entry.html`, hashed `legacy-base-sources.json`, and
1440/390 light/dark preview/expanded images. Current shared-Frame images are
supplementary container comparisons, never labeled pre-extraction baselines.
CI fetches only the exact base object if its shallow checkout lacks it and
uploads the suite's evidence through the existing integration collector.
Source-archive runners may instead set the test-only
`ALLRICE_SIDEBAR_BASELINE_ARTIFACT_DIR` to this generator's prepared HTML/source
manifest directory. The helper checks HTML/data hashes and all three pinned old
entry hashes before copying the artifact; source preparation still supplies its
recorded provenance. It fails on mismatch and never substitutes current UI.

A controlled owner mode wires real sidebar clicks through the exported
navigation class to actual isolated Cordis roots, native SessionReference
retain/release, and a cancellable ReadableStream. It checks same-key reuse,
employee/revision changes, late creation/UI and denied admission. This mode
does not call native openSession: a real Web Client/HTTP/WS/multi-Host mount is
still missing, and the evidence explicitly distinguishes those unbound parts.

## Known gap

The M1-14 entry is a **partial delivery**. Native drafts persist as
`dsh.conversation.${sessionId}` in the current origin's localStorage. Same-origin
roots with equal native IDs therefore share drafts; remountKey does not isolate
that storage. A real create owner still needs an authenticated, verifiable
storage-context/official namespace solution. A caller-supplied namespace string
is not sufficient. No new domain or authentication bypass is selected here.
Different-origin synthetic Host tests are not approval of production routing.

Native draft attachments belong to a retained Session input scope. Native
navigation releases the old main-view reference; with no other owner, the last
release disposes that scope and its attachments even within the same Host.
The browser coverage keeps the positive attachment assertion under an explicit
test-owned native reference and also checks loss after final release; it does
not supply the missing production owner or finish the attachment-retention
requirement. Reading anchors live in a ui-chat root-local Map. Same-root
restoration has browser coverage written;
cross-root attachment restoration has no public re-admission port. A legitimate
owner holding full `ChatViewSlotProps` can wrap its public `chatScroll` read/save
with trusted person/employee/profile/session/remount scope and canonical native
`ChatScrollPosition`; that thin UI adapter is publicly expressible but not yet
bound or tested here. No DOM sampling, copied ChatView or ledger mutation is
used. Absence of a standalone decorator does not prove this adaptation impossible.
Old upload
receipts are never copied across employee revision/binding changes. The new
browser suite records these boundaries but has not yet been run for this
candidate; it is not evidence of formal SSO or complete employee migration.

The build uses the fixed rc.2 Web shell's public module-table baseline for
`@deepseek-ai/dsh-client-ui-primitives` and `zod`, as native chat/conversation do.
It does not inline another Shiki/KaTeX/font copy. The client artifact is about
513 KB uncompressed (450 KB sidebar JS + 60 KB CSS, plus wrapper); build guards
reject accidental markdown/font inputs. The earlier 6.24 MB candidate duplicated
these shared modules. Startup/transfer impact remains unmeasured, and native
chatting/menus/theme regression still awaits the resource-approved browser run.
No private atom import, hash-named shell asset import, upstream patch or extra
asset route is used. A future shell must retain these baseline public modules.

The native ContextMeter has no independent slot or visibility configuration.
`conversation.input.activity` hides it only by entering an expanded activity,
which also hides the native + command/attachment control and other accessories.
This package keeps the meter and those interactions. An independent upstream
ContextMeter slot/config is required to finish hiding employee chat usage.
No private CSS, fake projection/activity state, or composer takeover is used.
