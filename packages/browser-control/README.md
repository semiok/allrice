# Shared browser renderer

Pure page I/O for a newly created, owned Playwright context. This package does not attach to browsers, read profiles/credentials, resolve DNS, launch processes, or grant permissions. Cloud and Bridge adapters own those boundaries.

`createControlledBrowserRenderer(context, browser, options, closeProxy)` requires trusted `authorizeUrl`, `assertCurrent`, `requestStarted`, `requestApproval`, and `requestSent` callbacks. They must never come from model/UI arguments. The caller supplies a newly isolated profile, a target-specific pinned transport and a current fenced operation owner. The cloud adapter only authorizes its exact public HTTPS origins; a Bridge adapter must independently validate local target grants.

`requestStarted` reserves ownership synchronously before asynchronous authorization; the returned release callback settles that reservation. `requestApproval` must durably approve the exact intercepted method, URL digest and body digest; its completion callback distinguishes confirmed HTTP transport completion from an unknown outcome. Neither means business success. Pending control transfer must wait for owned native I/O, asynchronous request checks and outstanding effects to settle.

Observations expire, bind profile/fence and verify DOM consistency. Sensitive input references are resolved by the host into short-lived buffers; renderer masks fields, redacts transient values from observations and wipes supplied buffers. It never receives the secret store/key. Caller must destroy Run-limited profiles at actual shutdown and must not replay unknown inputs after restart.
