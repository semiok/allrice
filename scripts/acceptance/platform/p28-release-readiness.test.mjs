// Synthetic parser fixtures only. None of these files are product evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { ARTIFACT_IDS, BASELINE_SHA, CANARY_CASE, CASE_ASSERTIONS, FLAGS, PRESERVED_STATE, REQUIRED_CASES, main, validateRelease } from './p28-release-readiness.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE = 'a'.repeat(40), NOW = Date.parse('2026-09-14T12:00:00.000Z');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const temporary = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  // macOS /var is a symlink. Resolve to the real /private/var staging root.
  const base = mkdtempSync(join(tmpdir(), 'allrice-p28-validator-test-'));
  temporary.push(base);
  const root = realpathSync(base);
  function write(path, bytes) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
    return { path, sha256: hash(bytes), bytes: Buffer.byteLength(bytes) };
  }
  const manifest = {
    schema: 'allrice-p28-release/v1', releaseId: 'TEST-ONLY-NOT-A-RELEASE', sourceSha: SOURCE,
    baselineSha: BASELINE_SHA, createdAt: '2026-09-14T11:00:00.000Z',
    artifacts: ARTIFACT_IDS.map(id => ({
      id, sourceSha: SOURCE, version: 'test-fixture', buildId: `test-${id}`,
      file: write(`artifacts/${id}.txt`, id === 'lockfile' ? readFileSync(join(sourceRoot, 'pnpm-lock.yaml')) : id === 'dsh-upstream' ? readFileSync(join(sourceRoot, 'apps/worker/dsh/upstream.json')) : `SYNTHETIC PARSER FIXTURE, NEVER PRODUCT EVIDENCE: ${id}`),
    })),
    flags: Object.fromEntries(FLAGS.map(name => [name, false])), signedClientRequired: true,
    clientPublisher: { teamId: 'TESTTEAM00', bundleId: 'invalid.test.fixture', updateKeySha256: 'd'.repeat(64) },
    migrations: { changes: readdirSync(join(sourceRoot, 'packages/database/migrations')).filter(name => name.endsWith('.sql') && Number(name.slice(0, 4)) > 92).sort().map(name => ({ name, sha256: hash(readFileSync(join(sourceRoot, 'packages/database/migrations', name))), phase: 'expand' })), contractDeferred: true, backfillPolicy: 'idempotent-bounded-resumable-separate-approval' },
    rollback: { mode: 'forward-fix-only', reason: 'Test fixture: no verified compatible old reader.', targetSourceSha: null, targetReleaseId: null, targetArtifacts: [], database: 'no-down-migration', credentials: 'current-or-newer-reader-no-repair', drain: 'reconcile-unknown-never-blind-replay', preserve: [...PRESERVED_STATE], backup: 'separate-authorization-required-not-taken-by-validator' },
    evidence: [], blockers: [], unsupported: [{ scope: 'Boost/Teamwork', reason: 'S8, not GA implementation.', followup: 'execution-master S8' }],
    authorizations: { dev: null, tenant: null, prod: null },
  };
  function receipt(caseId) {
    const client = caseId.startsWith('client/'), arch = caseId.split('/')[1];
    const short = client ? caseId.split('/')[2] : caseId;
    const assertions = CASE_ASSERTIONS[short].map(name => ({ name, expected: true, observed: true }));
    if (short === 'developer-id-signature-notarization') {
      assertions.push({ name: 'publisher-team-id', expected: manifest.clientPublisher.teamId, observed: manifest.clientPublisher.teamId });
      assertions.push({ name: 'publisher-bundle-id', expected: manifest.clientPublisher.bundleId, observed: manifest.clientPublisher.bundleId });
    }
    if (short === 'authenticated-update-metadata') assertions.push({ name: 'update-key-sha256', expected: manifest.clientPublisher.updateKeySha256, observed: manifest.clientPublisher.updateKeySha256 });
    return { schema: 'allrice-p27-evidence/v1', caseId, sourceSha: SOURCE, status: 'passed', execution: 'real-execution', observedAt: '2026-09-14T11:00:00.000Z', environment: client ? 'physical-macos' : caseId === CANARY_CASE ? 'tenant' : caseId.startsWith('dev-') ? 'dev' : 'isolated', tenantId: 'test-only-tenant', runId: `test-only-${caseId}`, command: 'SYNTHETIC SCHEMA INPUT: NO PRODUCT COMMAND EXECUTED', artifacts: Object.fromEntries(manifest.artifacts.filter(a => !client || ['source', `bridge-${arch}`].includes(a.id)).map(a => [a.id, a.file.sha256])), flagSnapshot: Object.fromEntries(FLAGS.map(name => [name, name === 'ALLRICE_ASSISTANTS_ENABLED' && (caseId.startsWith('assistants-') || caseId === CANARY_CASE)])), assertions, attachments: [write(`observations/${caseId}.txt`, 'Synthetic schema assertion only; no product test executed.')], device: client ? { id: `test-only-${arch}`, architecture: arch, osVersion: 'test-only-os', physical: true } : null };
  }
  function putReceipt(value) {
    const entry = { caseId: value.caseId, file: write(`receipts/${value.caseId}.json`, JSON.stringify(value)) };
    const index = manifest.evidence.findIndex(e => e.caseId === value.caseId);
    if (index < 0) manifest.evidence.push(entry); else manifest.evidence[index] = entry;
  }
  for (const id of REQUIRED_CASES) putReceipt(receipt(id));
  function authorize(scope) {
    const record = write(`authorizations/${scope}.txt`, `SYNTHETIC TEST RECORD ONLY: ${scope}`);
    manifest.authorizations[scope] = { scope, sourceSha: SOURCE, releaseId: manifest.releaseId, approver: 'test-fixture-not-real-approval', record: record.path, recordSha256: record.sha256, grantedAt: '2026-09-14T11:00:00.000Z', expiresAt: '2026-09-15T11:00:00.000Z', tenantIds: ['test-only-tenant'], enableFlags: scope === 'dev' ? [] : ['ALLRICE_ASSISTANTS_ENABLED'], migrationNames: manifest.migrations.changes.map(x => x.name), rollbackMode: manifest.rollback.mode };
  }
  function validate(gate = 'rc', overrides = {}) {
    const file = write('manifest.json', JSON.stringify(manifest));
    return validateRelease({ manifestPath: join(root, file.path), evidenceRoot: root, sourceRoot, expectedSourceSha: SOURCE, expectedManifestSha256: file.sha256, now: NOW, gate, ...overrides });
  }
  return { root, manifest, write, receipt, putReceipt, authorize, validate };
}
function rejects(report, code) { assert.equal(report.passed, false, JSON.stringify(report)); assert.ok(report.blockers.some(item => item.code === code), JSON.stringify(report)); }

