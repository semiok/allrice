// MET-148: internal declared evidence completeness, NEVER release authority.
// Does not collect observations, execute tests, contact Apple, install or deploy.
import { isAbsolute, relative, resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACT_IDS,
  ASSISTANT_BILLING_ASSERTIONS,
  CASE_ASSERTIONS,
  FLAGS,
  MAX_EVIDENCE_AGE_MS,
  REQUIRED_CASES,
  validateRelease,
} from './p28-release-readiness.mjs';
import { validSubscriptionEvidence } from './p28-subscription-evidence.mjs';
import {
  digest,
  hash,
  object,
  parseJson,
  readSafe,
  safeDirectory,
  safeFile,
  sha,
  text,
} from './internal-evidence-io.mjs';

const BILLING_CASE = 'assistants-real-dsh-two-children-no-bridge';
const EXTERNAL = Object.freeze({
  'developer-id-signature-notarization': Object.freeze([
    'developer-id-valid',
    'notarization-valid',
    'gatekeeper-accepted',
    'publisher-team-id',
    'publisher-bundle-id',
  ]),
  'authenticated-update-metadata': Object.freeze([
    'publisher-authenticated',
    'metadata-signature-valid',
    'update-key-sha256',
  ]),
});
// Fixed code policy, not a user-editable waiver or a drop-list of failing cases.
export const INTERNAL_MATRIX = Object.freeze(
  REQUIRED_CASES.map((caseId) => {
    const client = caseId.startsWith('client/');
    const name = client ? caseId.split('/')[2] : caseId;
    const externalAssertions = [...(client ? (EXTERNAL[name] ?? []) : [])];
    return Object.freeze({
      caseId,
      internalAssertions: Object.freeze(
        CASE_ASSERTIONS[name].filter((a) => !externalAssertions.includes(a)),
      ),
      externalAssertions: Object.freeze(externalAssertions),
      methods: Object.freeze(
        client &&
          [
            'authenticated-update-metadata',
            'invalid-signature-and-package-rejection',
          ].includes(name)
          ? ['real-end-to-end', 'physical-component']
          : ['real-end-to-end'],
      ),
    });
  }),
);

