# MET180 reference library

PR1 extends existing Knowledge sources/revisions with immutable content ownership and a retained file manifest. It reuses current content maintenance checks, storage/quota gates, text chunking and Knowledge indexing, and DSH document preview. It adds neither a second Knowledge store nor a model-driven parsing task.

## Authority and versions

- `ownership IS NULL` remains legacy workspace/ACL content. Legacy publishers, status setters, discovery and Run bindings exclude ownership-governed references until PR3 integrates current authority.
- Personal material is visible only to its owner; departments use current membership; company material is shared across company workspaces. Platform material is readable by active company users, and maintained only by current platform administrators in their actual control-plane workspace. Platform authority grants no access to another user's personal content.
- Each published reference revision fixes an immutable private file object, checksum, filename, source and creator. A later revision never mutates the earlier bytes, index or ownership. Source and file namespaces may differ when a company maintainer updates from another workspace; the revision records the exact retained object and index stays in the source namespace.
- Retained objects are excluded from generic file lists/readers, signed grants (including previously issued tokens), attachments, tool file readers/deletion and legacy broad workspace indexing. These exclusions apply while uploading and after archive as well.
- All reference metadata, preview and downloads recheck current identity and ownership; preview/download recheck after IO. Archived sources deny bytes and remain visible only to maintainers for restoration.

## Processing and write reconciliation

Upload request IDs are reconciled before another quota allocation; changed content with the same ID fails. Source mutations reconcile request IDs and compare expected revision. The UI retains an uncertain upload/action request for retry. An unfinished byte upload is displayed separately from a saved file.

The existing Worker automation producer claims one durable processing record with a bounded lease. Plain UTF-8 text/Markdown/JSON up to the existing 2 MB indexing limit reuse the native reader/chunker, with exact byte checksum validation. Other formats remain retained, previewable/downloadable and explicitly unindexed. Empty or corrupt content fails without marking ready. Index and ready status commit together; expired attempts can be reclaimed, stale completions cannot overwrite a newer lease, and archive prevents completion. Failure retry preserves the same revision and file.

## Delivery slices

1. Upload/processing/preview/download, versions and current four-scope authority (this PR).
2. Save an exact delivered artifact version directly as a retained reference.
3. Explicit chat references, employee/scenario bindings and actual model retrieval, separating storage namespace from consumer context.
4. Migrate old company templates with exact version provenance before removing their old entry.

PR1's processing status proves only stored/indexed files. It does not claim the PR3 chat/Run consumption contract is delivered. Ordinary chat attachments are never automatically published as references.

## Regression

`reference-library.integration.test.ts` covers current authority, cross-workspace identity, immutability, request replay, legacy route denial and lease races. `reference-library.browser.test.ts` runs actual drawer → HTTP → isolated PostgreSQL/files → Worker → native preview/download, including two versions, processing recovery, readonly platform material, mobile display and revocation during preview. No model is required for these deterministic checks.