test('synthetic fixture tests metadata completeness only and never grants or executes release', () => {
  const f = fixture(), report = f.validate();
  assert.equal(report.passed, true, JSON.stringify(report));
  for (const key of ['deploymentExecuted', 'migrationExecuted', 'flagsChanged', 'authorizationGranted', 'gaDeclared']) assert.equal(report[key], false);
  assert.match(report.scope, /declared-evidence-completeness-only/);
});

test('preparation remains possible without certificates or real-device evidence; RC does not', () => {
  const f = fixture(); f.manifest.clientPublisher = { teamId: null, bundleId: null, updateKeySha256: null };
  f.manifest.evidence = [];
  f.manifest.blockers = [{ id: 'certificates', reason: 'No Developer ID identities available.', owner: 'release owner' }];
  const report = f.validate('prepare');
  assert.equal(report.passed, true); assert.equal(report.technicalEvidenceComplete, false);
  assert.ok(report.technicalBlockers.some(x => x.code === 'missing-required-evidence'));
  rejects(f.validate(), 'declared-open-blocker');
});

test('reject missing/bad trust pins before following artifact paths', () => {
  const f = fixture(); f.manifest.artifacts[0].file.path = '../must-never-read';
  const report = f.validate('rc', { expectedManifestSha256: '0'.repeat(64) });
  rejects(report, 'manifest-integrity-mismatch');
  assert.equal(report.blockers.length, 1);
  rejects(f.validate('rc', { expectedManifestSha256: undefined }), 'trusted-manifest-pin-required');
  rejects(f.validate('rc', { expectedSourceSha: 'short' }), 'trusted-source-pin-required');
});