export function validateInternalReadiness({
  manifestPath,
  evidenceRoot,
  sourceRoot,
  expectedSourceSha,
  expectedManifestSha256,
  now = Date.now(),
}) {
  const internalBlockers = [],
    notApplicable = [],
    methodsObserved = [];
  let preparationReport = null;
  const add = (code, path) => internalBlockers.push({ code, path });
  const require = (condition, code, path) => {
    if (!condition) add(code, path);
    return Boolean(condition);
  };
  function keys(value, fields, path) {
    if (!require(object(value), 'object-required', path)) return false;
    let valid = true;
    for (const key of Object.keys(value))
      valid =
        require(fields.includes(key), 'unknown-field', `${path}.${key}`) &&
        valid;
    for (const key of fields)
      valid =
        require(Object.hasOwn(value, key), 'missing-field', `${path}.${key}`) &&
        valid;
    return valid;
  }
  function fresh(value, path) {
    const time =
      typeof value === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
        ? Date.parse(value)
        : NaN;
    return require(Number.isFinite(time) &&
      new Date(time).toISOString() === value &&
      time <= now &&
      now - time <=
        MAX_EVIDENCE_AGE_MS, 'missing-stale-or-future-timestamp', path);
  }
  function pinned(value, path) {
    if (!keys(value, ['path', 'sha256', 'bytes'], path)) return null;
    if (
      !require(digest(value.sha256) &&
        Number.isSafeInteger(value.bytes) &&
        value.bytes > 0, 'invalid-file-pin', path)
    )
      return null;
    try {
      const bytes = readSafe(evidenceRoot, value.path);
      if (
        !require(hash(bytes) === value.sha256 &&
          bytes.length === value.bytes, 'file-integrity-mismatch', path)
      )
        return null;
      return bytes;
    } catch {
      add('file-unreadable-or-unsafe', path);
      return null;
    }
  }
  function pinnedJson(value, path) {
    const bytes = pinned(value, path);
    if (!bytes) return null;
    try {
      return parseJson(bytes);
    } catch {
      add('invalid-or-duplicate-key-json', path);
      return null;
    }
  }
  function result() {
    return {
      schema: 'allrice-p27-internal-readiness-report/v1',
      scope:
        'read-only-internal-declared-evidence-completeness-not-release-authority',
      internalReady: internalBlockers.length === 0,
      internalBlockers,
      externalDistributionPending: INTERNAL_MATRIX.filter(
        (c) => c.externalAssertions.length,
      ).map((c) => ({
        caseId: c.caseId,
        assertions: [...c.externalAssertions],
        issue: 'MET-143',
        status: 'pending',
      })),
      // Keep the ORIGINAL prepare report, including every formal missing receipt.
      // These are not silently reclassified as signing gaps or used as approvals.
      preparationReport,
      coverage: INTERNAL_MATRIX,
      billingAlternatives: ASSISTANT_BILLING_ASSERTIONS,
      notApplicable,
      methodsObserved,
      signedPackageRevalidationRequired: true,
      releaseEligible: false,
      formalReadiness: false,
      signedDistributionReady: false,
      authorizationGranted: false,
      deploymentExecuted: false,
      migrationExecuted: false,
      flagsChanged: false,
      gaDeclared: false,
    };
  }

  require(sha(
    expectedSourceSha,
  ), 'trusted-source-pin-required', 'expectedSourceSha');
  require(digest(
    expectedManifestSha256,
  ), 'trusted-manifest-pin-required', 'expectedManifestSha256');
  require(Number.isFinite(now), 'clock-required', 'now');
  for (const [key, value] of Object.entries({
    manifestPath,
    evidenceRoot,
    sourceRoot,
  }))
    require(text(value) && isAbsolute(value), 'absolute-path-required', key);
  if (internalBlockers.length) return result();
  let manifest;
  try {
    const bytes = readSafe(
      evidenceRoot,
      relative(resolve(evidenceRoot), resolve(manifestPath)),
    );
    if (
      !require(hash(bytes) ===
        expectedManifestSha256, 'manifest-integrity-mismatch', 'manifest')
    )
      return result();
    manifest = parseJson(bytes);
  } catch {
    add('manifest-unreadable-or-invalid-json', 'manifest');
    return result();
  }
  if (
    !keys(
      manifest,
      [
        'schema',
        'acceptanceId',
        'sourceSha',
        'createdAt',
        'preparation',
        'evidence',
        'blockers',
      ],
      'manifest',
    )
  )
    return result();
  require(manifest.schema ===
    'allrice-p27-internal-readiness/v1', 'unknown-schema', 'schema');
  require(text(
    manifest.acceptanceId,
  ), 'acceptance-id-required', 'acceptanceId');
  require(manifest.sourceSha ===
    expectedSourceSha, 'candidate-source-mismatch', 'sourceSha');
  fresh(manifest.createdAt, 'createdAt');
  require(Array.isArray(manifest.evidence), 'array-required', 'evidence');
  require(Array.isArray(manifest.blockers), 'array-required', 'blockers');
  if (internalBlockers.length) return result();
  for (const [i, item] of manifest.blockers.entries()) {
    keys(item, ['id', 'reason', 'owner'], `blockers[${i}]`);
    require(object(item) &&
      ['id', 'reason', 'owner'].every((k) =>
        text(item[k]),
      ), 'invalid-declared-blocker', `blockers[${i}]`);
    add('declared-internal-blocker', `blockers[${i}]`);
  }

  const prep = pinnedJson(manifest.preparation, 'preparation');
  if (!object(prep)) {
    add('preparation-manifest-required', 'preparation');
    return result();
  }
  // Separate inventories from evidence/authorization. Nothing is copied into,
  // erased from, or forged on behalf of a formal manifest by this checker.
  for (const key of ['evidence', 'blockers', 'unsupported'])
    require(Array.isArray(prep[key]) &&
      prep[key].length ===
        0, 'preparation-inventory-only-required', `preparation.${key}`);
  if (
    keys(
      prep.authorizations,
      ['dev', 'tenant', 'prod'],
      'preparation.authorizations',
    )
  )
    for (const scope of ['dev', 'tenant', 'prod'])
      require(prep.authorizations[scope] ===
        null, 'preparation-must-not-carry-authorization', `preparation.authorizations.${scope}`);
  // Null means honestly pending; malformed non-null publisher pins are errors.
  if (
    keys(
      prep.clientPublisher,
      ['teamId', 'bundleId', 'updateKeySha256'],
      'preparation.clientPublisher',
    )
  ) {
    const p = prep.clientPublisher;
    require(p.teamId === null ||
      (typeof p.teamId === 'string' &&
        /^[A-Z0-9]{10}$/.test(
          p.teamId,
        )), 'invalid-publisher-pin', 'preparation.clientPublisher.teamId');
    require(p.bundleId === null ||
      text(
        p.bundleId,
      ), 'invalid-publisher-pin', 'preparation.clientPublisher.bundleId');
    require(p.updateKeySha256 === null ||
      digest(
        p.updateKeySha256,
      ), 'invalid-publisher-pin', 'preparation.clientPublisher.updateKeySha256');
  }
  // Preflight regular-file types before composing the unchanged P28 reader.
  // This also avoids blocking on named pipes in malformed preparations.
  for (const artifact of [
    ...(Array.isArray(prep.artifacts) ? prep.artifacts : []),
    ...(Array.isArray(prep.rollback?.targetArtifacts)
      ? prep.rollback.targetArtifacts
      : []),
  ]) {
    try {
      safeFile(evidenceRoot, artifact?.file?.path, 256 * 1024 * 1024);
    } catch {
      add('file-unreadable-or-unsafe', 'preparation.artifacts');
    }
  }
  if (internalBlockers.length) return result();
  try {
    for (const path of ['pnpm-lock.yaml', 'apps/worker/dsh/upstream.json'])
      safeFile(sourceRoot, path);
    const migrationDirectory = 'packages/database/migrations';
    for (const name of readdirSync(
      safeDirectory(sourceRoot, migrationDirectory),
    ))
      if (name.endsWith('.sql'))
        safeFile(sourceRoot, `${migrationDirectory}/${name}`);
    preparationReport = validateRelease({
      manifestPath: resolve(evidenceRoot, manifest.preparation.path),
      evidenceRoot,
      sourceRoot,
      expectedSourceSha,
      expectedManifestSha256: manifest.preparation.sha256,
      now,
      gate: 'prepare',
    });
    for (const blocker of preparationReport.blockers)
      add(blocker.code, `preparation.${blocker.field}`);
    require(preparationReport.preparationVerified ===
      true, 'preparation-not-verified', 'preparation');
  } catch {
    add('preparation-validation-failed', 'preparation');
  }
  if (internalBlockers.length) return result();

  const seen = new Set(),
    devices = new Map();
  const cases = new Map(INTERNAL_MATRIX.map((c) => [c.caseId, c]));
  for (const [index, entry] of manifest.evidence.entries()) {
    const field = `evidence[${index}]`;
    if (!keys(entry, ['caseId', 'file'], field)) continue;
    const row = cases.get(entry.caseId);
    if (
      !require(row?.internalAssertions.length > 0 &&
        !seen.has(entry.caseId), 'unknown-external-or-duplicate-case', field)
    )
      continue;
    seen.add(entry.caseId);
    const receipt = pinnedJson(entry.file, `${field}.file`);
    if (
      !keys(
        receipt,
        [
          'schema',
          'caseId',
          'sourceSha',
          'status',
          'execution',
          'method',
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
          'billing',
        ],
        `${field}.receipt`,
      )
    )
      continue;
    require(receipt.schema === 'allrice-p27-internal-evidence/v1' &&
      receipt.caseId ===
        entry.caseId, 'evidence-schema-or-case-mismatch', field);
    require(receipt.sourceSha ===
      manifest.sourceSha, 'evidence-source-mismatch', field);
    require(receipt.status === 'passed' &&
      receipt.execution ===
        'real-execution', 'evidence-not-real-passed', field);
    require(row.methods.includes(
      receipt.method,
    ), 'insufficient-or-unknown-evidence-method', field);
    methodsObserved.push({ caseId: entry.caseId, method: receipt.method });
    fresh(receipt.observedAt, `${field}.observedAt`);
    require(text(receipt.tenantId) &&
      text(receipt.runId) &&
      text(receipt.command), 'execution-context-required', field);
    const client = entry.caseId.startsWith('client/'),
      arch = entry.caseId.split('/')[1];
    const environment = client
      ? 'physical-macos'
      : entry.caseId.startsWith('dev-')
        ? 'dev'
        : 'isolated';
    require(receipt.environment ===
      environment, 'wrong-evidence-environment', field);
    const needed = client ? ['source', `bridge-${arch}`] : [...ARTIFACT_IDS];
    const bound = new Map(prep.artifacts.map((a) => [a.id, a.file.sha256]));
    if (
      entry.caseId.includes('rollback') &&
      prep.rollback.mode === 'compatible-redeploy'
    )
      for (const artifact of prep.rollback.targetArtifacts) {
        needed.push(`rollback/${artifact.id}`);
        bound.set(`rollback/${artifact.id}`, artifact.file.sha256);
      }
    if (keys(receipt.artifacts, needed, `${field}.artifacts`))
      for (const id of needed)
        require(receipt.artifacts[id] ===
          bound.get(
            id,
          ), 'evidence-artifact-mismatch', `${field}.artifacts.${id}`);
    if (keys(receipt.flagSnapshot, FLAGS, `${field}.flagSnapshot`)) {
      for (const name of FLAGS) {
        require(typeof receipt.flagSnapshot[name] ===
          'boolean', 'actual-flag-snapshot-required', `${field}.${name}`);
        if (environment === 'dev')
          require(receipt.flagSnapshot[name] ===
            prep.flags[name], 'dev-flag-snapshot-mismatch', `${field}.${name}`);
      }
      if (entry.caseId.startsWith('assistants-'))
        require(receipt.flagSnapshot.ALLRICE_ASSISTANTS_ENABLED ===
          true, 'assistant-evidence-needs-isolated-enabled-path', field);
    }
    const expectedAssertions = [...row.internalAssertions];
    if (entry.caseId === BILLING_CASE) {
      const mode = receipt.billing?.mode;
      if (
        require(typeof mode === 'string' &&
          Object.hasOwn(
            ASSISTANT_BILLING_ASSERTIONS,
            mode ?? '',
          ), 'assistant-billing-mode-required', field)
      ) {
        expectedAssertions.push(...ASSISTANT_BILLING_ASSERTIONS[mode]);
        if (
          keys(
            receipt.billing,
            mode === 'subscription' ? ['mode', 'proof'] : ['mode'],
            `${field}.billing`,
          )
        ) {
          if (mode === 'subscription') {
            const proof = pinnedJson(
              receipt.billing.proof,
              `${field}.billing.proof`,
            );
            require(validSubscriptionEvidence(
              proof,
              receipt,
            ), 'subscription-accounting-proof-invalid', field);
          }
          notApplicable.push({
            caseId: entry.caseId,
            assertions: [
              ...ASSISTANT_BILLING_ASSERTIONS[
                mode === 'subscription' ? 'token_metered' : 'subscription'
              ],
            ],
            reason: `Explicit ${mode} accounting branch; the other branch is not claimed tested.`,
          });
        }
      }
    } else require(receipt.billing === null, 'unexpected-billing-proof', field);
    require(Array.isArray(receipt.assertions) &&
      JSON.stringify(receipt.assertions.map((a) => a?.name).sort()) ===
        JSON.stringify(
          [...expectedAssertions].sort(),
        ), 'assertion-coverage-missing-duplicate-or-unknown', field);
    for (const [i, assertion] of (Array.isArray(receipt.assertions)
      ? receipt.assertions
      : []
    ).entries())
      if (
        keys(
          assertion,
          ['name', 'expected', 'observed'],
          `${field}.assertions[${i}]`,
        )
      )
        require(expectedAssertions.includes(assertion.name) &&
          assertion.expected === true &&
          assertion.observed ===
            true, 'assertion-failed-or-incomplete', `${field}.assertions[${i}]`);
    require(Array.isArray(receipt.attachments) &&
      receipt.attachments.length >
        0, 'raw-observation-attachment-required', field);
    for (const [i, attachment] of (Array.isArray(receipt.attachments)
      ? receipt.attachments
      : []
    ).entries())
      pinned(attachment, `${field}.attachments[${i}]`);
    if (client) {
      if (
        keys(
          receipt.device,
          ['id', 'architecture', 'osVersion', 'physical'],
          `${field}.device`,
        )
      ) {
        require(receipt.device.physical === true &&
          receipt.device.architecture === arch &&
          text(receipt.device.id) &&
          text(
            receipt.device.osVersion,
          ), 'physical-device-evidence-required', field);
        if (devices.has(arch))
          require(devices.get(arch) ===
            receipt.device
              .id, 'device-identity-mismatch-within-architecture', field);
        devices.set(arch, receipt.device.id);
      }
    } else require(receipt.device === null, 'unexpected-device', field);
  }
  for (const row of INTERNAL_MATRIX)
    if (row.internalAssertions.length)
      require(seen.has(
        row.caseId,
      ), 'missing-required-internal-evidence', row.caseId);
  require(devices.has('arm64') &&
    devices.has('x64') &&
    devices.get('arm64') !==
      devices.get('x64'), 'two-distinct-physical-devices-required', 'devices');
  return result();
}

export function main(args = process.argv.slice(2)) {
  const allowed = [
    '--manifest',
    '--evidence-root',
    '--source-root',
    '--source-sha',
    '--manifest-sha256',
  ];
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || !args[i + 1] || options.has(args[i]))
      throw new Error(`Use each explicit option once: ${allowed.join(' ')}`);
    options.set(args[i], args[i + 1]);
  }
  if (allowed.some((key) => !options.has(key)))
    throw new Error(
      'All five explicit options required; no ambient environment or release gate.',
    );
  const report = validateInternalReadiness({
    manifestPath: options.get('--manifest'),
    evidenceRoot: options.get('--evidence-root'),
    sourceRoot: options.get('--source-root'),
    expectedSourceSha: options.get('--source-sha'),
    expectedManifestSha256: options.get('--manifest-sha256'),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.internalReady ? 0 : 2;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main();
  } catch {
    process.stderr.write(
      'Internal validation refused: malformed options or input. No actions executed.\n',
    );
    process.exitCode = 2;
  }
}
