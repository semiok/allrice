# Third-party notices

## Cline Web Diff adapter

Copyright 2026 Cline Bot Inc. Licensed under Apache-2.0; a full copy is included
in the repository [LICENSE](LICENSE).

`apps/web/app/chatflow/cline-adapter/tool-file-diff.tsx` is adapted from
`sdk/packages/ui/components/agent-chat/tool-diff.tsx` at
[cline/cline commit dac3b35ba485dbab3b5a73aca239b0d07ce071cf](https://github.com/cline/cline/blob/dac3b35ba485dbab3b5a73aca239b0d07ce071cf/sdk/packages/ui/components/agent-chat/tool-diff.tsx).
The pinned source tree has no applicable separate NOTICE or subdirectory license.
The adapter retains parsing/memoization, theme integration and bounded render
recovery, but changes exact EOF preservation, deletion support, resource bounds,
fallbacks, layout and version-aware line selection. AllRice authorization,
versioned feedback, filesystem operations and rollback are independent code.
No Cline Agent Loop, VS Code host, theme assets, editor or approval engine is copied.

The runtime dependency `@pierre/diffs` is pinned to 1.4.1 (Apache-2.0),
Copyright 2025 Pierre Computer Company. Its full license is distributed with the
package as `LICENSE.md`; transitive dependencies retain their own package licenses.
The chosen version is within Cline's `^1.3.0` peer range. Candidate 1.3.0 failed
strict peer validation (`@pierre/theming@1.0.0` vs `@pierre/theme@2.0.0`);
1.4.1 uses theming 1.0.1 with the corrected range. Global peer checks remain on.

Adaptation evidence and limitations: `docs/architecture/allrice-2.0/p07-workbench.md`.

## DeepSeek Harness

AllRice optionally integrates packages from
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness),
licensed under the MIT License. The approved source version, commit and archive
checksum are recorded in `apps/worker/dsh/upstream.json`.

AllRice product identity, multi-tenant authorization and data services are
independent works. The ChatFlow Web surface includes source-derived design
tokens and component styles from the following DeepSeek Harness WebUI paths at
commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`:

- `packages/client/ui-theme/src/styles/*`
- `packages/client/ui-layout/src/client/AppFrame.module.css`
- `packages/client/ui-layout/src/client/AppFrame.tsx` (drag handle and frame
  measurement adapted in `apps/web/app/chatflow/workbench-splitter.tsx`)
- `packages/client/ui-sidebar/src/client/SidebarRoot.module.css`
- `packages/client/ui-conversation/src/client/**`
- `packages/client/ui-primitives/src/icons/index.tsx` (six queue glyphs and Think glyph)
- `packages/client/ui-primitives/src/DisclosureRow.tsx` and `DisclosureRow.module.css`

`queued-messages-dock.tsx` adapts the native `QueueDock.tsx`; its CSS is copied
unchanged and the icon glyphs are verbatim excerpts. The adapter connects the
native list/actions to AllRice durable inputs and returns edits to the composer.

`work-process.tsx` uses the native `DisclosureRow` primitive (imports and string
class joining adapted) and unchanged `ReasoningRow.module.css`. AllRice adds
Chinese grouping over public tool events and server timing; it does not expose
raw model reasoning or create a second execution timeline.

The copied files live under `apps/web/app/dsh-upstream` and
`apps/web/app/chatflow/dsh-upstream`. AllRice supplies a SaaS adapter over those
presentation contracts; it does not expose DSH's local single-user connection
or permission model directly to tenants.

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## DSH employee workspace UI (MET-160)

DSH `0.1.7-rc.1`, commit `46a7f68b0922371ce7144b668b90e377d8e799f4`,
https://github.com/deepseek-ai/deepseek-harness, MIT.
Native workspace Rows/tree/locales and the collapsedSessionRows excerpt are
preserved under `apps/web/app/chatflow/dsh-upstream/workspace/`. Source hashes
and minimal host-projection/employee/accessibility patches are recorded in
`apps/web/app/dsh-upstream/upstream.json` and `scripts/dsh-ui-patches/`.
The official ui-primitives package and its runtime dependencies are consumed
through their published package exports. The repository's existing DSH MIT
notice applies to these additional upstream sources.

MET-160 native Dock integration directly depends on the MIT-licensed
`@deepseek-ai/dsh-client-ui-dockkit@0.1.7-rc.1` package. The native
`ui-sidebar-right` stores, persistence, seed contract, and original SidebarRight
slide stylesheet are retained under
`apps/web/app/chatflow/dsh-upstream/dock/`, from the same upstream commit
`46a7f68b0922371ce7144b668b90e377d8e799f4`. Local patches and checksums are
recorded in the existing WebUI upstream ledger. The DeepSeek MIT notice above
applies to those source files.

MET-160 files/document integration retains ui-sidebar-files and documentpreview
zoom/PDF store sources from the same `0.1.7-rc.1` commit, with the MIT notice
above and exact source/patch hashes in the WebUI ledger. PDF rendering loads the
unaltered published `ui-sidebar-documentpreview/lib/client.pdf.js` chunk lazily;
its bundled PDF.js/font license notices remain included. CodeBlock is consumed
through the official ui-primitives package. Existing Allrice Office conversion
and Markdown rendering remain the content adapters.

MET-160 settings integration consumes the published ui-primitives Modal and
icons. The ui-settings-general SettingsRoot panel/navigation and stylesheet
from the same 0.1.7-rc.1 commit are adapted under
`apps/web/app/chatflow/dsh-upstream/settings/`; source and patch checksums are
recorded in the WebUI ledger. The DeepSeek MIT notice above also applies.

The conversation turn navigator retains the official `ui-chat/TurnNavigator`
component, its unmodified stylesheet and bounded preview helper from commit
`46a7f68b0922371ce7144b668b90e377d8e799f4` (0.1.7-rc.1). Only host type imports and a scoped official theme binding
are patched; the source, excerpt and patch hashes are recorded in the WebUI
ledger. The DeepSeek MIT notice above applies. It uses the upstream-pinned
MIT-licensed `@tanstack/react-virtual@3.14.9` package.

Message footer and feedback UI retain the official `ui-chat/MessageIconActions`,
calendar/clock helpers and `ui-message-feedback` components, controllers, locales
and original CSS from the same `46a7f68b0922371ce7144b668b90e377d8e799f4` commit.
The MIT notice above applies. The WebUI ledger records source hashes and minimal
host type/React lifecycle patches. Allrice supplies tenant HTTP persistence and
the platform feedback inbox; no DSH branch action is exposed.