test('B5 history, wrong SHA and different source artifacts cannot satisfy B6', () => {
  const f = fixture(); f.manifest.sourceSha = BASELINE_SHA;
  rejects(f.validate('rc', { expectedSourceSha: BASELINE_SHA }), 'candidate-source-mismatch-or-b5');
  f.manifest.sourceSha = SOURCE; f.manifest.artifacts[0].sourceSha = 'b'.repeat(40);
  rejects(f.validate(), 'artifact-source-mismatch');
  f.manifest.artifacts[0].sourceSha = SOURCE;
  rejects(f.validate('rc', { expectedSourceSha: 'b'.repeat(40) }), 'candidate-source-mismatch-or-b5');
});

test('reject stale/future/invalid receipt dates and stale manifest', () => {
  const f = fixture(), receipt = f.receipt(REQUIRED_CASES[0]);
  for (const date of ['2026-09-01T11:00:00.000Z', '2026-09-15T11:00:00.000Z', 'unknown']) {
    receipt.observedAt = date; f.putReceipt(receipt); rejects(f.validate(), 'missing-stale-or-future-timestamp');
  }
  f.manifest.createdAt = '2026-01-01T00:00:00.000Z'; rejects(f.validate('prepare'), 'missing-stale-or-future-timestamp');
});

test('reject missing, duplicate, unknown, skipped, mock and wrong-environment evidence', () => {
  const f = fixture(); const missing = f.manifest.evidence.pop(); rejects(f.validate(), 'missing-required-evidence');
  f.manifest.evidence.push(missing, missing); rejects(f.validate(), 'duplicate-evidence-case'); f.manifest.evidence.pop();
  const entry = f.manifest.evidence[0]; entry.caseId = 'unknown'; rejects(f.validate(), 'unknown-evidence-case'); entry.caseId = REQUIRED_CASES[0];
  const receipt = f.receipt(entry.caseId);
  for (const [key, value, code] of [['status', 'skipped', 'evidence-not-real-passed'], ['status', 'unknown', 'evidence-not-real-passed'], ['execution', 'mock', 'evidence-not-real-passed'], ['sourceSha', BASELINE_SHA, 'evidence-source-mismatch'], ['environment', 'ci', 'wrong-evidence-environment']]) {
    f.putReceipt({ ...receipt, [key]: value }); rejects(f.validate(), code);
  }
});

test('reject missing mandatory negative assertions, assertion failures and unknown fields', () => {
  const f = fixture(), receipt = f.receipt(REQUIRED_CASES[0]);
  receipt.assertions.pop(); f.putReceipt(receipt); rejects(f.validate(), 'assertion-coverage-missing-duplicate-or-unknown');
  receipt.assertions[0].observed = false; f.putReceipt(receipt); rejects(f.validate(), 'assertion-failed-or-incomplete');
  receipt.unverified = true; f.putReceipt(receipt); rejects(f.validate(), 'unknown-field');
  f.manifest.allowSkipped = true; rejects(f.validate('prepare'), 'unknown-field');
});

test('checks exact bytes for packages, report files and original observation attachments', () => {
  const f = fixture(), original = f.manifest.artifacts[3].file;
  f.write(original.path, 'changed package'); rejects(f.validate(), 'file-integrity-mismatch');
  const g = fixture(), entry = g.manifest.evidence[0]; g.write(entry.file.path, '{}'); rejects(g.validate(), 'file-integrity-mismatch');
  const h = fixture(), receipt = h.receipt(REQUIRED_CASES[0]); h.putReceipt(receipt); h.write(receipt.attachments[0].path, 'modified log'); rejects(h.validate(), 'file-integrity-mismatch');
});

test('package-specific artifact binding rejects success from another build', () => {
  const f = fixture(), receipt = f.receipt('client/arm64/restart-without-repair');
  receipt.artifacts['bridge-arm64'] = '0'.repeat(64); f.putReceipt(receipt); rejects(f.validate(), 'evidence-artifact-mismatch');
});

