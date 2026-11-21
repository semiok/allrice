These synthetic histories use the released DSH v4 event format. `process.json`
and `subagent.json` retain the preparation proof's native event order, IDs,
timestamps, tool input/output and catalog relationship. Provider labels, system
text, request tool schemas and machine paths were replaced with inert fixture
values. No command or model is executed when these histories are replayed.

`question-document.json` records a completed native `ask_user_question` result
and a `present` delivery. It covers representative retained presentation, not
pending-question timing, answer admission, authentication or document editing.

The question follows the native standard preset's legacy ask-user tool. Its
request header has no timed schema (`parameters.properties.timeout`), so the
native question projection does not create a timed `settled` record. Open the
process, the question step, and the `提问` tool disclosure to read its answered
transcript inline. The separate `查看回答` panel action belongs to timed calls.

The test prepares these files through the public `SessionPersistence` handle
API. `__WORKSPACE__` is replaced with the test's fresh directory. All fixture
files and the browser inspection plugin are excluded from the product tarball.
