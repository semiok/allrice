// Explicit, conservative reuse of observations; NEVER execution on a new build.
import { execFileSync } from 'node:child_process';
import { TextDecoder } from 'node:util';
import {
  digest,
  hash,
  object,
  parseJson,
  readSafe,
  sha,
  text,
} from './internal-evidence-io.mjs';
import { MAX_EVIDENCE_AGE_MS } from './p28-release-readiness.mjs';

// Fixed boundary, not a reviewer-supplied path exclusion. These exact files are
// gate/documentation inputs only; application prompts, build tools and all other
// files remain in the compared product tree, including their Git mode/type.
export const REUSE_NON_PRODUCT_PATHS = Object.freeze([
  'docs/architecture/allrice-2.0/met148-internal-readiness-verification.md',
  'docs/architecture/allrice-2.0/p27-internal-manifest.draft.json',
  'docs/architecture/allrice-2.0/p27-internal-readiness.md',
  'docs/architecture/allrice-2.0/p28-handoff-index.md',
  'docs/architecture/allrice-2.0/p28-release-readiness.md',
  'scripts/acceptance/platform/internal-evidence-io.mjs',
  'scripts/acceptance/platform/internal-evidence-io.test.mjs',
  'scripts/acceptance/platform/p27-internal-readiness.mjs',
  'scripts/acceptance/platform/p27-internal-readiness.test.mjs',
  'scripts/acceptance/platform/internal-evidence-reuse.mjs',
  'scripts/acceptance/platform/internal-evidence-reuse.test.mjs',
]);
const boundaryPolicy = 'unchanged-product-tree-and-artifact-bytes/v1';
function check(condition, code) {
  if (!condition) throw new Error(`reuse-${code}`);
}
function keys(value, fields) {
  check(
    object(value) &&
      Object.keys(value).length === fields.length &&
      fields.every((field) => Object.hasOwn(value, field)),
    'exact-fields-required',
  );
}
function time(value, now) {
  const timestamp =
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
      ? Date.parse(value)
      : NaN;
  check(
    Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString() === value &&
      timestamp <= now &&
      now - timestamp <= MAX_EVIDENCE_AGE_MS,
    'stale-or-invalid-time',
  );
  return timestamp;
}
function pinned(root, pin, maximum = 8 * 1024 * 1024) {
  keys(pin, ['path', 'sha256', 'bytes']);
  check(
    digest(pin.sha256) && Number.isSafeInteger(pin.bytes) && pin.bytes > 0,
    'invalid-file-pin',
  );
  const bytes = readSafe(root, pin.path, maximum);
  check(
    bytes.length === pin.bytes && hash(bytes) === pin.sha256,
    'file-integrity-mismatch',
  );
  return bytes;
}
function json(root, pin) {
  return parseJson(pinned(root, pin));
}
function git(root, args) {
  // No shell, network, pager, external diff/textconv, replacement objects or
  // ambient GIT_DIR/index/config. Only bounded reads of explicit local commits.
  const bytes = execFileSync('/usr/bin/git', ['-C', root, ...args], {
    timeout: 10000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_NO_LAZY_FETCH: '1',
      GIT_ALLOW_PROTOCOL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function readCodeBoundary(sourceRoot, testedSourceSha, targetSourceSha) {
  check(sha(testedSourceSha) && sha(targetSourceSha), 'source-pins-required');
  const productTree = (source) => {
    check(
      git(sourceRoot, [
        'rev-parse',
        '--verify',
        `${source}^{commit}`,
      ]).trim() === source,
      'commit-pin-mismatch',
    );
    const entries = git(sourceRoot, [
      'ls-tree',
      '-r',
      '-z',
      '--full-tree',
      source,
    ])
      .split('\0')
      .filter(Boolean);
    const product = entries.filter((entry) => {
      const tab = entry.indexOf('\t');
      check(tab > 0, 'invalid-git-tree');
      const path = entry.slice(tab + 1);
      if (!REUSE_NON_PRODUCT_PATHS.includes(path)) return true;
      check(
        /^100644 blob [a-f0-9]{40}\t/.test(entry),
        'non-product-path-type-changed',
      );
      return false;
    });
    return hash(Buffer.from(`${product.join('\0')}\0`));
  };
  const testedTreeSha256 = productTree(testedSourceSha);
  const targetTreeSha256 = productTree(targetSourceSha);
  return {
    schema: 'allrice-p27-code-boundary/v1',
    testedSourceSha,
    targetSourceSha,
    policy: boundaryPolicy,
    testedTreeSha256,
    targetTreeSha256,
    patch: git(sourceRoot, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--full-index',
      '--binary',
      testedSourceSha,
      targetSourceSha,
      '--',
    ]),
  };
}

// Resolves and binds an original receipt, but does NOT validate its claims. The
// caller must run the unchanged common receipt checks against these tested pins,
// including original timestamps, attachment bytes and subscription proof.
export function resolveReusedEvidence({
  wrapper,
  caseId,
  evidenceRoot,
  sourceRoot,
  targetSourceSha,
  targetArtifacts,
  now,
}) {
  keys(wrapper, [
    'schema',
    'caseId',
    'originalReceipt',
    'testedSourceSha',
    'testedArtifacts',
    'targetSourceSha',
    'targetArtifacts',
    'impactReview',
  ]);
  check(
    wrapper.schema === 'allrice-p27-internal-evidence-reuse/v1' &&
      wrapper.caseId === caseId,
    'schema-or-case-mismatch',
  );
  check(
    ![
      'source-build-package-provenance',
      'dev-final-sha-login-history-downloads-flags-smoke',
    ].includes(caseId),
    'case-requires-fresh-execution',
  );
  check(
    sha(wrapper.testedSourceSha) && wrapper.targetSourceSha === targetSourceSha,
    'source-pin-mismatch',
  );
  const requiredArtifacts = Object.keys(targetArtifacts);
  keys(wrapper.testedArtifacts, requiredArtifacts);
  keys(wrapper.targetArtifacts, requiredArtifacts);
  const testedArtifacts = {};
  for (const id of requiredArtifacts) {
    pinned(evidenceRoot, wrapper.testedArtifacts[id], 256 * 1024 * 1024);
    testedArtifacts[id] = wrapper.testedArtifacts[id].sha256;
    check(
      wrapper.targetArtifacts[id] === targetArtifacts[id],
      'target-artifact-mismatch',
    );
    check(
      id === 'source' || testedArtifacts[id] === targetArtifacts[id],
      'artifact-bytes-changed',
    );
  }
  const receipt = json(evidenceRoot, wrapper.originalReceipt);
  check(
    receipt?.schema === 'allrice-p27-internal-evidence/v1' &&
      receipt.caseId === caseId,
    'original-receipt-required-no-recursion',
  );
  check(
    receipt.sourceSha === wrapper.testedSourceSha,
    'original-source-mismatch',
  );
  // Explicitly retain age of the observation; review is not a new execution.
  const observed = time(receipt.observedAt, now);
  const review = json(evidenceRoot, wrapper.impactReview);
  keys(review, [
    'schema',
    'caseId',
    'originalReceiptSha256',
    'testedSourceSha',
    'targetSourceSha',
    'reviewedAt',
    'reviewer',
    'codeBoundary',
    'assertions',
  ]);
  check(
    review.schema === 'allrice-p27-internal-impact-review/v1' &&
      review.caseId === caseId &&
      review.originalReceiptSha256 === wrapper.originalReceipt.sha256 &&
      review.testedSourceSha === wrapper.testedSourceSha &&
      review.targetSourceSha === targetSourceSha,
    'review-binding-mismatch',
  );
  check(
    time(review.reviewedAt, now) >= observed && text(review.reviewer),
    'review-context-required',
  );
  const boundary = json(evidenceRoot, review.codeBoundary);
  keys(boundary, [
    'schema',
    'testedSourceSha',
    'targetSourceSha',
    'policy',
    'testedTreeSha256',
    'targetTreeSha256',
    'patch',
  ]);
  const actual = readCodeBoundary(
    sourceRoot,
    wrapper.testedSourceSha,
    targetSourceSha,
  );
  check(
    Object.keys(actual).every((key) => actual[key] === boundary[key]),
    'actual-git-diff-mismatch',
  );
  check(
    actual.testedTreeSha256 === actual.targetTreeSha256,
    'product-tree-changed-or-unknown',
  );
  check(
    Array.isArray(receipt.assertions) && Array.isArray(review.assertions),
    'assertion-review-required',
  );
  const names = receipt.assertions.map((a) => a?.name);
  check(
    names.every(text) &&
      new Set(names).size === names.length &&
      JSON.stringify([...names].sort()) ===
        JSON.stringify(review.assertions.map((a) => a?.name).sort()),
    'assertion-review-coverage',
  );
  for (const assertion of review.assertions) {
    keys(assertion, ['name', 'impact', 'rationale', 'boundarySha256']);
    check(
      assertion.impact === 'unaffected' &&
        text(assertion.rationale) &&
        assertion.boundarySha256 === review.codeBoundary.sha256,
      'assertion-affected-or-unknown',
    );
  }
  return {
    receipt,
    testedSourceSha: wrapper.testedSourceSha,
    testedArtifacts,
    report: {
      caseId,
      originalReceipt: wrapper.originalReceipt,
      impactReview: wrapper.impactReview,
      testedSourceSha: wrapper.testedSourceSha,
      targetSourceSha,
      testedArtifacts,
      targetArtifacts,
      observedAt: receipt.observedAt,
      reviewedAt: review.reviewedAt,
      method: receipt.method,
      executedOnTarget: false,
      boundaryPolicy,
    },
  };
}
