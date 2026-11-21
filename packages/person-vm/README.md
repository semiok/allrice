# Person VM public contract slice

This worktree carries the public contracts from MET-266 PR #905 at
`8115ae6124126eb66a4bdd9fd995ce6549bc7140`, with the original package metadata,
TypeScript configuration and architecture documents. The entry consumer uses
only the three contract exports. Source blobs are recorded in the MET-271 QA
directory's `F4-CARRIER-PROVENANCE.json`.

This slice contains no VM service, admission host, SQL store, provider or
migration. Production composition must inject the real host from the batch
combination with #905. Importing these contracts does not make a producer,
transport, execution resolver or physical owner fence available.
