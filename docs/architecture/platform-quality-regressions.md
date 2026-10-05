# Versioned platform regression evidence

MET167 PR2c1 maps fixed scenarios to existing Vitest entrypoints. The registry is
not a receipt, a second task engine, or permission to run a shell from a browser.
It does not change published employee versions or borrow a company/Bridge login.

The first slice adds a production two-turn fixture: real ordinary-member
database permissions, `sendChatMessage`, queue, Worker, Tool Broker, formal
publication, v1/v2 immutable files, authenticated file handlers and different
owner/company denials. The model adapter and identity transport are controlled
test ports. The Office gate additionally executes the original cloud-native
XLSX workflow, revises its actual source bytes, checks the upstream receipt and
downloads both immutable revisions. The existing native suite covers its fixed
DOCX/XLSX/PPTX features, concurrency and corrupt output.

## Execution and recording

Capture the source **before** executing the mapped tests. Keep reports outside
tracked source. Collect only after the original runner exits; do not regenerate
a passing report or attach an older report to a new SHA.

```sh
pnpm exec tsx scripts/acceptance/platform/quality-scenarios.ts capture \
  --group=native --output=.local/quality/native/capture.json
pnpm test --maxWorkers=2 --reporter=default --reporter=json \
  --outputFile=.local/quality/native/vitest-native.json
pnpm exec tsx scripts/acceptance/platform/quality-scenarios.ts collect \
  --capture=.local/quality/native/capture.json \
  --report=.local/quality/native/vitest-native.json \
  --exit-code=0 --output=.local/quality/native/summary.json
```

Use the **actual** exit code, including a nonzero code, in the last command. The
collector never runs tests. It requires the same Git SHA and complete source
material digest, the same registry and reports starting after the capture.
The original JSON remains separate; the summary carries its checksum, test
names, executed/skipped counts, declared inputs/assertions and reproduction
arguments. Raw error values are hashed rather than copied into the summary.

The existing developer-bootstrap CI steps write four original PostgreSQL JSON
reports. `collect --reports-dir=...` combines their `vitest-*.json` files without
executing the tests again. The new two-turn fixture and the existing publication
concurrency suite join the current platform-quality step. CI uploads both
originals and summaries even on failure; these artifacts contain isolated
fixture data and must not contain provider credentials or real company files.

PostgreSQL fixtures accept only the existing dedicated local `allrice_b2`
database or the pinned CI database. They reject an ambient `DATABASE_URL` and
remove their owned schemas, storage and pools. The text case does not use a
model, Office VM, connected app or native desktop. Different account assertions
must use persisted active ordinary memberships, not a fabricated actor ID.

## Separate physical Office gate

The `office` group is not claimed by Linux CI. Before selecting it, check the
existing managed cloud VM, watchdog, pinned Office image and isolated fixture
database. It needs neither an unlocked desktop nor the user's paired Bridge.

```sh
pnpm exec tsx scripts/acceptance/platform/quality-scenarios.ts capture \
  --group=office --output=.local/quality/office/capture.json
ALLRICE_RUN_DB_INTEGRATION=1 ALLRICE_RUN_OFFICE_INTEGRATION=1 \
ALLRICE_TEST_DATABASE_URL=postgres://a123@127.0.0.1:5432/allrice_b2 \
pnpm exec vitest run --maxWorkers=1 \
  tests/integration/platform-quality-conversation.integration.test.ts \
  apps/worker/src/office/native.integration.test.ts \
  --reporter=default --reporter=json \
  --outputFile=.local/quality/office/vitest-office.json
```

Collect it with the same command above and `--group=office`'s capture. Exact
assertion tags separate the physical XLSX check from the text case in their
shared file. A skipped physical assertion, a missing suite, zero matching
assertions, a failed suite or a crashed runner never provides passing coverage.

## Interpretation and remaining scope

- `passed` means all mapped assertions actually passed. `partially_verified`
  retains skipped assertions and is not full coverage.
- `unknown`, `skipped`, `assertion_failed` and `execution_failed` remain distinct;
  exit zero alone is not acceptance. Environment/cancellation causes require
  separately verified preflight or execution evidence and are not inferred
  from arbitrary runner failures.
- Source and declared dependency pins identify what was checked; null actual
  Bridge/image observations are unknown, never implicit verification. Tests
  do not establish real-model quality or arbitrary-project compatibility.
- These regression artifacts are not `project.static.v1`/`project.live.v1`
  reports. They are not generated Runs or company deliverables and do not mark
  a live Dev deployment accepted.
- PR2c2 still owes the eight-case matrix over the same persisted delivery facts
  across Worker, chat, dashboard/deliverables and next-step suggestions, including
  the publication cancellation/reconnection window and actual frontend read.
  The version-aware evidence page also remains in that slice. PR2 and MET167
  remain open until those requirements and the remaining PRs are delivered.
- MET164/166 local-device matrices, formula/rendering checks and performance
  evidence remain separately tracked. A fixed text/XLSX or Vite check does not
  prove all formats, local execution, formulas, layouts or projects.
