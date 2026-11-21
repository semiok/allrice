These synthetic histories use the released DSH v4 event format. `process.json`
and `subagent.json` retain the preparation proof's native event order, IDs,
timestamps, tool input/output and catalog relationship. Provider labels, system
text, request tool schemas and machine paths were replaced with inert fixture
values. No command or model is executed when these histories are replayed.

`question-document.json` records a completed native `ask_user_question` result
and a `present` delivery. It covers representative retained presentation, not
pending-question timing, answer admission, authentication or document editing.

The test prepares these files through the public `SessionPersistence` handle
API. `__WORKSPACE__` is replaced with the test's fresh directory. All fixture
files and the browser inspection plugin are excluded from the product tarball.
