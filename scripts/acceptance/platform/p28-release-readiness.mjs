// Read-only evidence inventory, NOT an acceptance runner or deployment authority.
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASELINE_SHA = '57f3b5fd2acba034e9011231075c3e29b4503733';
export const BASELINE_MIGRATIONS_SHA256 =
  'ef1e7b033c925c452196271bb402706556b60f39c11b83c9573bdcdb09abe747';
export const MAX_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const FLAGS = [
  'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
  'ALLRICE_RUNTIME_POLICY_ENABLED',
  'ALLRICE_LOCAL_COMMAND_ENABLED',
  'ALLRICE_CHANGESET_ENABLED',
  'ALLRICE_LOCAL_SERVICE_ENABLED',
  'ALLRICE_BRIDGE_WSS_ENABLED',
  'ALLRICE_CLOUD_RUNNER_ENABLED',
  'ALLRICE_CLOUD_MCP_ENABLED',
  'ALLRICE_LOCAL_MCP_ENABLED',
  'ALLRICE_EXPERIENCE_REVIEW_ENABLED',
  'ALLRICE_BROWSER_CONTROL_ENABLED',
  'ALLRICE_LOCAL_BROWSER_ENABLED',
  'ALLRICE_LOCAL_PREVIEW_ENABLED',
  'ALLRICE_ASSISTANTS_ENABLED',
];
export const ARTIFACT_IDS = [
  'source',
  'lockfile',
  'dsh-upstream',
  'web',
  'worker',
  'bridge-arm64',
  'bridge-x64',
];
export const PRESERVED_STATE = [
  'sessions',
  'pairings',
  'workspace-grants',
  'journal-outbox',
  'credential-records',
  'memory-skill',
  'runtime-ledger',
  'assistant-model-admissions',
  'model-usage-and-unknown-cost',
  'artifacts',
];
export const CLIENT_CASES = [
  'developer-id-signature-notarization',
  'authenticated-update-metadata',
  'fresh-install-gui-pair-workspace',
  'restart-without-repair',
  'keychain-save-read-migration',
  'credential-denial-partial-cleanup',
  'invalid-signature-and-package-rejection',
  'update-drain-and-interruption',
  'compatible-rollback-preserves-state',
  'revoke-device-and-directory',
  'local-command-changeset-cancel-isolation',
];
export const JOINT_CASES = [
  'source-build-package-provenance',
  'local-edit-diff-test-exit',
  'local-cancel-disconnect-approval-drift',
  'local-process-tree-isolation',
  'cloud-no-bridge-reconciliation-download',
  'cloud-container-destroy-artifact-read',
  'cloud-browser-actions-takeover-revoke',
  'local-browser-actions-takeover-revoke',
  'preview-reachable-stop-offline-malicious-isolation',
  'cross-tenant-denial',
  'policy-revocation-frozen-config-audit',
  'budget-stop-and-unknown-no-replay',
  'old-bridge-http-wss-and-existing-session',
  'skill-contents-review-next-run-version',
  'workbench-version-feedback-revision-review',
  'workbench-duplicate-late-events-usage',
  'assistants-real-dsh-two-children-no-bridge',
  'assistants-narrow-permissions-approval',
  'assistants-root-budget-child-tree-cancel',
  'assistants-outbox-checkpoint-cold-recovery',
  'assistants-partial-failure-artifact-conflict-refresh',
  'unreleased-modes-all-entry-denial-single-agent',
  'migration-expand-backfill-compatibility',
  'rollback-drain-reconcile-preserve-state',
  'dev-final-sha-login-history-downloads-flags-smoke',
];
export const REQUIRED_CASES = [
  ...JOINT_CASES,
  ...['arm64', 'x64'].flatMap((arch) =>
    CLIENT_CASES.map((id) => `client/${arch}/${id}`),
  ),
];
export const CANARY_CASE = 'tenant-canary-real-smoke';
// Normalized assertions are an interchange contract, not generated test results.
// Producers must retain the corresponding original observations/runner output.
export const CASE_ASSERTIONS = {
  'source-build-package-provenance': [
    'clean-pinned-checkout',
    'archive-matches-source',
    'all-artifacts-built-from-pinned-source',
  ],
  'local-edit-diff-test-exit': [
    'actual-diff',
    'actual-test-exit-code',
    'user-changes-preserved',
  ],
  'local-cancel-disconnect-approval-drift': [
    'cancel-confirmed',
    'disconnect-reconciled',
    'changed-approved-input-rejected',
  ],
  'local-process-tree-isolation': [
    'out-of-root-denied',
    'sensitive-access-denied',
    'escaped-descendants-stopped',
  ],
  'cloud-no-bridge-reconciliation-download': [
    'bridge-absent',
    'deterministic-reference-match',
    'download-reopened',
  ],
  'cloud-container-destroy-artifact-read': [
    'container-destroyed',
    'artifact-readable',
    'wrong-tenant-denied',
  ],
  'cloud-browser-actions-takeover-revoke': [
    'real-actions',
    'takeover-stops-ai',
    'revoked-no-side-effect',
  ],
  'local-browser-actions-takeover-revoke': [
    'real-actions',
    'takeover-stops-ai',
    'personal-profile-not-used',
    'revoked-no-side-effect',
  ],
  'preview-reachable-stop-offline-malicious-isolation': [
    'actual-target-reachability',
    'stop-offline-closed',
    'malicious-content-isolated',
  ],
  'cross-tenant-denial': ['api-denied', 'artifact-denied', 'no-side-effects'],
  'policy-revocation-frozen-config-audit': [
    'revocation-effective',
    'running-snapshot-unchanged',
    'audit-linked',
  ],
  'budget-stop-and-unknown-no-replay': [
    'root-budget-enforced',
    'stop-reason-accurate',
    'unknown-not-replayed',
  ],
  'old-bridge-http-wss-and-existing-session': [
    'old-bridge-works',
    'http-wss-no-double-execution',
    'existing-sessions-preserved',
  ],
  'skill-contents-review-next-run-version': [
    'real-resources-pinned',
    'review-required',
    'next-run-loads-approved-version',
  ],
  'workbench-version-feedback-revision-review': [
    'version-bound-feedback',
    'revision-created',
    'new-review-required',
  ],
  'workbench-duplicate-late-events-usage': [
    'no-false-terminal',
    'no-duplicate-usage',
    'refresh-consistent',
  ],
  'assistants-real-dsh-two-children-no-bridge': [
    'real-dsh',
    'two-distinct-children',
    'bridge-absent',
    'results-and-artifacts-collected',
  ],
  'assistants-narrow-permissions-approval': [
    'permission-intersection',
    'exact-approval',
    'no-expansion',
  ],
  'assistants-root-budget-child-tree-cancel': [
    'shared-root-budget',
    'child-cancel-confirmed',
    'whole-tree-cancel-confirmed',
  ],
  'assistants-outbox-checkpoint-cold-recovery': [
    'durable-outbox',
    'cold-recovery',
    'no-duplicate-side-effects',
    'prepared-grant-not-dispatch-proof',
    'dispatch-ack-loss-no-model-replay',
  ],
  'assistants-partial-failure-artifact-conflict-refresh': [
    'partial-failure-visible',
    'conflict-not-overwritten',
    'refresh-traceable',
  ],
  'unreleased-modes-all-entry-denial-single-agent': [
    'ui-denied',
    'language-denied',
    'api-denied',
    'single-agent-preserved',
  ],
  'migration-expand-backfill-compatibility': [
    'old-and-new-reader-compatible',
    'backfill-idempotent-resumable',
    'no-contract-in-first-release',
    'assistant-model-admissions-expand-compatible',
    'nullable-model-cost-readers-compatible',
  ],
  'rollback-drain-reconcile-preserve-state': [
    'drain-confirmed',
    'unknown-reconciled-no-replay',
    'state-preserved',
    'current-credential-reader-preserved',
    'prepared-and-dispatched-model-holds-preserved',
    'model-dispatch-identity-not-replayed',
    'unknown-usage-and-cost-not-zeroed',
  ],
  'dev-final-sha-login-history-downloads-flags-smoke': [
    'deployed-sha-and-build-match',
    'real-login',
    'existing-history-preserved',
    'both-download-hashes-match',
    'flags-remain-off',
  ],
  'developer-id-signature-notarization': [
    'developer-id-valid',
    'notarization-valid',
    'gatekeeper-accepted',
  ],
  'authenticated-update-metadata': [
    'publisher-authenticated',
    'metadata-signature-valid',
    'replay-downgrade-rejected',
  ],
  'fresh-install-gui-pair-workspace': [
    'fresh-install',
    'gui-pair',
    'native-workspace-selection',
  ],
  'restart-without-repair': [
    'normal-launch',
    'restart',
    'pairing-and-directory-preserved',
  ],
  'keychain-save-read-migration': [
    'real-keychain-save',
    'real-keychain-read',
    'migration-preserves-identity',
  ],
  'credential-denial-partial-cleanup': [
    'denial-visible',
    'partial-cleanup-visible',
    'no-credential-exposure',
  ],
  'invalid-signature-and-package-rejection': [
    'invalid-publisher-rejected',
    'corrupt-package-rejected',
    'no-install-side-effect',
  ],
  'update-drain-and-interruption': [
    'active-task-drained',
    'interruption-recovered',
    'unknown-not-replayed',
  ],
  'compatible-rollback-preserves-state': [
    'compatible-reader',
    'pairing-preserved',
    'journal-outbox-preserved',
    'no-forced-repair',
  ],
  'revoke-device-and-directory': [
    'device-revocation-effective',
    'directory-revocation-effective',
    'no-late-side-effect',
  ],
  'local-command-changeset-cancel-isolation': [
    'real-native-architecture',
    'actual-command-exit',
    'changeset-user-changes-preserved',
    'tree-cancel-confirmed',
    'out-of-root-denied',
    'no-cross-architecture-fallback',
  ],
  [CANARY_CASE]: [
    'authorized-single-tenant',
    'exact-version-flags',
    'real-smoke-passed',
    'no-cross-tenant-change',
  ],
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sha = (value) =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const digest = (value) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nonempty = (value) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function parseJson(bytes) {
  const text = bytes.toString('utf8');
  const value = JSON.parse(text);
  // JSON.parse alone silently accepts duplicate keys. Reject ambiguous signed
  // inventories/receipts rather than depending on a reader's first/last wins.
  const stack = [];
  for (const token of text.match(
    /"(?:\\.|[^"\\])*"|[{}[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
  ) ?? []) {
    const top = stack.at(-1);
    if (token === '{') stack.push({ object: true, key: true, seen: new Set() });
    else if (token === '[') stack.push({ object: false });
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && top?.object) top.key = true;
    else if (token.startsWith('"') && top?.object && top.key) {
      const key = JSON.parse(token);
      if (top.seen.has(key)) throw new Error('duplicate-json-key');
      top.seen.add(key);
      top.key = false;
    }
  }
  return value;
}

