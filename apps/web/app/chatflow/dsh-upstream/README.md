# DSH WebUI upstream layer

These styles are pinned from `deepseek-ai/deepseek-harness` release
`0.1.1-rc.2`, commit
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.

AllRice reuses the upstream presentation contracts and design tokens while its
SaaS adapter keeps authentication, tenant isolation, employee policy, model
routing and ChatFlow persistence under AllRice control.

## Product UI authority

The official DSH WebUI is the normative interaction and presentation baseline
for AllRice chat. New chat work starts from the upstream behavior rather than a
separate AllRice convention. In particular, preserve:

- native event order and the compact Context / Search / Think / Tool / Answer
  projection;
- composer keyboard, IME, focus and scrolling behavior;
- Markdown, links, code, lists and table rendering;
- streaming continuity without replacing a running turn with a different
  settled layout; and
- the upstream spacing, typography, color tokens and accessibility states.

AllRice may add SaaS-only surfaces such as tenant identity, employee policy,
model governance, attachments and context pressure. Those additions must not
weaken the DSH chat behavior. A deliberate difference belongs in the SaaS
adapter and must be covered by a parity test or acceptance check.

Do not edit copied upstream files directly. Product deltas belong in
`dsh-saas.module.css` or the React adapter. The source ledger lives in
`apps/web/app/dsh-upstream/upstream.json`. Updating DSH requires replacing the
pinned files, reviewing the upstream diff, and rerunning the WebUI and MET-62
acceptance suites.
