// Inert until a private, source-pinned, exact-scope retirement operator calls it.
// No Native/VM launch, closure, signaling or database mutation exists here.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { reviewedTestChatPhysicalScope } from './reviewed-test-chat-preserved-cloud.mjs';
import { reviewedRetirementServicesIdle } from './retirement-preserved-cloud.mjs';
const need = (v, c) => {
  if (!v) throw Error(c);
};
const hex = (b) => createHash('sha256').update(b).digest('hex');
const digest = (b) => 'sha256:' + hex(b);
const same = (a, b, c) => need(isDeepStrictEqual(a, b), c);
export function parseCompleteProcesses(raw) {
  need(
    typeof raw === 'string' &&
      raw.length > 0 &&
      raw.endsWith('\n') &&
      raw.length < 8_000_000,
    'TERMINAL_NATIVE_PS_INCOMPLETE',
  );
  const seen = new Set();
  return raw
    .trimEnd()
    .split('\n')
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
      need(match, 'TERMINAL_NATIVE_PS_UNPARSEABLE');
      const [, p, pp, start, command] = match;
      const pid = Number(p),
        ppid = Number(pp);
      need(
        Number.isSafeInteger(pid) &&
          pid > 0 &&
          Number.isSafeInteger(ppid) &&
          ppid >= 0 &&
          !seen.has(pid),
        'TERMINAL_NATIVE_PS_UNPARSEABLE',
      );
      seen.add(pid);
      return { pid, ppid, startedAt: start, command };
    });
}
export function parseNamespaceWriters(raw) {
  if (raw === '') return [];
  need(
    (typeof raw === 'string' && raw.endsWith('\0')) ||
      (typeof raw === 'string' && raw.endsWith('\0\n')),
    'TERMINAL_NATIVE_LSOF_INCOMPLETE',
  );
  const writers = [];
  let processInfo, file;
  const flush = () => {
    if (!file) return;
    need(
      processInfo && typeof file.name === 'string',
      'TERMINAL_NATIVE_LSOF_UNPARSEABLE',
    );
    // An unspecified access mode is uncertain and remains a blocker.
    if (file.access !== 'r') writers.push({ ...processInfo, ...file });
    file = undefined;
  };
  for (const token of raw.split('\0')) {
    const t = token.replace(/^\n/, '');
    if (!t) continue;
    const value = t.slice(1);
    if (t[0] === 'p') {
      flush();
      need(
        /^\d+$/.test(value) && Number(value) > 0,
        'TERMINAL_NATIVE_LSOF_UNPARSEABLE',
      );
      processInfo = { pid: Number(value) };
    } else if (t[0] === 'c') {
      need(processInfo, 'TERMINAL_NATIVE_LSOF_UNPARSEABLE');
      processInfo.command = value;
    } else if (t[0] === 'f') {
      flush();
      file = { fd: value };
    } else if (t[0] === 'a') {
      need(file, 'TERMINAL_NATIVE_LSOF_UNPARSEABLE');
      need(
        ['r', 'w', 'u', ' '].includes(value),
        'TERMINAL_NATIVE_LSOF_UNPARSEABLE',
      );
      file.access = value;
    } else if (t[0] === 'n') {
      need(file, 'TERMINAL_NATIVE_LSOF_UNPARSEABLE');
      file.name = value;
    } else throw Error('TERMINAL_NATIVE_LSOF_UNPARSEABLE');
  }
  flush();
  return writers;
}
export function nativeProcesses(processes, pins) {
  const needles = pins.flatMap((p) => [
    p.root + '/apps/worker/dsh/',
    resolve(p.root, p.entrypoint),
  ]);
  return processes.filter(
    (p) =>
      needles.some((n) => p.command.includes(n)) ||
      /(?:allrice-(?:jsonrpc|dsh)|@lite-assistant\/(?:dsh|cordis)|\/(?:dsh-native-host|cordis)(?:[ /.-]|$))/.test(
        p.command,
      ),
  );
}
function command(file, args) {
  const r = spawnSync(file, args, {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 8_000_000,
  });
  need(!r.error && !r.signal, 'TERMINAL_NATIVE_PROBE_UNCONFIRMED');
  need(!r.stderr, 'TERMINAL_NATIVE_PROBE_UNCONFIRMED');
  if (file === '/usr/sbin/lsof')
    need(
      r.status === 0 || (r.status === 1 && r.stdout === ''),
      'TERMINAL_NATIVE_LSOF_UNCONFIRMED',
    );
  else need(r.status === 0, 'TERMINAL_NATIVE_PS_UNCONFIRMED');
  return r.stdout;
}
async function directory(path) {
  need(
    typeof path === 'string' &&
      path.startsWith('/') &&
      resolve(path) === path &&
      (await realpath(path)) === path,
    'TERMINAL_NATIVE_PATH_CHANGED',
  );
  const st = await lstat(path);
  need(
    st.isDirectory() &&
      !st.isSymbolicLink() &&
      st.uid === process.getuid() &&
      (st.mode & 0o022) === 0,
    'TERMINAL_NATIVE_PATH_UNTRUSTED',
  );
  return { path, device: st.dev, inode: st.ino };
}
export function assertTerminalServiceIdle(healths, review) {
  need(
    Array.isArray(healths) &&
      healths.length === 2 &&
      Array.isArray(review.serviceIdentities) &&
      review.serviceIdentities.length === 2,
    'TERMINAL_NATIVE_SERVICE_IDENTITIES_REQUIRED',
  );
  for (const [i, role] of ['web', 'worker'].entries()) {
    const h = healths[i],
      pin = review.serviceIdentities[i],
      l = h.producerLifecycle;
    need(
      pin.service === role &&
        pin.sourceSha === review.releaseSha &&
        pin.sourceTree === review.sourceTree,
      'TERMINAL_NATIVE_SERVICE_IDENTITY_CHANGED',
    );
    for (const k of [
      'service',
      'sourceSha',
      'sourceTree',
      'manifestDigest',
      'environment',
      'bootId',
      'pid',
      'startedAt',
    ])
      same(h.identity?.[k], pin[k], 'TERMINAL_NATIVE_SERVICE_IDENTITY_CHANGED');
    need(
      pin.environment === 'dev' &&
        typeof pin.bootId === 'string' &&
        pin.bootId.length > 0 &&
        Number.isSafeInteger(pin.pid) &&
        pin.pid > 1 &&
        l?.role === role &&
        l.instance?.bootId === pin.bootId &&
        l.releaseAdmission === 'disabled' &&
        isDeepStrictEqual(l.unknownOutcomes, []) &&
        [
          'activeRoots',
          'pendingRoots',
          'retainedChildren',
          'unresolvedRoots',
        ].every((k) => l[k] === 0),
      'TERMINAL_NATIVE_SERVICE_BUSY',
    );
  }
}
/** The terminal entry remains exclusive to its original nonchat authority. */
export async function collectTerminalNativeAbsence(input) {
  const { review, planDigest, requestId } = input;
  need(
    review.kind === 'allrice-dev-terminal-nonchat-retirement-review' &&
      review.rootReviewed === true &&
      review.reviewedBy === 'root' &&
      review.planDigest === planDigest &&
      review.requestId === requestId,
    'TERMINAL_NATIVE_EXACT_REVIEW_REQUIRED',
  );
  return collectExactNativeAbsence(input);
}

