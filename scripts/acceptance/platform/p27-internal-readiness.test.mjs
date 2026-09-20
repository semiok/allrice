// Synthetic parser fixtures only. No product execution, API call, subscription
// invocation, release authorization, or actual acceptance evidence is produced.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test, vi } from 'vitest';
import {
  ARTIFACT_IDS,
  ASSISTANT_BILLING_ASSERTIONS,
  BASELINE_SHA,
  CASE_ASSERTIONS,
  FLAGS,
  PRESERVED_STATE,
  REQUIRED_CASES,
  validateRelease,
} from './p28-release-readiness.mjs';
import {
  INTERNAL_MATRIX,
  main,
  validateInternalReadiness,
} from './p27-internal-readiness.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE = 'a'.repeat(40);
const NOW = Date.parse('2026-09-14T12:00:00.000Z');
const CREATED = '2026-09-14T11:00:00.000Z';
const ASSISTANTS = 'assistants-real-dsh-two-children-no-bridge';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const temporary = [];
const irreversible = [
  'releaseEligible',
  'formalReadiness',
  'signedDistributionReady',
  'authorizationGranted',
  'deploymentExecuted',
  'migrationExecuted',
  'flagsChanged',
  'gaDeclared',
];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function expectedRow(caseId) {
  const name = caseId.startsWith('client/') ? caseId.split('/')[2] : caseId;
  const signature = name === 'developer-id-signature-notarization';
  const update = name === 'authenticated-update-metadata';
  return {
    caseId,
    internalAssertions: signature
      ? []
      : update
        ? ['replay-downgrade-rejected']
        : [...CASE_ASSERTIONS[name]],
    externalAssertions: signature
      ? [...CASE_ASSERTIONS[name], 'publisher-team-id', 'publisher-bundle-id']
      : update
        ? [
            'publisher-authenticated',
            'metadata-signature-valid',
            'update-key-sha256',
          ]
        : [],
    methods:
      update || name === 'invalid-signature-and-package-rejection'
        ? ['real-end-to-end', 'physical-component']
        : ['real-end-to-end'],
  };
}

const expectedMatrix = REQUIRED_CASES.map(expectedRow);
const internalCases = expectedMatrix
  .filter((row) => row.internalAssertions.length)
  .map((row) => row.caseId);

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'allrice-p27-internal-test-'));
  temporary.push(base);
  const root = realpathSync(base);
  function write(path, bytes) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
    return { path, sha256: hash(bytes), bytes: Buffer.byteLength(bytes) };
  }
  // This is the ORIGINAL P28 preparation contract, not a relaxed replacement.
  const preparation = {
    schema: 'allrice-p28-release/v1',
    releaseId: 'SYNTHETIC-PREPARATION-NOT-A-RELEASE',
    sourceSha: SOURCE,
    baselineSha: BASELINE_SHA,
    createdAt: CREATED,
    artifacts: ARTIFACT_IDS.map((id) => ({
      id,
      sourceSha: SOURCE,
      version: 'synthetic-fixture',
      buildId: `synthetic-${id}`,
      file: write(
        `artifacts/${id}.txt`,
        id === 'lockfile'
          ? readFileSync(join(sourceRoot, 'pnpm-lock.yaml'))
          : id === 'dsh-upstream'
            ? readFileSync(join(sourceRoot, 'apps/worker/dsh/upstream.json'))
            : `SYNTHETIC PARSER FIXTURE, NEVER PRODUCT EVIDENCE: ${id}`,
      ),
    })),
    flags: Object.fromEntries(FLAGS.map((name) => [name, false])),
    signedClientRequired: true,
    clientPublisher: { teamId: null, bundleId: null, updateKeySha256: null },
    migrations: {
      changes: readdirSync(join(sourceRoot, 'packages/database/migrations'))
        .filter(
          (name) => name.endsWith('.sql') && Number(name.slice(0, 4)) > 92,
        )
        .sort()
        .map((name) => ({
          name,
          sha256: hash(
            readFileSync(
              join(sourceRoot, 'packages/database/migrations', name),
            ),
          ),
          phase: 'expand',
        })),
      contractDeferred: true,
      backfillPolicy: 'idempotent-bounded-resumable-separate-approval',
    },
    rollback: {
      mode: 'forward-fix-only',
      reason: 'Synthetic fixture: no compatible old reader asserted.',
      targetSourceSha: null,
      targetReleaseId: null,
      targetArtifacts: [],
      database: 'no-down-migration',
      credentials: 'current-or-newer-reader-no-repair',
      drain: 'reconcile-unknown-never-blind-replay',
      preserve: [...PRESERVED_STATE],
      backup: 'separate-authorization-required-not-taken-by-validator',
    },
    evidence: [],
    blockers: [],
    unsupported: [],
    authorizations: { dev: null, tenant: null, prod: null },
  };
  const manifest = {
    schema: 'allrice-p27-internal-readiness/v1',
    acceptanceId: 'SYNTHETIC-INTERNAL-INVENTORY-NOT-ACCEPTANCE',
    sourceSha: SOURCE,
    createdAt: CREATED,
    preparation: write('preparation.json', JSON.stringify(preparation)),
    evidence: [],
    blockers: [],
  };
  function receipt(caseId) {
    const client = caseId.startsWith('client/');
    const arch = caseId.split('/')[1];
    const names = [...expectedRow(caseId).internalAssertions];
    if (caseId === ASSISTANTS)
      names.push(...ASSISTANT_BILLING_ASSERTIONS.token_metered);
    return {
      schema: 'allrice-p27-internal-evidence/v1',
      caseId,
      sourceSha: SOURCE,
      status: 'passed',
      execution: 'real-execution',
      method: 'real-end-to-end',
      billing: caseId === ASSISTANTS ? { mode: 'token_metered' } : null,
      observedAt: CREATED,
      environment: client
        ? 'physical-macos'
        : caseId.startsWith('dev-')
          ? 'dev'
          : 'isolated',
      tenantId: 'synthetic-only-tenant',
      runId: `synthetic-only-${caseId}`,
      command: 'SYNTHETIC SCHEMA INPUT: NO PRODUCT COMMAND EXECUTED',
      artifacts: Object.fromEntries(
        preparation.artifacts
          .filter((a) => !client || ['source', `bridge-${arch}`].includes(a.id))
          .map((a) => [a.id, a.file.sha256]),
      ),
      flagSnapshot: Object.fromEntries(
        FLAGS.map((name) => [
          name,
          name === 'ALLRICE_ASSISTANTS_ENABLED' &&
            caseId.startsWith('assistants-'),
        ]),
      ),
      assertions: names.map((name) => ({
        name,
        expected: true,
        observed: true,
      })),
      attachments: [
        write(
          `observations/${caseId}.txt`,
          'Synthetic parser input only; no real product execution.',
        ),
      ],
      device: client
        ? {
            id: `synthetic-device-${arch}`,
            architecture: arch,
            osVersion: 'synthetic-os',
            physical: true,
          }
        : null,
    };
  }
  function putReceipt(value) {
    const entry = {
      caseId: value.caseId,
      file: write(`receipts/${value.caseId}.json`, JSON.stringify(value)),
    };
    const i = manifest.evidence.findIndex(
      (item) => item.caseId === value.caseId,
    );
    if (i < 0) manifest.evidence.push(entry);
    else manifest.evidence[i] = entry;
  }
  for (const id of internalCases) putReceipt(receipt(id));
  function pinPreparation() {
    manifest.preparation = write(
      'preparation.json',
      JSON.stringify(preparation),
    );
  }
  function options(overrides = {}) {
    const pin = write('internal-manifest.json', JSON.stringify(manifest));
    return {
      manifestPath: join(root, pin.path),
      evidenceRoot: root,
      sourceRoot,
      expectedSourceSha: SOURCE,
      expectedManifestSha256: pin.sha256,
      now: NOW,
      ...overrides,
    };
  }
  function validate(overrides = {}) {
    return validateInternalReadiness(options(overrides));
  }
  return {
    root,
    manifest,
    preparation,
    write,
    receipt,
    putReceipt,
    pinPreparation,
    options,
    validate,
  };
}

