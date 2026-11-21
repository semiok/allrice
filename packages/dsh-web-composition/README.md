# AllRice employee Web composition

This DSH `0.2.1-rc.2` package supplies the M1-13 employee presentation and an
independent `allrice-web` profile. It does not switch the active 3.x entry.
M1-12 owns installation into the authenticated host, routing, and rollout.

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
`ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR` optionally retains rendered failure
screenshots/text in a fresh attempt directory.

## Known gap

The native ContextMeter has no independent slot or visibility configuration.
`conversation.input.activity` hides it only by entering an expanded activity,
which also hides the native + command/attachment control and other accessories.
This package keeps the meter and those interactions. An independent upstream
ContextMeter slot/config is required to finish hiding employee chat usage.
No private CSS, fake projection/activity state, or composer takeover is used.
