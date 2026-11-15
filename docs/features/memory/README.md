# Personal Memory V2

Current personal memory uses confirmed summaries, complete details by number, and owner-confirmed candidates. MET-223 A2 removes the old experience lifecycle, automatic personal hash/vector recall, search/source tools and full-content API/editor paths. Implementation, gate, merge, deployment and acceptance status are recorded separately in the delivery evidence.

## Current behavior

- Ordinary human roots and their current Workflow/Skill share the same authorized memory index, read/remember tools, accounting and confirmation interface. A loaded package grants no permission.
- The initial index lists every eligible confirmed summary for the current owner/workspace/employee instance, up to 100 active records. Entries with details must be read completely through `workspace.memory.read({number})` before the model applies them.
- A numbered read uses the Run's frozen revision/pairDigest, rechecks current identity and source authority, and returns a complete entry. One read is at most 10000 bytes; the existing Run ledger allows 24000 bytes including the initial index and 12 reads. Repeated reads consume budget again; bytes are not tokens.
- `workspace.memory.remember` accepts summary (1–40 Unicode code points), optional details (up to 2000) and one of four existing memory classes. It always creates a pending candidate; it cannot choose durable status or an expiry.
- Only actual human messages and adopted human steering supply current candidate facts. Assistant inferences, brand creative work, retrospective output, documents and tool/connector results are not personal facts or consent.
- Owner confirmation or an owner-saved edit makes the pair active. The exact revision/pairDigest and current owner/workspace/instance/source gates remain in force. Approving an article or Workflow does not confirm memory, and administrators cannot confirm on the owner's behalf.
- Scheduled, manual automation, folder-event and system tasks have empty MEMORY and no personal memory tools. Child agents receive no new personal-memory authority.

## Storage and controls

PostgreSQL remains the authority in `allrice_memories`, `allrice_memory_revisions` and the existing operation ledger. Summary/details, revisions, CAS and idempotency remain atomic. Shared content columns are retained for current company-material consumers; they are not exposed as a second personal-memory contract. Enterprise knowledge retrieval is separate and retained.

The current memory entry opens `employee-memory-manager`; administrators use the independently audited read-only `EmployeeMemoryView`. Chat candidate receipts come from current API reads and remain limited to the Run's original human message and adopted steering, rather than all pending records for the employee. Completion events only trigger reads. Cards with details show the complete current pair before enabling confirmation; a stale revision or digest cannot approve unseen content.

Owners can confirm, edit, discard or delete through the V2 interface. Deletion archives that identity and invalidates its old receipt; a separate lawful new proposal remains pending and needs its own confirmation. No text matcher, deletion cutoff or implicit migration recreates deleted data.

A1 source collection uses its separate storage and default-off organization policy. Captured material is not an ordinary pending memory, a user fact or company-material authority. The retired experience-consolidation Skill, review/validation/adoption pipeline and brand-experience branch have no current execution entrypoint; brand articles, publication, feedback and retrospectives remain.

## Current references and checks

[Candidate/source contract](../../runbooks/employee-memory-candidates-v2.md),
[owner and administrator management](../../runbooks/employee-memory-management-v2.md),
[index and numbered reads](../../architecture/allrice-2.0/met246-memory-index-v2.md),
and [forward recovery](../../runbooks/employee-memory-pairs-recovery.md) describe the current boundaries.

Current regressions cover owner/tenant/instance isolation, complete detail visibility before confirmation, exact pair CAS, uncertain receipts, Run source filtering, administrator read-only access, ordinary task isolation, frozen historical revisions and budget accounting. Retired experience/V1-only tests are removed; their necessary safety assertions remain at the current endpoints. A source statement does not mean those gates have run or passed for this revision.