test('two actual architectures and publisher identity cannot be replaced by one device/hash', () => {
  const f = fixture();
  for (const id of REQUIRED_CASES.filter(id => id.startsWith('client/x64'))) {
    const receipt = f.receipt(id); receipt.device.id = 'test-only-arm64'; f.putReceipt(receipt);
  }
  rejects(f.validate(), 'two-distinct-physical-devices-required');
  const g = fixture(), receipt = g.receipt('client/arm64/developer-id-signature-notarization');
  receipt.assertions.find(a => a.name === 'publisher-team-id').observed = 'WRONGTEAM0'; g.putReceipt(receipt);
  rejects(g.validate(), 'assertion-failed-or-incomplete');
});

test('default-off flags and signed-client gate cannot be bypassed', () => {
  const f = fixture(); f.manifest.flags.ALLRICE_ASSISTANTS_ENABLED = true; rejects(f.validate('prepare'), 'default-feature-must-remain-off');
  f.manifest.flags.ALLRICE_ASSISTANTS_ENABLED = false; f.manifest.flags.UNKNOWN_FLAG = false; rejects(f.validate('prepare'), 'unknown-field');
  delete f.manifest.flags.UNKNOWN_FLAG; f.manifest.signedClientRequired = false; rejects(f.validate('prepare'), 'signed-client-gate-cannot-be-disabled');
});

test('reject hidden paths, traversal, symlinks and missing files without reading targets', () => {
  for (const path of ['../outside', '/etc/passwd', '.env', 'artifacts/absent.txt']) {
    const f = fixture(); f.manifest.artifacts[0].file.path = path; rejects(f.validate('prepare'), 'file-unreadable-or-unsafe');
  }
  const f = fixture(); symlinkSync(join(f.root, 'artifacts/web.txt'), join(f.root, 'artifacts/link.txt'));
  f.manifest.artifacts[0].file.path = 'artifacts/link.txt'; rejects(f.validate('prepare'), 'file-unreadable-or-unsafe');
});

test('reject altered historical migrations and unlisted candidate migrations', () => {
  const f = fixture(), checkout = join(f.root, 'checkout');
  for (const path of ['packages/database/migrations', 'pnpm-lock.yaml', 'apps/worker/dsh/upstream.json']) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true }); cpSync(join(sourceRoot, path), join(checkout, path), { recursive: true });
  }
  writeFileSync(join(checkout, 'packages/database/migrations/0999_p28_test_fixture.sql'), 'CREATE TABLE test_fixture(id text);');
  rejects(f.validate('prepare', { sourceRoot: checkout }), 'migration-inventory-incomplete-or-extra');
  const bytes = readFileSync(join(checkout, 'packages/database/migrations/0999_p28_test_fixture.sql'));
  f.manifest.migrations.changes.push({ name: '0999_p28_test_fixture.sql', sha256: hash(bytes), phase: 'expand' });
  assert.equal(f.validate('prepare', { sourceRoot: checkout }).passed, true);
  f.manifest.migrations.changes[0].phase = 'contract'; rejects(f.validate('prepare', { sourceRoot: checkout }), 'contract-or-unknown-phase-rejected');
  writeFileSync(join(checkout, 'packages/database/migrations/0092_browser_result_observation.sql'), '-- altered history');
  rejects(f.validate('prepare', { sourceRoot: checkout }), 'baseline-migration-history-changed');
});

test('rollback plan rejects destructive DB rollback, old credential readers, incomplete preservation and unpinned targets', () => {
  const f = fixture(); f.manifest.rollback.database = 'restore-production-db'; rejects(f.validate('prepare'), 'destructive-database-rollback-forbidden');
  f.manifest.rollback.database = 'no-down-migration'; f.manifest.rollback.credentials = 'old-reader'; rejects(f.validate('prepare'), 'old-credential-reader-forbidden');
  f.manifest.rollback.credentials = 'current-or-newer-reader-no-repair'; f.manifest.rollback.preserve.pop(); rejects(f.validate('prepare'), 'preservation-scope-incomplete');
  f.manifest.rollback.preserve = [...PRESERVED_STATE]; f.manifest.rollback.mode = 'compatible-redeploy'; rejects(f.validate('prepare'), 'rollback-target-pin-required');
});

