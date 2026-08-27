# DSH WebUI upstream layer

These styles are pinned from `deepseek-ai/deepseek-harness` release
`0.1.1-rc.2`, commit
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.

AllRice reuses the upstream presentation contracts and design tokens while its
SaaS adapter keeps authentication, tenant isolation, employee policy, model
routing and ChatFlow persistence under AllRice control.

Do not edit copied upstream files directly. Product deltas belong in
`dsh-saas.module.css` or the React adapter. The source ledger lives in
`apps/web/app/dsh-upstream/upstream.json`. Updating DSH requires replacing the
pinned files, reviewing the upstream diff, and rerunning the WebUI and MET-62
acceptance suites.
