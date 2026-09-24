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