test('Dev, tenant enablement and Prod need independent scope/version-bound authorization records', () => {
  const f = fixture(); rejects(f.validate('dev'), 'separate-authorization-missing');
  f.authorize('dev'); assert.equal(f.validate('dev').passed, true);
  rejects(f.validate('tenant'), 'separate-authorization-missing');
  f.authorize('tenant'); assert.equal(f.validate('tenant').passed, true);
  rejects(f.validate('prod'), 'separate-authorization-missing');
  f.authorize('prod'); rejects(f.validate('prod'), 'missing-required-evidence');
  f.putReceipt(f.receipt(CANARY_CASE)); assert.equal(f.validate('prod').passed, true);
  f.manifest.authorizations.prod.sourceSha = BASELINE_SHA; rejects(f.validate('prod'), 'authorization-scope-or-version-mismatch');
});

test('Dev preflight is not circular: only final Dev smoke may be pending; RC still blocks', () => {
  const f = fixture(); f.authorize('dev'); f.manifest.evidence = f.manifest.evidence.filter(x => !x.caseId.startsWith('dev-'));
  assert.equal(f.validate('dev').passed, true); assert.equal(f.validate('dev').technicalEvidenceComplete, false);
  rejects(f.validate(), 'missing-required-evidence');
});

test('authorization rejects expiry, wildcard tenants, enabling via Dev and corrupted approval records', () => {
  const f = fixture(); f.authorize('dev'); f.manifest.authorizations.dev.enableFlags = [FLAGS[0]]; rejects(f.validate('dev'), 'dev-deploy-does-not-authorize-tenant-enablement');
  f.authorize('tenant'); f.manifest.authorizations.dev = null;
  f.manifest.authorizations.tenant.tenantIds = ['*']; rejects(f.validate('tenant'), 'explicit-tenant-scope-required');
  f.authorize('tenant'); f.manifest.authorizations.tenant.expiresAt = '2026-09-14T10:00:00.000Z'; rejects(f.validate('tenant'), 'authorization-expired-or-invalid');
  f.authorize('tenant'); f.write(f.manifest.authorizations.tenant.record, 'replaced'); rejects(f.validate('tenant'), 'authorization-record-integrity-mismatch');
});

test('no unsupported declaration can exempt a required GA case', () => {
  const f = fixture(); f.manifest.unsupported[0].scope = REQUIRED_CASES[0]; rejects(f.validate('prepare'), 'required-ga-case-cannot-be-exempted');
});

test('validation leaves every staged byte and directory intact', () => {
  const f = fixture(); f.validate();
  function snapshot(dir) { return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(e => [e.name, e.isDirectory() ? snapshot(join(dir, e.name)) : hash(readFileSync(join(dir, e.name)))]); }
  const before = snapshot(f.root); f.validate(); assert.deepEqual(snapshot(f.root), before);
});

test('CLI rejects missing/duplicate/unknown options and has no bypass switch', () => {
  for (const args of [[], ['--skip', 'true'], ['--manifest', 'a', '--manifest', 'b'], ['--gate']]) assert.throws(() => main(args));
});

test('ambiguous duplicate JSON fields are rejected even with a matching file digest', () => {
  const f = fixture(), receipt = f.receipt(REQUIRED_CASES[0]);
  f.manifest.evidence[0].file = f.write(`receipts/${receipt.caseId}.json`, JSON.stringify(receipt).replace('"status":"passed"', '"status":"failed","status":"passed"'));
  rejects(f.validate(), 'evidence-unreadable-or-invalid-json');
});

test('Dev evidence with enabled flags and assistant evidence from the disabled path are rejected', () => {
  const f = fixture(), receipt = f.receipt('dev-final-sha-login-history-downloads-flags-smoke');
  receipt.flagSnapshot.ALLRICE_ASSISTANTS_ENABLED = true; f.putReceipt(receipt); rejects(f.validate(), 'dev-flag-snapshot-mismatch');
  const g = fixture(), child = g.receipt('assistants-real-dsh-two-children-no-bridge');
  child.flagSnapshot.ALLRICE_ASSISTANTS_ENABLED = false; g.putReceipt(child); rejects(g.validate(), 'assistant-evidence-needs-isolated-enabled-path');
});
