# MET-142: native assistant report delivery

The governed adapter previously persisted `assistant_report` and concluded the
child turn, but forwarded the native settlement notice unchanged. The pinned
native output selector chooses the child's final assistant message (often the
report tool call), not the following tool result. The provider's user-message
conversion does not render a tool-call block. Consequently a parent could adopt
the settlement notice without receiving the persisted structured report.

The existing settlement hook now preserves native message identity, source and
scheduling while rendering only the currently authorized platform result:
delivery ID, status, summary, immutable evidence references, incomplete items
and usage completeness. Report text remains untrusted data. Existing report
field limits apply without truncating JSON. No extra Agent loop, model call,
prompt workaround or direct database write is introduced.

Repeated native notices are deduplicated by the bound child/durable delivery.
Wrong parent/source/delivery cannot be adopted; adoption requires the exact
native message actually sent with that report. The child tool result alone no
longer pre-populates parent-delivery state.

The no-model regression invokes the pinned native notification and output-fold
code and captures the original parent method. Before the fix its visible text
contained only the native finished/closing-message header, not the durable
report sentinel. After the fix, 26 delivery cases and the existing native
admission, usage, pricing, subscription and outcome unit tests passed: 89 tests
across 7 files. Prettier, ESLint and diff checks passed. The tests include two
children, exact adoption, duplicate notices, revoked authority, malformed and
maximum-size reports, and exclusion of synthetic nonpublic closing content.

This is a deterministic delivery fix, not evidence that a real provider's final
answer has already been retested. Existing real-run failures remain failures;
candidate-specific live acceptance and the external release gate remain separate.
