# Person VM public contract slice

This worktree carries the public contracts from MET-266 PR #905 at
`c041d94c6984463c9ff9a068cba0db58ebc91e16`, with the original package metadata,
TypeScript configuration and architecture documents. The entry consumer uses
only the three contract exports. `admission-contract.ts` has an explicit
format-only derivative; source/derived blobs and its diff are recorded in the
MET-271 QA directory's `F4-C041-CARRIER-PROVENANCE.json`. The original 8115
provenance and format first failure are retained there.

This slice contains no VM service, admission host, SQL store, provider or
migration. Production composition must inject the real host from the batch
combination with #905. Importing these contracts does not make a producer,
transport, execution resolver or physical owner fence available.

The model-owner handoff reports the c041 intermediate producer independently
reviewed and PostgreSQL-tested, including sticky callback rejection. Those are
owner-line results, not execution evidence for this slice. This worktree still
has no real host composition or complete business owner/transport binding.