// Only explicitly named files under the supplied staging root are read. Reject
// links/special files; never recurse into credentials, .env, user data or Keychain.
// The staging root must be owner-controlled and immutable during validation;
// this is not an openat-based hostile-filesystem confinement boundary.
function safePath(root, path) {
  if (
    !nonempty(path) ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path
      .split('/')
      .some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))
  )
    throw new Error('unsafe-path');
  let current = resolve(root);
  const rootParts = current.split('/').filter(Boolean);
  let ancestor = '/';
  for (const part of rootParts) {
    ancestor = join(ancestor, part);
    if (lstatSync(ancestor).isSymbolicLink()) throw new Error('symlink-root');
  }
  for (const part of path.split('/')) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('symlink-path');
  }
  return current;
}

function readSafe(root, path, maxBytes = 8 * 1024 * 1024) {
  const fd = openSync(
    safePath(root, path),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error('not-bounded-regular-file');
    const data = readFileSync(fd);
    if (data.length !== stat.size) throw new Error('file-changed-during-read');
    return data;
  } finally {
    closeSync(fd);
  }
}

function fileDigest(root, path) {
  // Packages are read only, never executed; enforce a per-artifact size bound.
  const fd = openSync(
    safePath(root, path),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('not-regular-file');
    // readFileSync is deliberately bounded: larger releases need a reviewed
    // streaming implementation, not an implicit unbounded allocation.
    if (stat.size > 256 * 1024 * 1024) throw new Error('artifact-too-large');
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size) throw new Error('file-changed-during-read');
    return { sha256: sha256(bytes), bytes: bytes.length };
  } finally {
    closeSync(fd);
  }
}