function neverAuthorizes(report) {
  for (const key of irreversible)
    assert.equal(report[key], false, `${key}: ${JSON.stringify(report)}`);
}

function rejects(report, detail = '') {
  assert.equal(
    report.internalReady,
    false,
    `${detail}: ${JSON.stringify(report)}`,
  );
  assert.ok(
    Array.isArray(report.internalBlockers) && report.internalBlockers.length,
    JSON.stringify(report),
  );
  for (const blocker of report.internalBlockers) {
    assert.equal(typeof blocker.code, 'string');
    assert.equal(typeof blocker.path, 'string');
  }
  neverAuthorizes(report);
}

function checkoutFixture(f) {
  const checkout = join(f.root, 'checkout');
  for (const path of [
    'packages/database/migrations',
    'pnpm-lock.yaml',
    'apps/worker/dsh/upstream.json',
  ]) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    cpSync(join(sourceRoot, path), join(checkout, path), { recursive: true });
  }
  return checkout;
}

function subscriptionFixture() {
  const f = fixture();
  const receipt = f.receipt(ASSISTANTS);
  const id = (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
  receipt.runId = id(1);
  receipt.tenantId = id(2);
  receipt.assertions = [
    ...CASE_ASSERTIONS[ASSISTANTS],
    ...ASSISTANT_BILLING_ASSERTIONS.subscription,
  ].map((name) => ({ name, expected: true, observed: true }));
  const snapshot = {
    version: 1,
    billingMode: 'subscription',
    harness: 'dsh',
    provider: 'openai-codex',
    authMode: 'chatgpt_subscription',
    sessionId: id(3),
    employeeId: id(4),
    connectionId: id(5),
    modelCatalogEntryId: id(6),
    policyRevision: 1,
    model: 'gpt-5.6-luna',
    credentialReference: 'deployment:synthetic-no-secret',
    baseUrl: null,
    frozenAt: '2026-09-14T10:00:00.000Z',
  };
  const snapshotDigest = `sha256:${hash(JSON.stringify(snapshot, Object.keys(snapshot).sort()))}`;
  const route = {
    id: id(7),
    organizationId: receipt.tenantId,
    workspaceId: id(8),
    runId: receipt.runId,
    ...Object.fromEntries(
      [
        'sessionId',
        'employeeId',
        'connectionId',
        'modelCatalogEntryId',
        'policyRevision',
        'harness',
        'provider',
        'model',
      ].map((key) => [key, snapshot[key]]),
    ),
    status: 'succeeded',
    subscriptionSnapshotDigest: snapshotDigest,
    costCents: null,
    usageComplete: true,
    cacheUsageKnown: false,
    inputTokens: 30,
    outputTokens: 15,
  };
  const proof = {
    schema: 'allrice-p27-subscription-accounting/v1',
    sourceSha: SOURCE,
    runId: receipt.runId,
    snapshot,
    snapshotDigest,
    route,
    ledger: {
      routeDecisionId: route.id,
      ...Object.fromEntries(
        [
          'organizationId',
          'workspaceId',
          'runId',
          'status',
          'costCents',
          'usageComplete',
          'cacheUsageKnown',
          'inputTokens',
          'outputTokens',
        ].map((key) => [key, route[key]]),
      ),
    },
    result: {
      provider: snapshot.provider,
      model: snapshot.model,
      assistantStatus: 'completed',
      billingMode: 'subscription',
      costBasis: 'not_applicable',
      estimatedCostCents: null,
      subscriptionSnapshotDigest: snapshotDigest,
      costEstimateAvailable: false,
      actualCostKnown: false,
      usageComplete: true,
      cacheUsageKnown: false,
      inputTokens: 30,
      outputTokens: 15,
    },
    tree: {
      status: 'completed',
      runIds: [receipt.runId, id(9), id(10)],
      modelCalls: 3,
      inputTokens: 30,
      outputTokens: 15,
      unsettledUsageCount: 0,
    },
    admissions: [receipt.runId, id(9), id(10)].map((runId, i) => ({
      callId: id(20 + i),
      runId,
      requestDigest: `sha256:${String(i).repeat(64)}`,
      dispatched: true,
      finished: true,
      inputTokens: 10,
      outputTokens: 5,
    })),
    priceSnapshotCount: 0,
    costReceiptCount: 0,
  };
  function put() {
    receipt.billing = {
      mode: 'subscription',
      proof: f.write(
        'observations/subscription-accounting.json',
        JSON.stringify(proof),
      ),
    };
    f.putReceipt(receipt);
  }
  put();
  return { ...f, billingReceipt: receipt, proof, put };
}

test('the exact 47-case matrix separates only publisher authority, never internal replay rejection', () => {
  assert.equal(INTERNAL_MATRIX.length, 47);
  assert.equal(internalCases.length, 45);
  assert.equal(
    INTERNAL_MATRIX.reduce(
      (sum, row) => sum + row.internalAssertions.length,
      0,
    ),
    161,
  );
  assert.equal(
    INTERNAL_MATRIX.reduce(
      (sum, row) => sum + row.externalAssertions.length,
      0,
    ),
    16,
  );
  assert.equal(161 + ASSISTANT_BILLING_ASSERTIONS.token_metered.length, 162);
  assert.equal(161 + ASSISTANT_BILLING_ASSERTIONS.subscription.length, 166);
  assert.deepEqual(
    INTERNAL_MATRIX.map((r) => r.caseId).sort(),
    [...REQUIRED_CASES].sort(),
  );
  for (const expected of expectedMatrix) {
    const actual = INTERNAL_MATRIX.find(
      (row) => row.caseId === expected.caseId,
    );
    for (const key of ['internalAssertions', 'externalAssertions', 'methods'])
      assert.deepEqual(
        [...actual[key]].sort(),
        [...expected[key]].sort(),
        `${expected.caseId}.${key}`,
      );
  }
});

test('synthetic internal completeness can pass with null publishers while every release action remains false', () => {
  const f = fixture();
  const report = f.validate();
  assert.equal(report.internalReady, true, JSON.stringify(report));
  assert.deepEqual(report.internalBlockers, []);
  assert.ok(
    Array.isArray(report.externalDistributionPending) &&
      report.externalDistributionPending.length,
  );
  neverAuthorizes(report);
  const formal = validateRelease({
    ...f.options(),
    manifestPath: join(f.root, f.manifest.preparation.path),
    expectedManifestSha256: f.manifest.preparation.sha256,
    gate: 'prepare',
  });
  assert.equal(formal.preparationVerified, true, JSON.stringify(formal));
  assert.equal(formal.technicalEvidenceComplete, false);
});

test('even populated publisher metadata cannot make internal validation release-eligible', () => {
  const f = fixture();
  f.preparation.clientPublisher = {
    teamId: 'TESTTEAM00',
    bundleId: 'invalid.test.fixture',
    updateKeySha256: 'd'.repeat(64),
  };
  f.pinPreparation();
  const report = f.validate();
  assert.equal(report.internalReady, true, JSON.stringify(report));
  assert.ok(report.externalDistributionPending.length);
  neverAuthorizes(report);
});

test('a passing internal manifest is rejected by every formal gate and cannot supply formal evidence', () => {
  const f = fixture();
  assert.equal(f.validate().internalReady, true);
  for (const gate of ['dev', 'rc', 'tenant', 'prod']) {
    const internalAsFormal = validateRelease({ ...f.options(), gate });
    assert.equal(internalAsFormal.passed, false, gate);
    assert.ok(
      internalAsFormal.blockers.some((b) => /schema/.test(b.code)),
      JSON.stringify(internalAsFormal),
    );
    const original = validateRelease({
      ...f.options(),
      manifestPath: join(f.root, f.manifest.preparation.path),
      expectedManifestSha256: f.manifest.preparation.sha256,
      gate,
    });
    assert.equal(original.passed, false, gate);
    assert.equal(original.authorizationGranted, false);
  }
  f.preparation.evidence = [...f.manifest.evidence];
  f.pinPreparation();
  const report = validateRelease({
    ...f.options(),
    manifestPath: join(f.root, f.manifest.preparation.path),
    expectedManifestSha256: f.manifest.preparation.sha256,
    gate: 'rc',
  });
  assert.equal(report.passed, false);
  assert.ok(
    report.blockers.some((b) => /evidence-schema/.test(b.code)),
    JSON.stringify(report),
  );
});

test('internal schemas cannot be replaced by formal manifests or V1/V2 receipts', () => {
  const f = fixture();
  const original = f.manifest.schema;
  f.manifest.schema = 'allrice-p28-release/v1';
  rejects(f.validate());
  f.manifest.schema = original;
  for (const schema of ['allrice-p27-evidence/v1', 'allrice-p27-evidence/v2']) {
    const receipt = f.receipt(internalCases[0]);
    receipt.schema = schema;
    f.putReceipt(receipt);
    rejects(f.validate(), schema);
  }
});

test(
  'every internal case is mandatory; external-only cases and unknown/canary entries cannot excuse omissions',
  { timeout: 15000 },
  () => {
    const f = fixture();
    for (const id of internalCases) {
      const index = f.manifest.evidence.findIndex(
        (entry) => entry.caseId === id,
      );
      const [entry] = f.manifest.evidence.splice(index, 1);
      rejects(f.validate(), id);
      f.manifest.evidence.splice(index, 0, entry);
    }
    for (const id of [
      'unknown-case',
      'tenant-canary-real-smoke',
      'client/arm64/developer-id-signature-notarization',
    ]) {
      const entry = { ...f.manifest.evidence[0], caseId: id };
      f.manifest.evidence.push(entry);
      rejects(f.validate(), id);
      f.manifest.evidence.pop();
    }
    f.manifest.evidence.push(f.manifest.evidence[0]);
    rejects(f.validate(), 'duplicate evidence');
  },
);

test(
  'missing, duplicate, unknown and failing normalized assertions never count as complete evidence',
  { timeout: 15000 },
  () => {
    const f = fixture();
    for (const id of internalCases) {
      const receipt = f.receipt(id);
      receipt.assertions.pop();
      f.putReceipt(receipt);
      rejects(f.validate(), id);
      f.putReceipt(f.receipt(id));
    }
    for (const mutate of [
      (r) => r.assertions.push(r.assertions[0]),
      (r) =>
        r.assertions.push({
          name: 'publisher-authenticated',
          expected: true,
          observed: true,
        }),
      (r) => {
        r.assertions[0].observed = false;
      },
      (r) => {
        r.assertions[0].expected = false;
        r.assertions[0].observed = false;
      },
      (r) => {
        r.assertions[0].observed = 'true';
      },
      (r) => {
        r.assertions[0].reason = 'skip';
      },
    ]) {
      const receipt = f.receipt(internalCases[0]);
      mutate(receipt);
      f.putReceipt(receipt);
      rejects(f.validate());
    }
  },
);

test('physical-component is allowed only for actual physical update/rejection checks; units and mocks are never sufficient', () => {
  const f = fixture();
  for (const arch of ['arm64', 'x64'])
    for (const name of [
      'authenticated-update-metadata',
      'invalid-signature-and-package-rejection',
    ]) {
      const receipt = f.receipt(`client/${arch}/${name}`);
      receipt.method = 'physical-component';
      f.putReceipt(receipt);
    }
  assert.equal(f.validate().internalReady, true);
  for (const id of [
    'local-edit-diff-test-exit',
    'client/arm64/restart-without-repair',
  ]) {
    const receipt = f.receipt(id);
    receipt.method = 'physical-component';
    f.putReceipt(receipt);
    rejects(f.validate(), id);
    f.putReceipt(f.receipt(id));
  }
  for (const method of ['unit', 'mock', 'unit-test', 'synthetic', 'unknown']) {
    const receipt = f.receipt('client/arm64/authenticated-update-metadata');
    receipt.method = method;
    f.putReceipt(receipt);
    rejects(f.validate(), method);
  }
});

test('passed status still requires real execution, exact identity, environment and nonempty execution context', () => {
  for (const [key, value] of [
    ['status', 'skipped'],
    ['status', 'unknown'],
    ['execution', 'mock'],
    ['sourceSha', BASELINE_SHA],
    ['caseId', 'another-case'],
    ['environment', 'ci'],
    ['tenantId', ''],
    ['runId', ''],
    ['command', ''],
    ['device', {}],
  ]) {
    const f = fixture();
    const receipt = { ...f.receipt(internalCases[0]), [key]: value };
    const original = f.manifest.evidence[0];
    original.file = f.write(original.file.path, JSON.stringify(receipt));
    rejects(f.validate(), key);
  }
});

test('both distinct physical device IDs are required and each architecture must keep a stable device identity', () => {
  const f = fixture();
  for (const id of internalCases.filter((id) => id.startsWith('client/x64/'))) {
    const receipt = f.receipt(id);
    receipt.device.id = 'synthetic-device-arm64';
    f.putReceipt(receipt);
  }
  rejects(f.validate(), 'same device claimed as both architectures');
  for (const architecture of ['arm64', 'x64']) {
    const g = fixture();
    const receipt = g.receipt(`client/${architecture}/restart-without-repair`);
    receipt.device.id = `second-${architecture}-device`;
    g.putReceipt(receipt);
    rejects(g.validate(), `unstable ${architecture} identity`);
  }
  for (const mutate of [
    (r) => {
      r.device.id = 'different-second-arm64-device';
    },
    (r) => {
      r.device.architecture = 'x64';
    },
    (r) => {
      r.device.physical = false;
    },
    (r) => {
      r.device.id = '';
    },
    (r) => {
      r.device.osVersion = '';
    },
    (r) => {
      r.device = null;
    },
  ]) {
    const g = fixture();
    const receipt = g.receipt('client/arm64/restart-without-repair');
    mutate(receipt);
    g.putReceipt(receipt);
    rejects(g.validate());
  }
});

test('trusted manifest/source pins are mandatory and mismatches stop before following inner paths', () => {
  const f = fixture();
  f.manifest.preparation.path = '../must-not-be-read';
  for (const overrides of [
    { expectedManifestSha256: '0'.repeat(64) },
    { expectedManifestSha256: undefined },
    { expectedSourceSha: undefined },
    { expectedSourceSha: 'short' },
    { now: NaN },
  ])
    rejects(f.validate(overrides));
  const g = fixture();
  for (const value of [BASELINE_SHA, 'b'.repeat(40)]) {
    g.manifest.sourceSha = value;
    rejects(g.validate());
  }
});

test('manifest, preparation, receipt and attachment bytes are independently pinned', () => {
  for (const target of ['preparation', 'artifact', 'receipt', 'attachment']) {
    const f = fixture();
    const receipt = f.receipt(internalCases[0]);
    f.putReceipt(receipt);
    const path =
      target === 'preparation'
        ? f.manifest.preparation.path
        : target === 'artifact'
          ? f.preparation.artifacts[0].file.path
          : target === 'receipt'
            ? f.manifest.evidence[0].file.path
            : receipt.attachments[0].path;
    f.write(path, 'tampered original bytes');
    rejects(f.validate(), target);
  }
  const f = fixture();
  f.manifest.preparation.bytes += 1;
  rejects(f.validate(), 'byte length');
});

test('receipts must bind the exact source/package pins and retain raw observations', () => {
  for (const mutate of [
    (r) => {
      r.artifacts['bridge-arm64'] = '0'.repeat(64);
    },
    (r) => {
      delete r.artifacts.source;
    },
    (r) => {
      r.artifacts.unexpected = '0'.repeat(64);
    },
    (r) => {
      r.attachments = [];
    },
    (r) => {
      r.attachments[0].sha256 = '0'.repeat(64);
    },
    (r) => {
      r.attachments[0].bytes = 0;
    },
  ]) {
    const f = fixture();
    const receipt = f.receipt('client/arm64/restart-without-repair');
    mutate(receipt);
    f.putReceipt(receipt);
    rejects(f.validate());
  }
});

test('stale, future, noncanonical and impossible times fail for every time-bearing inventory', () => {
  for (const target of ['manifest', 'preparation', 'receipt'])
    for (const date of [
      '2026-09-01T11:00:00.000Z',
      '2026-09-15T11:00:00.000Z',
      '2026-09-14',
      '2026-02-31T00:00:00.000Z',
      'unknown',
    ]) {
      const f = fixture();
      if (target === 'manifest') f.manifest.createdAt = date;
      else if (target === 'preparation') {
        f.preparation.createdAt = date;
        f.pinPreparation();
      } else {
        const receipt = f.receipt(internalCases[0]);
        receipt.observedAt = date;
        f.putReceipt(receipt);
      }
      rejects(f.validate(), `${target}: ${date}`);
    }
});

test('strict schemas reject missing/unknown fields and duplicate JSON keys even after repinning', () => {
  for (const target of ['manifest', 'preparation', 'receipt']) {
    const f = fixture();
    if (target === 'manifest') f.manifest.allowSkipped = true;
    else if (target === 'preparation') {
      f.preparation.allowUnsigned = true;
      f.pinPreparation();
    } else {
      const receipt = f.receipt(internalCases[0]);
      receipt.unverified = true;
      f.putReceipt(receipt);
    }
    rejects(f.validate(), target);
  }
  for (const field of ['method', 'billing', 'attachments']) {
    const f = fixture(),
      receipt = f.receipt(internalCases[0]);
    delete receipt[field];
    f.putReceipt(receipt);
    rejects(f.validate(), field);
  }
  for (const target of ['manifest', 'preparation', 'receipt']) {
    const f = fixture();
    if (target === 'manifest') {
      const pin = f.write(
        'ambiguous.json',
        JSON.stringify(f.manifest).replace(
          '"acceptanceId":',
          '"acceptanceId":"forged","acceptanceId":',
        ),
      );
      rejects(
        f.validate({
          manifestPath: join(f.root, pin.path),
          expectedManifestSha256: pin.sha256,
        }),
      );
    } else if (target === 'preparation') {
      f.manifest.preparation = f.write(
        'preparation.json',
        JSON.stringify(f.preparation).replace(
          '"signedClientRequired":true',
          '"signedClientRequired":false,"signedClientRequired":true',
        ),
      );
      rejects(f.validate());
    } else {
      const entry = f.manifest.evidence[0];
      entry.file = f.write(
        entry.file.path,
        JSON.stringify(f.receipt(entry.caseId)).replace(
          '"status":"passed"',
          '"status":"failed","status":"passed"',
        ),
      );
      rejects(f.validate());
    }
  }
});

test('hidden files, traversal, absolute paths, missing files and symlinks cannot be evidence', () => {
  for (const target of ['preparation', 'receipt', 'attachment'])
    for (const path of [
      '../outside',
      '/etc/passwd',
      '.env',
      'observations/.secret',
      'observations/../outside',
      'observations\\outside',
      'observations/absent.txt',
    ]) {
      const f = fixture();
      if (target === 'preparation') f.manifest.preparation.path = path;
      else if (target === 'receipt') f.manifest.evidence[0].file.path = path;
      else {
        const receipt = f.receipt(internalCases[0]);
        receipt.attachments[0].path = path;
        f.putReceipt(receipt);
      }
      rejects(f.validate(), `${target}: ${path}`);
    }
  const f = fixture();
  symlinkSync(
    join(f.root, f.manifest.preparation.path),
    join(f.root, 'linked.json'),
  );
  f.manifest.preparation.path = 'linked.json';
  rejects(f.validate());
  const g = fixture(),
    receipt = g.receipt(internalCases[0]);
  symlinkSync(
    join(g.root, 'observations'),
    join(g.root, 'linked-observations'),
  );
  receipt.attachments[0].path = receipt.attachments[0].path.replace(
    'observations/',
    'linked-observations/',
  );
  g.putReceipt(receipt);
  rejects(g.validate());
});

test.skipIf(process.platform === 'win32')(
  'source FIFOs are rejected before composing the original reader, without hanging',
  () => {
    for (const relativePath of [
      'pnpm-lock.yaml',
      'apps/worker/dsh/upstream.json',
      'packages/database/migrations/0092_browser_result_observation.sql',
      'packages/database/migrations/0999_internal_fifo.sql',
    ]) {
      const f = fixture();
      const checkout = checkoutFixture(f);
      const target = join(checkout, relativePath);
      if (relativePath.endsWith('0999_internal_fifo.sql'))
        writeFileSync(target, '-- SYNTHETIC FIFO REGRESSION ONLY\n');
      renameSync(target, `${target}.synthetic-original`);
      execFileSync('mkfifo', [target]);
      const options = f.options({ sourceRoot: checkout });
      // Bound the checker subprocess so a future regression cannot hang Vitest
      // while opening a test-owned pipe. This runs only the read-only checker.
      const moduleUrl = new URL('./p27-internal-readiness.mjs', import.meta.url)
        .href;
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { validateInternalReadiness } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(validateInternalReadiness(${JSON.stringify(options)})));`,
        ],
        { encoding: 'utf8', timeout: 3000 },
      );
      assert.equal(
        child.error,
        undefined,
        `${relativePath}: ${child.error?.message}`,
      );
      assert.equal(child.status, 0, child.stderr);
      rejects(JSON.parse(child.stdout), relativePath);
    }
  },
);

test('symlinked source migration directories and evidence roots are rejected', () => {
  const f = fixture();
  const checkout = checkoutFixture(f);
  const migrations = join(checkout, 'packages/database/migrations');
  renameSync(migrations, `${migrations}-synthetic-original`);
  symlinkSync(`${migrations}-synthetic-original`, migrations);
  rejects(f.validate({ sourceRoot: checkout }));
  const g = fixture();
  symlinkSync(g.root, join(g.root, 'linked-root'));
  const options = g.options();
  rejects(
    validateInternalReadiness({
      ...options,
      evidenceRoot: join(g.root, 'linked-root'),
      manifestPath: join(g.root, 'linked-root/internal-manifest.json'),
    }),
  );
});

test('preparation cannot smuggle evidence, blockers, unsupported exemptions or deployment authorizations', () => {
  for (const mutate of [
    (p, f) => {
      p.evidence = [f.manifest.evidence[0]];
    },
    (p) => {
      p.blockers = [{ id: 'open', reason: 'not complete', owner: 'fixture' }];
    },
    (p) => {
      p.unsupported = [
        { scope: 'Boost/Teamwork', reason: 'not done', followup: 'fixture' },
      ];
    },
    ...['dev', 'tenant', 'prod'].map((scope) => (p) => {
      p.authorizations[scope] = {};
    }),
  ]) {
    const f = fixture();
    mutate(f.preparation, f);
    f.pinPreparation();
    rejects(f.validate());
  }
  const f = fixture();
  f.manifest.blockers = [
    { id: 'open-work', reason: 'incomplete acceptance', owner: 'fixture' },
  ];
  rejects(f.validate());
});

test('internal checking retains all seven build pins, signed-client policy, default-off flags and source identity', () => {
  for (const mutate of [
    (p) => {
      p.artifacts.pop();
    },
    (p) => {
      p.artifacts.push(p.artifacts[0]);
    },
    (p) => {
      p.artifacts[0].sourceSha = 'b'.repeat(40);
    },
    (p) => {
      p.sourceSha = 'b'.repeat(40);
    },
    (p) => {
      p.signedClientRequired = false;
    },
    (p) => {
      p.flags[FLAGS[0]] = true;
    },
    (p) => {
      p.flags.UNKNOWN_FLAG = false;
    },
    (p) => {
      delete p.flags[FLAGS[0]];
    },
  ]) {
    const f = fixture();
    mutate(f.preparation);
    f.pinPreparation();
    rejects(f.validate());
  }
});

test('Dev receipt flags must remain off, assistant receipts must exercise the isolated enabled path', () => {
  for (const [id, key, value] of [
    [
      'dev-final-sha-login-history-downloads-flags-smoke',
      'ALLRICE_ASSISTANTS_ENABLED',
      true,
    ],
    [ASSISTANTS, 'ALLRICE_ASSISTANTS_ENABLED', false],
    [internalCases[0], FLAGS[0], 'false'],
    [internalCases[0], 'UNKNOWN_FLAG', false],
  ]) {
    const f = fixture(),
      receipt = f.receipt(id);
    receipt.flagSnapshot[key] = value;
    f.putReceipt(receipt);
    rejects(f.validate());
  }
});

test('migration history, exact candidate inventory, expand-only rollout and safe backfill remain mandatory', () => {
  const f = fixture(),
    checkout = checkoutFixture(f);
  writeFileSync(
    join(checkout, 'packages/database/migrations/0999_internal_synthetic.sql'),
    '-- SYNTHETIC TEST ONLY\n',
  );
  rejects(f.validate({ sourceRoot: checkout }), 'unlisted candidate');
  f.preparation.migrations.changes.push({
    name: '0999_internal_synthetic.sql',
    sha256: hash('-- SYNTHETIC TEST ONLY\n'),
    phase: 'expand',
  });
  f.pinPreparation();
  assert.equal(f.validate({ sourceRoot: checkout }).internalReady, true);
  writeFileSync(
    join(
      checkout,
      'packages/database/migrations/0092_browser_result_observation.sql',
    ),
    '-- modified history',
  );
  rejects(f.validate({ sourceRoot: checkout }), 'rewritten history');
  for (const mutate of [
    (m) => {
      m.changes.pop();
    },
    (m) => {
      m.changes[0].sha256 = '0'.repeat(64);
    },
    (m) => {
      m.changes[0].phase = 'contract';
    },
    (m) => {
      m.contractDeferred = false;
    },
    (m) => {
      m.backfillPolicy = 'automatic';
    },
  ]) {
    const g = fixture();
    mutate(g.preparation.migrations);
    g.pinPreparation();
    rejects(g.validate());
  }
});

test('rollback never authorizes destructive DB restore, old readers, replay or unpinned redeploy', () => {
  for (const mutate of [
    (r) => {
      r.database = 'restore-production-db';
    },
    (r) => {
      r.credentials = 'old-reader';
    },
    (r) => {
      r.drain = 'blind-replay';
    },
    (r) => {
      r.backup = 'validator-authorized';
    },
    (r) => {
      r.mode = 'compatible-redeploy';
    },
    ...PRESERVED_STATE.map((state) => (r) => {
      r.preserve = r.preserve.filter((name) => name !== state);
    }),
  ]) {
    const f = fixture();
    mutate(f.preparation.rollback);
    f.pinPreparation();
    rejects(f.validate());
  }
});

test('compatible redeploy binds all four target pins in the joint and both physical-architecture rollback receipts', () => {
  const f = fixture();
  const targetSha = 'b'.repeat(40);
  const rollbackCases = [
    'rollback-drain-reconcile-preserve-state',
    'client/arm64/compatible-rollback-preserves-state',
    'client/x64/compatible-rollback-preserves-state',
  ];
  Object.assign(f.preparation.rollback, {
    mode: 'compatible-redeploy',
    targetSourceSha: targetSha,
    targetReleaseId: 'SYNTHETIC-PINNED-ROLLBACK-NOT-A-RELEASE',
    targetArtifacts: ['bridge-arm64', 'bridge-x64', 'web', 'worker'].map(
      (id) => ({
        id,
        sourceSha: targetSha,
        version: 'synthetic-compatible-reader',
        buildId: `synthetic-rollback-${id}`,
        file: f.write(
          `rollback/${id}.txt`,
          `SYNTHETIC ROLLBACK TARGET ONLY: ${id}`,
        ),
      }),
    ),
  });
  f.pinPreparation();
  function rollbackReceipt(caseId) {
    const receipt = f.receipt(caseId);
    for (const target of f.preparation.rollback.targetArtifacts)
      receipt.artifacts[`rollback/${target.id}`] = target.file.sha256;
    return receipt;
  }
  for (const caseId of rollbackCases) f.putReceipt(rollbackReceipt(caseId));
  const report = f.validate();
  assert.equal(report.internalReady, true, JSON.stringify(report));
  neverAuthorizes(report);
  for (const caseId of rollbackCases)
    for (const target of f.preparation.rollback.targetArtifacts)
      for (const mode of ['missing', 'wrong-digest']) {
        const receipt = rollbackReceipt(caseId);
        const key = `rollback/${target.id}`;
        if (mode === 'missing') delete receipt.artifacts[key];
        else receipt.artifacts[key] = '0'.repeat(64);
        f.putReceipt(receipt);
        rejects(f.validate(), `${caseId} ${key} ${mode}`);
        f.putReceipt(rollbackReceipt(caseId));
      }
  assert.equal(f.validate().internalReady, true);
  const [target] = f.preparation.rollback.targetArtifacts;
  f.write(target.file.path, 'tampered compatible target bytes');
  rejects(f.validate(), 'changed rollback package bytes');
});

test('billing branches retain API pricing coverage and pinned Codex subscription N/A proof without any calls', () => {
  assert.equal(fixture().validate().internalReady, true);
  const subscription = subscriptionFixture();
  const report = subscription.validate();
  assert.equal(report.internalReady, true, JSON.stringify(report));
  assert.ok(
    !subscription.billingReceipt.assertions.some(
      (a) => a.name === ASSISTANT_BILLING_ASSERTIONS.token_metered[0],
    ),
  );
  neverAuthorizes(report);
});

test('explicit billing discriminator cannot bypass pricing assertions or pinned subscription proof', () => {
  for (const mutate of [
    (r) => {
      r.billing = null;
    },
    (r) => {
      delete r.billing;
    },
    (r) => {
      r.billing.mode = 'free';
    },
    (r) => {
      r.assertions = r.assertions.filter(
        (a) => !ASSISTANT_BILLING_ASSERTIONS.token_metered.includes(a.name),
      );
    },
    (r) => {
      r.billing.extra = true;
    },
  ]) {
    const f = fixture(),
      receipt = f.receipt(ASSISTANTS);
    mutate(receipt);
    f.putReceipt(receipt);
    rejects(f.validate());
  }
  const other = fixture(),
    receipt = other.receipt(internalCases[0]);
  receipt.billing = { mode: 'token_metered' };
  other.putReceipt(receipt);
  rejects(other.validate());
  for (const mutate of [
    (r) => {
      delete r.billing.proof;
    },
    (r) => {
      r.billing.proof.sha256 = '0'.repeat(64);
    },
    (r) => {
      r.billing.proof.path = '../outside';
    },
    (r) => {
      r.assertions.push({
        name: ASSISTANT_BILLING_ASSERTIONS.token_metered[0],
        expected: true,
        observed: true,
      });
    },
    ...ASSISTANT_BILLING_ASSERTIONS.subscription.map((name) => (r) => {
      r.assertions = r.assertions.filter((a) => a.name !== name);
    }),
  ]) {
    const f = subscriptionFixture();
    mutate(f.billingReceipt);
    f.putReceipt(f.billingReceipt);
    rejects(f.validate());
  }
});

test('billing mode must be a strict string: arrays, objects and null never coerce into a proof-free subscription', () => {
  for (const mode of [
    ['subscription'],
    ['token_metered'],
    { value: 'subscription' },
    { toString: 'subscription' },
    null,
  ]) {
    const f = subscriptionFixture();
    // Retain the five subscription assertions, but intentionally omit proof.
    // ['subscription'] must not pass Object.hasOwn by string coercion and then
    // skip a separate strict-equality proof branch.
    f.billingReceipt.billing = { mode };
    f.putReceipt(f.billingReceipt);
    rejects(f.validate(), JSON.stringify(mode));
  }
});

test('repinned subscription proof rejects wrong identities, fabricated free cost, unknown tokens and duplicate/adopted usage', () => {
  for (const mutate of [
    (p) => {
      p.sourceSha = BASELINE_SHA;
    },
    (p) => {
      p.route.runId = p.route.id;
    },
    (p) => {
      p.route.organizationId = p.route.id;
    },
    (p) => {
      p.snapshot.credentialReference = 'deployment:forged';
    },
    (p) => {
      p.result.subscriptionSnapshotDigest = `sha256:${'0'.repeat(64)}`;
    },
    (p) => {
      p.result.estimatedCostCents = 0;
    },
    (p) => {
      p.result.costCurrency = 'USD';
    },
    (p) => {
      p.ledger.costCents = 0;
    },
    (p) => {
      p.ledger.usageComplete = false;
    },
    (p) => {
      p.ledger.inputTokens += 1;
    },
    (p) => {
      p.tree.unsettledUsageCount = 1;
    },
    (p) => {
      p.admissions[0].finished = false;
    },
    (p) => {
      p.admissions[0].dispatched = false;
    },
    (p) => {
      delete p.admissions[0].outputTokens;
    },
    (p) => {
      p.admissions[1].callId = p.admissions[0].callId;
    },
    (p) => {
      p.admissions[1].runId = p.admissions[0].runId;
    },
    (p) => {
      p.priceSnapshotCount = 1;
    },
    (p) => {
      p.costReceiptCount = 1;
    },
  ]) {
    const f = subscriptionFixture();
    mutate(f.proof);
    f.put();
    rejects(f.validate());
  }
});

test('validation is read-only: every staged byte and directory survives success and failure', () => {
  const f = fixture();
  function snapshot(dir) {
    return readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => [
        entry.name,
        entry.isDirectory()
          ? snapshot(join(dir, entry.name))
          : hash(readFileSync(join(dir, entry.name))),
      ]);
  }
  const options = f.options(),
    before = snapshot(f.root);
  assert.equal(validateInternalReadiness(options).internalReady, true);
  rejects(
    validateInternalReadiness({
      ...options,
      expectedSourceSha: 'b'.repeat(40),
    }),
  );
  assert.deepEqual(snapshot(f.root), before);
});

test('CLI exposes exactly five pinned read-only inputs and no formal gate or bypass option', () => {
  for (const args of [
    [],
    ['--skip', 'true'],
    ['--gate', 'rc'],
    ['--allow-unsigned', 'true'],
    ['--manifest', 'a', '--manifest', 'b'],
    ['--manifest'],
  ])
    assert.throws(() => main(args));
  const f = fixture(),
    options = f.options();
  const args = [
    '--manifest',
    options.manifestPath,
    '--evidence-root',
    options.evidenceRoot,
    '--source-root',
    options.sourceRoot,
    '--source-sha',
    SOURCE,
    '--manifest-sha256',
    options.expectedManifestSha256,
  ];
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  assert.equal(main(args), 0);
  const report = JSON.parse(output.mock.calls.at(-1)[0]);
  assert.equal(report.internalReady, true);
  neverAuthorizes(report);
  for (const suffix of [
    ['--gate', 'dev'],
    ['--gate', 'prod'],
    ['--skip', 'true'],
    ['--source-sha', SOURCE],
  ])
    assert.throws(() => main([...args, ...suffix]));
  const wrongPin = [...args];
  wrongPin[wrongPin.length - 1] = '0'.repeat(64);
  assert.equal(main(wrongPin), 2);
});