/** A separately reviewed development-test chat plan keeps its original type,
 * IDs and digest. Reuse observations, never relabel its authority as nonchat. */
function assertReviewedChatInput(input) {
  const expected = reviewedTestChatPhysicalScope(input.review, input.plan);
  need(
    input.requestId === input.plan.requestId &&
      input.planDigest === input.plan.digest,
    'REVIEWED_TEST_CHAT_PHYSICAL_AUTHORITY_CHANGED',
  );
  same(input.scope, expected, 'REVIEWED_TEST_CHAT_PHYSICAL_SCOPE_CHANGED');
}
export async function collectReviewedTestChatNativeAbsence(input) {
  assertReviewedChatInput(input);
  return collectExactNativeAbsence(input);
}

/** Whole-round observation only. Valid temporary roots are recorded, never
 * called idle here. The reviewed-chat round classifier must inspect both health
 * pairs; unknowns, changed identities, target processes/writers still throw. */
export async function collectReviewedTestChatNativeObservation(input) {
  assertReviewedChatInput(input);
  need(
    typeof input.readStep === 'function',
    'REVIEWED_TEST_CHAT_BOUNDED_READ_STEP_REQUIRED',
  );
  return collectExactNativeAbsence(input, {
    readStep: input.readStep,
    validateHealths: (healths, review) =>
      reviewedRetirementServicesIdle(healths, review, true),
    retainServiceHealth: true,
  });
}

