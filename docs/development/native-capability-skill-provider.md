# AllRice capability Skill sources in the native registry

`registerNativeCapabilitySkillProvider(ctx, host)` connects the concrete
`BuiltinSkillSourcesPort` and `createPostgresPersonalSkillPackageSource` to
`@deepseek-ai/dsh-skill` **0.2.1-rc.2**, using package-root public imports.
It registers a real native `SkillProvider`, rather than a second registry,
loader, MCP tool, execution engine or Run snapshot.

Call it synchronously from the trusted target's Cordis context with the
`skills` service declared as a required dependency. Installing `SkillRegistry`
alone does not authorize an ordinary plugin context to access `ctx.skills`.
Use the public Cordis injection entrypoint, which also owns unload/reload when
the required service changes:

```ts
await ctx.plugin(SkillRegistry);
const fiber = ctx.inject(['skills'], (target) => {
  registration = registerNativeCapabilitySkillProvider(target, host);
});
await fiber;
```

The context must belong to that employee's Host/scope, never a global context
shared with unrelated employees. The caller retains source/SQL ownership. This
module installs no production bootstrap.

The host supplies both required, cancellation-aware closures:

- `requireCurrent(signal)`, bound to the same trusted RC/target/workspace as the
  concrete personal source; the reviewed MET273 current contract is
  `caae6cc54edf9f5eed90ae7adf67e77c6369683a`.
- `readConfiguration(signal)`, returning an explicit `builtinSkills` array of
  existing exact `BuiltinSkillSourceSelector`s and a `personalSkills` boolean.
  This is the trusted owner's effective permission/config projection, including
  required tool availability, rather than a guest request or repository flag.

Missing producers do not get defaults. Production current/config and Host
mount remain **unbound**. Contract substitutes test the real consumer and native
registry without claiming production authority, model execution or acceptance.
The static source's `sourceEnabled` flag alone never enables it for an employee.
Its original model/user invocation flags now pass through the source unchanged.

`list` reads only selected static packages and enabled personal pins/bodies,
then checks current/config again. `get` loads the selected exact package again
and checks current/config both before and after IO, including a native cache
hit. Personal SQL, nullable manifests, body/definition hashes, scope and epoch
checks remain in the existing concrete source. Ordinary version pointer changes
leave authorized old pins readable; invalidation discovers the new pointer.
These observations are not an atomic globally fresh snapshot or transferable
permission grant. No old 3.x Run/history snapshot or installation is rewritten.

DSH owns caching, candidate selection, invocation-neutral summaries and
invalidation. Both package classes use native `BUNDLED_SKILL_RANK`; native
same-rank ordering resolves duplicates (selected static entries precede personal
bindings). Existing installation name-conflict rules are unchanged. Consumers
still apply native model/user invocation policy at their own boundary.
The host must call the returned `invalidate()` on configuration/current/binding
changes. A cached list can remain visible until that notification; `get` still
checks current access. Native provider discovery failure produces an incomplete
snapshot and a warning; an empty/incomplete native list is not proof of access.

Every asynchronous source/current/config promise is actually awaited. Caller
and native registration cancellation are combined and forwarded to the existing
sources; no custom timeout, retry or background worker is added. Native `get`
and discovery deliberately race caller cancellation, so their rejection alone
does **not** prove source IO cleanup. The exact Cordis composite effect disposer
first unregisters/aborts the native provider, then joins all in-flight provider
promises. Await the returned `dispose()` before releasing sources. Actual plugin
fiber disposal uses that same effect and also joins; Cordis retains its own
cleanup-error logging semantics. Failures that settle after caller cancellation
are retained by identity until owner disposal, even if their IO already left
the pending set. Each actual operation records once; disposal joins pending IO,
deduplicates the retained/joined failures, clears those references and preserves
original failures and distinct cancellation reasons. Successful operations,
pure caller cancellation and ordinary delivered failures are not accumulated.

Only instruction bodies are exposed. The native `opaque` resource base says
relative resource bytes are unavailable through this provider. No directory,
URL, archive byte reader or fictitious Run/B is supplied. Static resource bytes
remain reachable through the existing authorized source operation; personal
manifests remain descriptors only. Resource-dependent Skills (including office)
are not claimed fully installed/usable by this body-only integration. The source
checker, charts, licenses, all 14 bodies and 17 resources remain unchanged.

The complete unit suite uses real Cordis/SkillRegistry and filesystem sources,
with personal IO/current/config substitutes for controlled cancellation and
failures. The complete integration suite uses the existing isolated PostgreSQL
fixture/migrations, real personal three-table reads and filesystem sources,
and real native registration/list/get/disposal. Current/config alone remain
contract substitutes. Its DB environment guard follows existing CI
`apps/worker/test/` resource rules. No model, network, VM, production mount or
additional product connection is required.