export function validateRelease({
  manifestPath,
  evidenceRoot,
  sourceRoot,
  expectedSourceSha,
  expectedManifestSha256,
  gate = 'prepare',
  now = Date.now(),
}) {
  const structural = [],
    technical = [],
    authorization = [];
  const add = (bucket, code, field) => bucket.push({ code, field });
  const require = (condition, code, field, bucket = structural) => {
    if (!condition) add(bucket, code, field);
    return condition;
  };
  function keys(value, fields, field, bucket = structural) {
    if (!require(object(value), 'object-required', field, bucket)) return false;
    for (const key of Object.keys(value))
      require(fields.includes(key), 'unknown-field', `${field}.${key}`, bucket);
    for (const key of fields)
      require(Object.hasOwn(
        value,
        key,
      ), 'missing-field', `${field}.${key}`, bucket);
    return true;
  }
  function array(value, field) {
    return require(Array.isArray(value), 'array-required', field);
  }
  function pin(value, field) {
    if (!keys(value, ['path', 'sha256', 'bytes'], field)) return;
    require(digest(value.sha256), 'sha256-required', `${field}.sha256`);
    require(Number.isSafeInteger(value.bytes) &&
      value.bytes > 0, 'positive-byte-count-required', `${field}.bytes`);
    try {
      const observed = fileDigest(evidenceRoot, value.path);
      require(observed.sha256 === value.sha256 &&
        observed.bytes === value.bytes, 'file-integrity-mismatch', field);
    } catch {
      add(structural, 'file-unreadable-or-unsafe', field);
    }
  }
  function fresh(value, field, bucket = technical) {
    const time =
      typeof value === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
        ? Date.parse(value)
        : NaN;
    require(Number.isFinite(time) &&
      new Date(time).toISOString() === value &&
      time <= now &&
      now - time <=
        MAX_EVIDENCE_AGE_MS, 'missing-stale-or-future-timestamp', field, bucket);
  }
  let manifest;
  require(['prepare', 'rc', 'dev', 'tenant', 'prod'].includes(
    gate,
  ), 'unknown-gate', 'gate');
  require(sha(
    expectedSourceSha,
  ), 'trusted-source-pin-required', 'expectedSourceSha');
  require(digest(
    expectedManifestSha256,
  ), 'trusted-manifest-pin-required', 'expectedManifestSha256');
  require(Number.isFinite(now), 'clock-required', 'now');
  try {
    const path = relative(resolve(evidenceRoot), resolve(manifestPath));
    const bytes = readSafe(evidenceRoot, path);
    require(sha256(bytes) ===
      expectedManifestSha256, 'manifest-integrity-mismatch', 'manifest');
    // No artifact/evidence paths are followed when the trust pin is absent/wrong.
    if (structural.length) return result();
    manifest = parseJson(bytes);
  } catch {
    add(structural, 'manifest-unreadable-or-invalid-json', 'manifest');
    return result();
  }
  if (
    !keys(
      manifest,
      [
        'schema',
        'releaseId',
        'sourceSha',
        'baselineSha',
        'createdAt',
        'artifacts',
        'flags',
        'signedClientRequired',
        'clientPublisher',
        'migrations',
        'rollback',
        'evidence',
        'blockers',
        'unsupported',
        'authorizations',
      ],
      'manifest',
    )
  )
    return result();
  require(manifest.schema ===
    'allrice-p28-release/v1', 'unknown-schema', 'schema');
  require(nonempty(manifest.releaseId), 'release-id-required', 'releaseId');
  require(sha(manifest.sourceSha) &&
    manifest.sourceSha === expectedSourceSha &&
    manifest.sourceSha !==
      BASELINE_SHA, 'candidate-source-mismatch-or-b5', 'sourceSha');
  require(manifest.baselineSha ===
    BASELINE_SHA, 'baseline-mismatch', 'baselineSha');
  fresh(manifest.createdAt, 'createdAt', structural);
  require(manifest.signedClientRequired ===
    true, 'signed-client-gate-cannot-be-disabled', 'signedClientRequired');
  if (
    keys(
      manifest.clientPublisher,
      ['teamId', 'bundleId', 'updateKeySha256'],
      'clientPublisher',
    )
  ) {
    require(typeof manifest.clientPublisher.teamId === 'string' &&
      /^[A-Z0-9]{10}$/.test(
        manifest.clientPublisher.teamId,
      ), 'publisher-team-pin-required', 'clientPublisher.teamId', technical);
    require(nonempty(
      manifest.clientPublisher.bundleId,
    ), 'publisher-bundle-pin-required', 'clientPublisher.bundleId', technical);
    require(digest(
      manifest.clientPublisher.updateKeySha256,
    ), 'update-publisher-key-pin-required', 'clientPublisher.updateKeySha256', technical);
  }
  if (keys(manifest.flags, FLAGS, 'flags'))
    for (const name of FLAGS)
      require(manifest.flags[name] ===
        false, 'default-feature-must-remain-off', `flags.${name}`);

  const artifacts = new Map();
  if (array(manifest.artifacts, 'artifacts'))
    for (const [index, artifact] of manifest.artifacts.entries()) {
      const field = `artifacts[${index}]`;
      if (
        !keys(
          artifact,
          ['id', 'sourceSha', 'version', 'buildId', 'file'],
          field,
        )
      )
        continue;
      require(ARTIFACT_IDS.includes(
        artifact.id,
      ), 'unknown-artifact', `${field}.id`);
      require(!artifacts.has(artifact.id), 'duplicate-artifact', `${field}.id`);
      artifacts.set(artifact.id, artifact);
      require(artifact.sourceSha ===
        manifest.sourceSha, 'artifact-source-mismatch', field);
      require(nonempty(artifact.version) &&
        nonempty(artifact.buildId), 'version-and-build-id-required', field);
      pin(artifact.file, `${field}.file`);
    }
  for (const id of ARTIFACT_IDS)
    require(artifacts.has(id), 'missing-artifact', `artifacts.${id}`);
  require(new Set([...artifacts.values()].map((a) => a.file?.path)).size ===
    artifacts.size, 'artifact-paths-must-be-distinct', 'artifacts');
  require(artifacts.get('bridge-arm64')?.version ===
    artifacts.get('bridge-x64')
      ?.version, 'bridge-architecture-version-mismatch', 'artifacts');

  // A supplied checkout is only an inventory input, not proof of a clean Git
  // tree. The source/build provenance receipt must prove that relationship.
  try {
    for (const [id, path] of [
      ['lockfile', 'pnpm-lock.yaml'],
      ['dsh-upstream', 'apps/worker/dsh/upstream.json'],
    ]) {
      require(sha256(readSafe(sourceRoot, path)) ===
        artifacts.get(id)?.file?.sha256, 'checkout-pin-mismatch', path);
    }
    const migrationDir = safePath(sourceRoot, 'packages/database/migrations');
    const names = readdirSync(migrationDir)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    const old = names.filter(
      (name) => /^\d{4}_/.test(name) && Number(name.slice(0, 4)) <= 92,
    );
    const rows = old.map((name) => [
      name,
      sha256(readSafe(sourceRoot, `packages/database/migrations/${name}`)),
    ]);
    require(sha256(JSON.stringify(rows)) ===
      BASELINE_MIGRATIONS_SHA256, 'baseline-migration-history-changed', 'migrations');
    if (
      keys(
        manifest.migrations,
        ['changes', 'contractDeferred', 'backfillPolicy'],
        'migrations',
      )
    ) {
      require(manifest.migrations.contractDeferred ===
        true, 'contract-must-be-separate-later-release', 'migrations.contractDeferred');
      require(manifest.migrations.backfillPolicy ===
        'idempotent-bounded-resumable-separate-approval', 'unsafe-backfill-policy', 'migrations.backfillPolicy');
      if (array(manifest.migrations.changes, 'migrations.changes')) {
        const changes = new Map();
        for (const [
          index,
          migration,
        ] of manifest.migrations.changes.entries()) {
          const field = `migrations.changes[${index}]`;
          if (!keys(migration, ['name', 'sha256', 'phase'], field)) continue;
          require(!changes.has(migration.name), 'duplicate-migration', field);
          changes.set(migration.name, migration);
          require(/^\d{4}_[a-z0-9_]+\.sql$/.test(
            migration.name,
          ), 'migration-name-invalid', field);
          require(digest(migration.sha256), 'sha256-required', field);
          require(['expand', 'backfill'].includes(
            migration.phase,
          ), 'contract-or-unknown-phase-rejected', field);
        }
        const added = names.filter((name) => !old.includes(name));
        require(same(
          [...changes.keys()].sort(),
          added,
        ), 'migration-inventory-incomplete-or-extra', 'migrations.changes');
        for (const name of added)
          require(changes.get(name)?.sha256 ===
            sha256(
              readSafe(sourceRoot, `packages/database/migrations/${name}`),
            ), 'migration-content-mismatch', `migrations.${name}`);
      }
    }
  } catch {
    add(structural, 'source-inventory-unreadable-or-unsafe', 'sourceRoot');
  }

  const rollback = manifest.rollback;
  if (
    keys(
      rollback,
      [
        'mode',
        'reason',
        'targetSourceSha',
        'targetReleaseId',
        'targetArtifacts',
        'database',
        'credentials',
        'drain',
        'preserve',
        'backup',
      ],
      'rollback',
    )
  ) {
    require(['compatible-redeploy', 'forward-fix-only'].includes(
      rollback.mode,
    ), 'unknown-rollback-mode', 'rollback.mode');
    require(nonempty(
      rollback.reason,
    ), 'rollback-risk-reason-required', 'rollback.reason');
    require(rollback.database ===
      'no-down-migration', 'destructive-database-rollback-forbidden', 'rollback.database');
    require(rollback.credentials ===
      'current-or-newer-reader-no-repair', 'old-credential-reader-forbidden', 'rollback.credentials');
    require(rollback.drain ===
      'reconcile-unknown-never-blind-replay', 'unsafe-drain-policy', 'rollback.drain');
    require(rollback.backup ===
      'separate-authorization-required-not-taken-by-validator', 'backup-authority-must-be-separate', 'rollback.backup');
    require(Array.isArray(rollback.preserve) &&
      same(
        [...rollback.preserve].sort(),
        [...PRESERVED_STATE].sort(),
      ), 'preservation-scope-incomplete', 'rollback.preserve');
    if (array(rollback.targetArtifacts, 'rollback.targetArtifacts')) {
      for (const [index, entry] of rollback.targetArtifacts.entries()) {
        const field = `rollback.targetArtifacts[${index}]`;
        if (
          !keys(entry, ['id', 'sourceSha', 'version', 'buildId', 'file'], field)
        )
          continue;
        require(entry.sourceSha === rollback.targetSourceSha &&
          nonempty(entry.version) &&
          nonempty(entry.buildId), 'rollback-artifact-pin-mismatch', field);
        pin(entry.file, `${field}.file`);
      }
      if (rollback.mode === 'compatible-redeploy') {
        require(sha(rollback.targetSourceSha) &&
          rollback.targetSourceSha !== manifest.sourceSha &&
          nonempty(
            rollback.targetReleaseId,
          ), 'rollback-target-pin-required', 'rollback');
        require(same(
          rollback.targetArtifacts.map((a) => a?.id).sort(),
          ['bridge-arm64', 'bridge-x64', 'web', 'worker'].sort(),
        ), 'rollback-target-artifacts-incomplete', 'rollback.targetArtifacts');
      } else
        require(rollback.targetSourceSha === null &&
          rollback.targetReleaseId === null &&
          rollback.targetArtifacts.length ===
            0, 'forward-fix-not-an-unverified-old-redeploy', 'rollback');
    }
  }

  if (array(manifest.blockers, 'blockers'))
    for (const [index, blocker] of manifest.blockers.entries()) {
      if (keys(blocker, ['id', 'reason', 'owner'], `blockers[${index}]`))
        require(nonempty(blocker.id) &&
          nonempty(blocker.reason) &&
          nonempty(
            blocker.owner,
          ), 'blocker-details-required', `blockers[${index}]`);
      add(technical, 'declared-open-blocker', `blockers[${index}]`);
    }
  if (array(manifest.unsupported, 'unsupported'))
    for (const [index, item] of manifest.unsupported.entries()) {
      if (!keys(item, ['scope', 'reason', 'followup'], `unsupported[${index}]`))
        continue;
      require(nonempty(item.scope) &&
        nonempty(item.reason) &&
        nonempty(
          item.followup,
        ), 'unsupported-details-required', `unsupported[${index}]`);
      require(!REQUIRED_CASES.includes(
        item.scope,
      ), 'required-ga-case-cannot-be-exempted', `unsupported[${index}]`);
    }

  const seen = new Set(),
    devices = new Map();
  if (array(manifest.evidence, 'evidence'))
    for (const [index, entry] of manifest.evidence.entries()) {
      const field = `evidence[${index}]`;
      if (!keys(entry, ['caseId', 'file'], field)) continue;
      require([...REQUIRED_CASES, CANARY_CASE].includes(
        entry.caseId,
      ), 'unknown-evidence-case', `${field}.caseId`, technical);
      require(!seen.has(
        entry.caseId,
      ), 'duplicate-evidence-case', `${field}.caseId`, technical);
      seen.add(entry.caseId);
      pin(entry.file, `${field}.file`);
      try {
        const receipt = parseJson(readSafe(evidenceRoot, entry.file.path));
        if (
          !keys(
            receipt,
            [
              'schema',
              'caseId',
              'sourceSha',
              'status',
              'execution',
              'observedAt',
              'environment',
              'tenantId',
              'runId',
              'command',
              'artifacts',
              'flagSnapshot',
              'assertions',
              'attachments',
              'device',
            ],
            `${field}.receipt`,
            technical,
          )
        )
          continue;
        require(receipt.schema === 'allrice-p27-evidence/v1' &&
          receipt.caseId ===
            entry.caseId, 'evidence-schema-or-case-mismatch', field, technical);
        require(receipt.sourceSha ===
          manifest.sourceSha, 'evidence-source-mismatch', field, technical);
        require(receipt.status === 'passed' &&
          receipt.execution ===
            'real-execution', 'evidence-not-real-passed', field, technical);
        fresh(receipt.observedAt, `${field}.observedAt`);
        require(nonempty(receipt.tenantId) &&
          nonempty(receipt.runId) &&
          nonempty(
            receipt.command,
          ), 'evidence-execution-context-required', field, technical);
        const isClient = entry.caseId.startsWith('client/');
        const environment = isClient
          ? 'physical-macos'
          : entry.caseId === CANARY_CASE
            ? 'tenant'
            : entry.caseId.startsWith('dev-')
              ? 'dev'
              : 'isolated';
        require(receipt.environment ===
          environment, 'wrong-evidence-environment', field, technical);
        const needed = isClient
          ? ['source', `bridge-${entry.caseId.split('/')[1]}`]
          : [...ARTIFACT_IDS];
        const bound = new Map(
          [...artifacts].map(([id, artifact]) => [id, artifact.file?.sha256]),
        );
        if (
          entry.caseId.includes('rollback') &&
          rollback?.mode === 'compatible-redeploy'
        )
          for (const artifact of Array.isArray(rollback.targetArtifacts)
            ? rollback.targetArtifacts
            : []) {
            if (!object(artifact)) continue;
            const id = `rollback/${artifact.id}`;
            needed.push(id);
            bound.set(id, artifact.file?.sha256);
          }
        if (keys(receipt.artifacts, needed, `${field}.artifacts`, technical))
          for (const id of needed)
            require(receipt.artifacts[id] ===
              bound.get(
                id,
              ), 'evidence-artifact-mismatch', `${field}.${id}`, technical);
        if (
          keys(receipt.flagSnapshot, FLAGS, `${field}.flagSnapshot`, technical)
        ) {
          for (const name of FLAGS)
            require(typeof receipt.flagSnapshot[name] ===
              'boolean', 'actual-flag-snapshot-required', `${field}.${name}`, technical);
          if (environment === 'dev')
            for (const name of FLAGS)
              require(receipt.flagSnapshot[name] ===
                manifest.flags?.[
                  name
                ], 'dev-flag-snapshot-mismatch', `${field}.${name}`, technical);
          if (entry.caseId.startsWith('assistants-'))
            require(receipt.flagSnapshot.ALLRICE_ASSISTANTS_ENABLED ===
              true, 'assistant-evidence-needs-isolated-enabled-path', field, technical);
          if (entry.caseId === CANARY_CASE)
            for (const name of FLAGS)
              require(receipt.flagSnapshot[name] ===
                (manifest.authorizations?.tenant?.enableFlags?.includes(name) ??
                  false), 'canary-flag-snapshot-mismatch', `${field}.${name}`, technical);
        }
        require(Array.isArray(receipt.assertions) &&
          receipt.assertions.length >
            0, 'evidence-assertions-required', field, technical);
        const caseName = isClient ? entry.caseId.split('/')[2] : entry.caseId;
        const expectedAssertions = Object.fromEntries(
          (CASE_ASSERTIONS[caseName] ?? []).map((name) => [name, true]),
        );
        if (caseName === 'developer-id-signature-notarization') {
          expectedAssertions['publisher-team-id'] =
            manifest.clientPublisher?.teamId;
          expectedAssertions['publisher-bundle-id'] =
            manifest.clientPublisher?.bundleId;
        }
        if (caseName === 'authenticated-update-metadata')
          expectedAssertions['update-key-sha256'] =
            manifest.clientPublisher?.updateKeySha256;
        require(Array.isArray(receipt.assertions) &&
          same(
            receipt.assertions.map((a) => a?.name).sort(),
            Object.keys(expectedAssertions).sort(),
          ), 'assertion-coverage-missing-duplicate-or-unknown', field, technical);
        for (const [i, assertion] of (Array.isArray(receipt.assertions)
          ? receipt.assertions
          : []
        ).entries()) {
          if (
            !keys(
              assertion,
              ['name', 'expected', 'observed'],
              `${field}.assertions[${i}]`,
              technical,
            )
          )
            continue;
          const scalar = (value) =>
            typeof value === 'boolean' ||
            typeof value === 'string' ||
            (typeof value === 'number' && Number.isFinite(value));
          require(nonempty(assertion.name) &&
            scalar(assertion.expected) &&
            scalar(assertion.observed) &&
            assertion.expected === assertion.observed &&
            assertion.expected ===
              expectedAssertions[
                assertion.name
              ], 'assertion-failed-or-incomplete', `${field}.assertions[${i}]`, technical);
        }
        require(Array.isArray(receipt.attachments) &&
          receipt.attachments.length >
            0, 'raw-observation-attachment-required', field, technical);
        for (const [i, attachment] of (Array.isArray(receipt.attachments)
          ? receipt.attachments
          : []
        ).entries())
          pin(attachment, `${field}.attachments[${i}]`);
        if (isClient) {
          const arch = entry.caseId.split('/')[1];
          if (
            keys(
              receipt.device,
              ['id', 'architecture', 'osVersion', 'physical'],
              `${field}.device`,
              technical,
            )
          ) {
            require(receipt.device.physical === true &&
              receipt.device.architecture === arch &&
              nonempty(receipt.device.id) &&
              nonempty(
                receipt.device.osVersion,
              ), 'physical-device-evidence-required', field, technical);
            if (devices.has(arch))
              require(devices.get(arch) ===
                receipt.device
                  .id, 'device-identity-mismatch-within-architecture', field, technical);
            devices.set(arch, receipt.device.id);
          }
        } else
          require(receipt.device ===
            null, 'unexpected-device', field, technical);
        if (entry.caseId === CANARY_CASE)
          require(manifest.authorizations?.tenant?.tenantIds?.includes(
            receipt.tenantId,
          ), 'canary-evidence-tenant-mismatch', field, technical);
      } catch {
        add(technical, 'evidence-unreadable-or-invalid-json', field);
      }
    }
  for (const id of REQUIRED_CASES)
    require(seen.has(id), 'missing-required-evidence', id, technical);
  if (gate === 'prod')
    require(seen.has(
      CANARY_CASE,
    ), 'missing-required-evidence', CANARY_CASE, technical);
  if (devices.has('arm64') && devices.has('x64'))
    require(devices.get('arm64') !==
      devices.get(
        'x64',
      ), 'two-distinct-physical-devices-required', 'devices', technical);

  if (
    keys(manifest.authorizations, ['dev', 'tenant', 'prod'], 'authorizations')
  ) {
    for (const scope of ['dev', 'tenant', 'prod']) {
      const auth = manifest.authorizations[scope];
      if (auth === null) {
        if (gate === scope || (gate === 'prod' && scope === 'tenant'))
          add(
            authorization,
            'separate-authorization-missing',
            `authorizations.${scope}`,
          );
        continue;
      }
      const field = `authorizations.${scope}`;
      if (
        !keys(
          auth,
          [
            'scope',
            'sourceSha',
            'releaseId',
            'approver',
            'record',
            'recordSha256',
            'grantedAt',
            'expiresAt',
            'tenantIds',
            'enableFlags',
            'migrationNames',
            'rollbackMode',
          ],
          field,
        )
      )
        continue;
      require(auth.scope === scope &&
        auth.sourceSha === manifest.sourceSha &&
        auth.releaseId ===
          manifest.releaseId, 'authorization-scope-or-version-mismatch', field, authorization);
      require(nonempty(auth.approver) &&
        nonempty(auth.record) &&
        digest(
          auth.recordSha256,
        ), 'authorization-record-required', field, authorization);
      fresh(auth.grantedAt, `${field}.grantedAt`, authorization);
      const expires = Date.parse(auth.expiresAt);
      require(Number.isFinite(expires) &&
        expires > now &&
        expires >
          Date.parse(
            auth.grantedAt,
          ), 'authorization-expired-or-invalid', field, authorization);
      require(Array.isArray(auth.tenantIds) &&
        auth.tenantIds.length > 0 &&
        auth.tenantIds.every((id) => nonempty(id) && id !== '*') &&
        new Set(auth.tenantIds).size ===
          auth.tenantIds
            .length, 'explicit-tenant-scope-required', field, authorization);
      if (scope === 'tenant')
        require(auth.tenantIds?.length ===
          1, 'canary-exactly-one-tenant-required', field, authorization);
      require(Array.isArray(auth.enableFlags) &&
        new Set(auth.enableFlags).size === auth.enableFlags.length &&
        auth.enableFlags.every((name) =>
          FLAGS.includes(name),
        ), 'unknown-or-duplicate-authorized-flags', field, authorization);
      if (scope === 'dev')
        require(auth.enableFlags?.length ===
          0, 'dev-deploy-does-not-authorize-tenant-enablement', field, authorization);
      require(Array.isArray(auth.migrationNames) &&
        Array.isArray(manifest.migrations?.changes) &&
        same(
          [...auth.migrationNames].sort(),
          manifest.migrations.changes.map((x) => x?.name).sort(),
        ), 'authorization-migration-scope-mismatch', field, authorization);
      require(auth.rollbackMode ===
        rollback?.mode, 'authorization-rollback-scope-mismatch', field, authorization);
      try {
        require(sha256(readSafe(evidenceRoot, auth.record)) ===
          auth.recordSha256, 'authorization-record-integrity-mismatch', field, authorization);
      } catch {
        add(authorization, 'authorization-record-unreadable-or-unsafe', field);
      }
    }
  }
  return result();

  function result() {
    // Dev preflight cannot require its own future post-deploy smoke receipt.
    // That missing receipt still blocks RC and remains visible in the report.
    const applicableTechnical =
      gate === 'dev'
        ? technical.filter(
            (item) =>
              !(
                item.code === 'missing-required-evidence' &&
                item.field ===
                  'dev-final-sha-login-history-downloads-flags-smoke'
              ),
          )
        : technical;
    const blockers = [
      ...structural,
      ...(gate === 'prepare' ? [] : applicableTechnical),
      ...(gate === 'prepare' || gate === 'rc' ? [] : authorization),
    ];
    return {
      schema: 'allrice-p28-readiness-report/v1',
      gate,
      scope:
        'read-only-manifest-integrity-and-declared-evidence-completeness-only',
      passed: blockers.length === 0,
      preparationVerified: structural.length === 0,
      technicalEvidenceComplete:
        structural.length === 0 &&
        technical.length === 0 &&
        manifest !== undefined,
      deploymentExecuted: false,
      migrationExecuted: false,
      flagsChanged: false,
      authorizationGranted: false,
      gaDeclared: false,
      blockers,
      technicalBlockers: technical,
      authorizationBlockers: authorization,
    };
  }
}

export function main(args = process.argv.slice(2)) {
  const allowed = [
    '--manifest',
    '--evidence-root',
    '--source-root',
    '--source-sha',
    '--manifest-sha256',
    '--gate',
  ];
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || !args[i + 1] || options.has(args[i]))
      throw new Error(
        'Use each required option exactly once: --manifest --evidence-root --source-root --source-sha --manifest-sha256 --gate',
      );
    options.set(args[i], args[i + 1]);
  }
  if (allowed.some((key) => !options.has(key)))
    throw new Error(
      'All six explicit options are required; ambient environment is never read.',
    );
  const report = validateRelease({
    manifestPath: options.get('--manifest'),
    evidenceRoot: options.get('--evidence-root'),
    sourceRoot: options.get('--source-root'),
    expectedSourceSha: options.get('--source-sha'),
    expectedManifestSha256: options.get('--manifest-sha256'),
    gate: options.get('--gate'),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.passed ? 0 : 2;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main();
  } catch {
    process.stderr.write(
      'P28 validation refused: malformed options or input. No actions executed.\n',
    );
    process.exitCode = 2;
  }
}
