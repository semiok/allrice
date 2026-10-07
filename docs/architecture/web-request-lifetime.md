# Web request completion and browser disconnects

The custom Web server waits for both the returned Next handler and the actual
response lifetime. A response close does not end a database-writing handler or
its continuation. Requests disconnected during durable admission are not
dispatched; already-terminal responses are reconciled before awaiting events.

Next 16.2.1 has two reproduced native cancellation gaps: `serveStatic` waits only
for response finish after `send` has closed its filesystem stream, and the
streaming writer can wait for a new drain or final finish after response close.
`patches/next@16.2.1.patch`, pinned by pnpm's lockfile hash, corrects both CommonJS
and ESM distributions. It uses the existing Next/send transport and joins the
real file stream's close and native readable cancellation. A `waitUntil`
continuation still has to return. Generic productive handlers are never raced
against response close and no historical permit is completed by timeout.

The regression suite loads the installed Next implementation and exercises
actual HTTP aborts, native file-descriptor closure, successful GET/HEAD/304,
missing-file/directory errors and held write continuations. The patch is separate
from the five DSH runtime patches. Retire it only when a pinned upstream version
passes these same cancellation and successful-response cases without it.

This fixes reproduced failure paths; the exact URL and handler of previously
stranded permits are unknown. Their outcome remains unknown. It does not enable
automatic repair, release admission, producer ACK or supervisor recovery.