/** Collect a complete ps inventory and every reviewed runtime-data/writer range.
 * Both typed entries validate their own exact authority before this shared read.
 * A caller-provided "physicalAbsent" flag is not an observation. */
async function collectExactNativeAbsence(
  {
    scope,
    review,
    planDigest,
    requestId,
    reviewSha256,
    readHealths,
    evidencePath,
    saveEvidence,
    probe = command,
  },
  {
    validateHealths = assertTerminalServiceIdle,
    retainServiceHealth = false,
    readStep = (read) => read(),
  } = {},
) {
  need(
    typeof evidencePath === 'string' &&
      evidencePath.startsWith('/') &&
      typeof saveEvidence === 'function',
    'TERMINAL_NATIVE_EVIDENCE_REQUIRED',
  );
  need(
    Array.isArray(review.artifactRoots) &&
      Array.isArray(review.runtimeStorageRoots),
    'TERMINAL_NATIVE_ALL_ROOTS_REQUIRED',
  );
  same(
    review.artifactRoots.map((p) => p.artifactId).sort(),
    scope.artifactIds,
    'TERMINAL_NATIVE_ARTIFACT_SCOPE_CHANGED',
  );
  need(
    new Set(review.artifactRoots.map((p) => p.artifactId)).size ===
      review.artifactRoots.length,
    'TERMINAL_NATIVE_ARTIFACT_SCOPE_CHANGED',
  );
  same(
    [...new Set(review.runtimeStorageRoots.map((p) => p.artifactId))].sort(),
    scope.artifactIds,
    'TERMINAL_NATIVE_WRITER_SCOPE_CHANGED',
  );
  const roots = [],
    rootFacts = [];
  for (const p of review.artifactRoots) {
    await directory(p.root);
    const path = p.root + '/.local/dsh-native-artifact.json';
    need((await realpath(path)) === path, 'TERMINAL_NATIVE_MANIFEST_CHANGED');
    const stat = await lstat(path);
    need(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o022) === 0 &&
        stat.size <= 8_000_000,
      'TERMINAL_NATIVE_MANIFEST_CHANGED',
    );
    const bytes = await readFile(path);
    need(hex(bytes) === p.manifestSha256, 'TERMINAL_NATIVE_MANIFEST_CHANGED');
    const m = JSON.parse(bytes);
    need(
      m.artifactId === p.artifactId &&
        typeof m.content?.entrypoint === 'string' &&
        !m.content.entrypoint.startsWith('/') &&
        !m.content.entrypoint.split('/').includes('..'),
      'TERMINAL_NATIVE_MANIFEST_CHANGED',
    );
    roots.push({ ...p, entrypoint: m.content.entrypoint });
    rootFacts.push({ path, sha256: hex(bytes) });
  }
  const storageRoots = [];
  for (const p of review.runtimeStorageRoots) {
    need(
      scope.artifactIds.includes(p.artifactId),
      'TERMINAL_NATIVE_WRITER_SCOPE_CHANGED',
    );
    storageRoots.push(await directory(p.root));
  }
  // A missing namespace is covered by an existing reviewed parent range, rather
  // than being treated as an empty lsof result or falling back to filesystem /.
  for (const ns of scope.storageNamespaces)
    need(
      storageRoots.some((p) => ns === p.path || ns.startsWith(p.path + sep)),
      'TERMINAL_NATIVE_NAMESPACE_UNCOVERED',
    );
  const observedAt = new Date().toISOString();
  const healthBefore = await readStep((signal) => readHealths(signal));
  validateHealths(healthBefore, review);
  const beforeRaw = await readStep(() =>
    probe('/bin/ps', ['-A', '-ww', '-o', 'pid=,ppid=,lstart=,command=']),
  );
  const before = parseCompleteProcesses(beforeRaw);
  need(
    nativeProcesses(before, roots).length === 0,
    'TERMINAL_NATIVE_PROCESS_ACTIVE',
  );
  const writerReads = [];
  for (const p of [...storageRoots].sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    const raw = await readStep(() =>
      probe('/usr/sbin/lsof', ['-nP', '-F0pcfan', '+D', p.path]),
    );
    need(
      parseNamespaceWriters(raw).length === 0,
      'TERMINAL_NATIVE_WRITER_ACTIVE',
    );
    writerReads.push({ path: p.path, raw });
  }
  // +D cannot enumerate unlinked files retained by a live descriptor. Scan
  // that complete inventory too; never convert lsof/permission errors to zero.
  const unlinkedRaw = await readStep(() =>
    probe('/usr/sbin/lsof', ['-nP', '-F0pcfan', '+L1']),
  );
  const unlinkedWriters = parseNamespaceWriters(unlinkedRaw).filter((w) =>
    storageRoots.some(
      (p) => w.name === p.path || w.name.startsWith(p.path + sep),
    ),
  );
  need(unlinkedWriters.length === 0, 'TERMINAL_NATIVE_WRITER_ACTIVE');
  const afterRaw = await readStep(() =>
    probe('/bin/ps', ['-A', '-ww', '-o', 'pid=,ppid=,lstart=,command=']),
  );
  need(
    nativeProcesses(parseCompleteProcesses(afterRaw), roots).length === 0,
    'TERMINAL_NATIVE_PROCESS_ACTIVE',
  );
  for (const p of storageRoots)
    same(await directory(p.path), p, 'TERMINAL_NATIVE_PATH_CHANGED');
  for (const p of rootFacts)
    need(
      hex(await readFile(p.path)) === p.sha256,
      'TERMINAL_NATIVE_MANIFEST_CHANGED',
    );
  const healthAfter = await readStep((signal) => readHealths(signal));
  validateHealths(healthAfter, review);
  need(
    Date.now() - Date.parse(observedAt) < 120_000,
    'TERMINAL_NATIVE_OBSERVATION_EXPIRED',
  );
  const evidence = {
    kind: 'terminal-native-complete-observations-v1',
    requestId,
    planDigest,
    scope,
    observedAt,
    healthBefore,
    healthAfter,
    rootFacts,
    storageRoots,
    beforeRaw,
    afterRaw,
    writerReads,
    unlinkedRaw,
  };
  await saveEvidence(evidencePath, evidence);
  const evidenceSha256 = hex(JSON.stringify(evidence, null, 2) + '\n');
  const physicalProof = {
    kind: 'terminal-native-physical-absence-v1',
    workerBootId: review.serviceIdentities[1].bootId,
    workerBootStartedAt: review.serviceIdentities[1].startedAt,
    requestId,
    planDigest,
    scopeDigest: scope.digest,
    observedAt,
    expiresAt: new Date(Date.parse(observedAt) + 120_000).toISOString(),
    processInventoryDigest: digest(JSON.stringify({ beforeRaw, afterRaw })),
    writerInventoryDigest: digest(JSON.stringify({ writerReads, unlinkedRaw })),
    nativeProcesses: [],
    writers: [],
    artifactRoots: review.artifactRoots.map((p) => ({
      artifactId: p.artifactId,
      root: p.root,
      manifestSha256: p.manifestSha256,
    })),
    storageNamespaces: scope.storageNamespaces,
    evidencePath,
    evidenceSha256,
    writerScopes: review.runtimeStorageRoots.map((p) => ({
      artifactId: p.artifactId,
      root: p.root,
    })),
    sourceSha: review.releaseSha,
    sourceTree: review.sourceTree,
    operatorSha256: review.operatorSha256,
    reviewSha256,
  };
  return retainServiceHealth
    ? { physicalProof, healthBefore, healthAfter }
    : physicalProof;
}
