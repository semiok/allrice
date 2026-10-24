import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as physical from './terminal-native-physical-absence.mjs';
import { observeCompleteReadOnlyQuiescence } from './retirement-readonly-observer.mjs';
import {
  REVIEWED_TEST_CHAT_REVIEW_KIND,
  reviewedTestChatPhysicalScope,
} from './reviewed-test-chat-preserved-cloud.mjs';
import { HISTORICAL_CLOUD } from './terminal-retirement-preserved-cloud.mjs';
import { exitedContainerEvidenceDigest as digest } from './retirement-preserved-cloud.mjs';
const hash = (v) => createHash('sha256').update(v).digest('hex');
const clone = (v) => globalThis.structuredClone(v);
const artifactId = 'sha256:' + hash('synthetic artifact; no installed Native');
const uuid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const ps = '    121     1 Fri Oct 23 23:59:59 2026 /usr/bin/idle-fixture\n';
const cli = await readFile(
  new URL('./retire-native-test-contexts.mjs', import.meta.url),
  'utf8',
);
const completePhysicalSource = cli.slice(
  cli.indexOf('    const completePhysical ='),
  cli.indexOf('    const readBusy ='),
);
async function fixture(run) {
  const parent = resolve(
    import.meta.dirname,
    '../../..',
    '.tmp',
    'reviewed-chat-entry-fixtures',
  );
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(parent + '/owned-');
  try {
    await mkdir(root + '/.local', { mode: 0o700 });
    await mkdir(root + '/runtime', { mode: 0o700 });
    const manifest = JSON.stringify({
      artifactId,
      content: { entrypoint: 'native/entry.mjs' },
    });
    await writeFile(root + '/.local/dsh-native-artifact.json', manifest, {
      mode: 0o600,
    });
    const sourceSha = 'a'.repeat(40),
      sourceTree = 'b'.repeat(40);
    const serviceIdentities = ['web', 'worker'].map((service, i) => ({
      service,
      sourceSha,
      sourceTree,
      manifestDigest: digest(service),
      environment: 'dev',
      bootId: 'synthetic-' + service,
      pid: 201 + i,
      startedAt: new Date(Date.now() - 60000).toISOString(),
    }));
    const healths = serviceIdentities.map((identity) => ({
      status: 'ready',
      identity,
      producerLifecycle: {
        role: identity.service,
        instance: { bootId: identity.bootId },
        releaseAdmission: 'disabled',
        unknownOutcomes: [],
        activeRoots: 0,
        pendingRoots: 0,
        retainedChildren: 0,
        unresolvedRoots: 0,
      },
    }));
    const snapshot = {
      scope: {
        contextKind: 'chat',
        contextId: uuid(11),
        organizationId: uuid(12),
        workspaceId: uuid(13),
        ownerId: uuid(14),
      },
      archived: true,
      origin: null,
      bindings: [],
    };
    const plan = {
      kind: 'development-test-chat-retirement',
      schemaVersion: 1,
      requestId: uuid(15),
      digest: digest('synthetic immutable plan'),
      authorizationEvidenceDigest: digest(
        'synthetic explicit root test scope approval',
      ),
      snapshots: [snapshot],
    };
    const review = {
      kind: REVIEWED_TEST_CHAT_REVIEW_KIND,
      enabled: true,
      rootReviewed: true,
      reviewedBy: 'root',
      developmentTestScopesApproved: true,
      requestId: plan.requestId,
      planDigest: plan.digest,
      authorizationEvidenceDigest: plan.authorizationEvidenceDigest,
      releaseSha: sourceSha,
      sourceTree,
      operatorSha256: 'c'.repeat(64),
      serviceIdentities,
      oldArtifactIds: [artifactId],
      artifactRoots: [{ artifactId, root, manifestSha256: hash(manifest) }],
      runtimeStorageRoots: [{ artifactId, root: root + '/runtime' }],
      exactDevelopmentTestChats: [
        {
          kind: 'reviewed-development-test-chat-v1',
          classification: 'development_test',
          scope: clone(snapshot.scope),
          authorizationEvidenceDigest: plan.authorizationEvidenceDigest,
          scopeEvidenceDigest: digest('synthetic archived test scope evidence'),
          snapshotDigest: digest(snapshot),
          oldArtifactIds: [artifactId],
          storageNamespaces: [root + '/runtime/exact/sessions'],
        },
      ],
      historicalCloudCarry: {
        kind: 'allrice-dev-reviewed-test-chat-exact-cloud-v1',
        enabled: true,
        rootReviewed: true,
        reviewedBy: 'root',
        requestId: plan.requestId,
        planDigest: plan.digest,
        authorizationEvidenceDigest: plan.authorizationEvidenceDigest,
        observationNonce: uuid(16),
        reviewedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        readerPin: clone(HISTORICAL_CLOUD.readerPin),
        baselinePin: clone(HISTORICAL_CLOUD.baselinePin),
        serviceIdentities: clone(serviceIdentities),
      },
    };
    const probes = [],
      saved = [];
    const probe = async (file, args) => {
      probes.push([file, args]);
      return file === '/bin/ps' ? ps : '';
    };
    const readHealths = async () => clone(healths);
    const save = async (path, value) => {
      saved.push(path);
      await writeFile(path, JSON.stringify(value, null, 2) + '\n', {
        mode: 0o600,
        flag: 'wx',
      });
    };
    const f = {
      root,
      plan,
      review,
      healths,
      probes,
      saved,
      probe,
      readHealths,
      save,
    };
    await run(f);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function invokeActualCliPhysicalEntry(
  f,
  suffix,
  readStep = (read) => read(),
) {
  // Execute the actual joined CLI's closure, then the actual exported collector.
  // Only OS/health inputs are bounded synthetic observations; no apply/DB/Host.
  const args = [
    'collectTerminalNativeAbsence',
    'collectReviewedTestChatNativeObservation',
    'reviewedTestChatPhysicalScope',
    'r',
    'input',
    'review',
    'hash',
    'readHealths',
    'a',
    'save',
  ];
  const collect = new Function(
    ...args,
    completePhysicalSource + '\nreturn completePhysical;',
  )(
    (input) =>
      physical.collectTerminalNativeAbsence({ ...input, probe: f.probe }),
    (input) =>
      physical.collectReviewedTestChatNativeObservation({
        ...input,
        probe: f.probe,
      }),
    reviewedTestChatPhysicalScope,
    f.review,
    { value: f.plan },
    { bytes: Buffer.from(JSON.stringify(f.review)) },
    hash,
    f.readHealths,
    { output: f.root + '/result.json' },
    f.save,
  );
  return collect(suffix, readStep);
}
describe('reviewed test-chat CLI to real physical collector boundary', () => {
  it('runs the real before/after closure with original typed authority and complete bounded probes', async () => {
    await fixture(async (f) => {
      const before = clone({ review: f.review, plan: f.plan });
      const a = await invokeActualCliPhysicalEntry(f, '.physical-before.json');
      const b = await invokeActualCliPhysicalEntry(f, '.physical-after.json');
      for (const { physicalProof: p, healthBefore, healthAfter } of [a, b]) {
        expect(healthBefore).toEqual(f.healths);
        expect(healthAfter).toEqual(f.healths);
        expect(p).toMatchObject({
          requestId: f.plan.requestId,
          planDigest: f.plan.digest,
          scopeDigest: reviewedTestChatPhysicalScope(f.review, f.plan).digest,
          nativeProcesses: [],
          writers: [],
          sourceSha: f.review.releaseSha,
          sourceTree: f.review.sourceTree,
        });
        expect(p.evidenceSha256).toBe(hash(await readFile(p.evidencePath)));
        expect(
          JSON.parse(await readFile(p.evidencePath, 'utf8')).beforeRaw,
        ).toBe(ps);
      }
      expect(f.probes.map(([file]) => file)).toEqual([
        '/bin/ps',
        '/usr/sbin/lsof',
        '/usr/sbin/lsof',
        '/bin/ps',
        '/bin/ps',
        '/usr/sbin/lsof',
        '/usr/sbin/lsof',
        '/bin/ps',
      ]);
      expect(f.saved).toHaveLength(2);
      expect({ review: f.review, plan: f.plan }).toEqual(before);
    });
  });
  it.each([
    [
      'nonchat kind',
      (f) => {
        f.review.kind = 'allrice-dev-terminal-nonchat-retirement-review';
      },
    ],
    [
      'slot5 kind',
      (f) => {
        f.review.kind = 'allrice-dev-test-chat-retirement-review';
      },
    ],
    [
      'control kind',
      (f) => {
        f.review.kind = 'allrice-dev-native-control-upgrade-review-v1';
      },
    ],
    [
      'missing top request ID',
      (f) => {
        delete f.review.requestId;
      },
    ],
    [
      'missing top plan digest',
      (f) => {
        delete f.review.planDigest;
      },
    ],
    [
      'mismatched request ID',
      (f) => {
        f.review.requestId = uuid(99);
      },
    ],
    [
      'mismatched plan digest',
      (f) => {
        f.review.planDigest = digest('another plan');
      },
    ],
    [
      'mismatched owner scope',
      (f) => {
        f.review.exactDevelopmentTestChats[0].scope.ownerId = uuid(99);
      },
    ],
    [
      'protected original PPT',
      (f) => {
        f.plan.snapshots[0].scope.contextId =
          '68e76b6b-2e75-45b7-b628-951945b12044';
        f.review.exactDevelopmentTestChats[0].scope = clone(
          f.plan.snapshots[0].scope,
        );
        f.review.exactDevelopmentTestChats[0].snapshotDigest = digest(
          f.plan.snapshots[0],
        );
      },
    ],
  ])(
    'refuses %s at the actual CLI boundary before physical probes',
    async (_name, mutate) => {
      await fixture(async (f) => {
        mutate(f);
        await expect(
          invokeActualCliPhysicalEntry(f, '.physical-before.json'),
        ).rejects.toThrow();
        expect(f.probes).toEqual([]);
        expect(f.saved).toEqual([]);
      });
    },
  );
  it('does not widen the existing terminal-only API to accept a valid chat review', async () => {
    await fixture(async (f) => {
      await expect(
        physical.collectTerminalNativeAbsence({
          scope: reviewedTestChatPhysicalScope(f.review, f.plan),
          review: f.review,
          plan: f.plan,
          requestId: f.plan.requestId,
          planDigest: f.plan.digest,
          reviewSha256: hash(JSON.stringify(f.review)),
          readHealths: f.readHealths,
          evidencePath: f.root + '/evidence.json',
          saveEvidence: f.save,
          probe: f.probe,
        }),
      ).rejects.toThrow('TERMINAL_NATIVE_EXACT_REVIEW_REQUIRED');
      expect(f.probes).toEqual([]);
      expect(f.saved).toEqual([]);
    });
  });
  it('rejects an independently substituted collector scope before OS or health reads', async () => {
    await fixture(async (f) => {
      const scope = reviewedTestChatPhysicalScope(f.review, f.plan);
      scope.scopes[0] = { ...scope.scopes[0], ownerId: uuid(99) };
      await expect(
        physical.collectReviewedTestChatNativeAbsence({
          scope,
          review: f.review,
          plan: f.plan,
          requestId: f.plan.requestId,
          planDigest: f.plan.digest,
          reviewSha256: hash(JSON.stringify(f.review)),
          readHealths: f.readHealths,
          evidencePath: f.root + '/evidence.json',
          saveEvidence: f.save,
          probe: f.probe,
        }),
      ).rejects.toThrow('REVIEWED_TEST_CHAT_PHYSICAL_SCOPE_CHANGED');
      expect(f.probes).toEqual([]);
      expect(f.saved).toEqual([]);
    });
  });
  it('records valid transient service counters without calling them idle; strict absence still refuses', async () => {
    await fixture(async (f) => {
      f.healths[0].producerLifecycle.activeRoots = 1;
      const observed = await invokeActualCliPhysicalEntry(
        f,
        '.physical-observation.json',
      );
      expect(observed.healthBefore[0].producerLifecycle.activeRoots).toBe(1);
      expect(observed.healthAfter[0].producerLifecycle.activeRoots).toBe(1);
      expect(observed.physicalProof.writers).toEqual([]);
      await expect(
        physical.collectReviewedTestChatNativeAbsence({
          scope: reviewedTestChatPhysicalScope(f.review, f.plan),
          review: f.review,
          plan: f.plan,
          requestId: f.plan.requestId,
          planDigest: f.plan.digest,
          reviewSha256: hash(JSON.stringify(f.review)),
          readHealths: f.readHealths,
          evidencePath: f.root + '/strict.json',
          saveEvidence: f.save,
          probe: f.probe,
        }),
      ).rejects.toThrow('TERMINAL_NATIVE_SERVICE_BUSY');
    });
  });
  it.each([
    [
      'unknown lifecycle',
      (f) => {
        f.healths[1].producerLifecycle.unknownOutcomes = ['unconfirmed'];
      },
    ],
    [
      'another boot',
      (f) => {
        f.healths[1].identity.bootId = 'another-boot';
      },
    ],
    [
      'negative counter',
      (f) => {
        f.healths[1].producerLifecycle.pendingRoots = -1;
      },
    ],
    [
      'target writer',
      (f) => {
        f.probe = async (file) =>
          file === '/bin/ps'
            ? ps
            : 'p121\0cwriter\0\nf4\0au\0n' + f.root + '/runtime/native.log\0\n';
      },
    ],
    [
      'target process',
      (f) => {
        f.probe = async () =>
          '    121     1 Fri Oct 23 23:59:59 2026 /another/allrice-jsonrpc-runtime.mjs\n';
      },
    ],
  ])('never exposes %s as transient activity', async (_name, change) => {
    await fixture(async (f) => {
      f.healths[0].producerLifecycle.activeRoots = 1;
      change(f);
      await expect(
        invokeActualCliPhysicalEntry(f, '.must-not-save.json'),
      ).rejects.toThrow();
      expect(f.saved).toEqual([]);
    });
  });

  it('awaits an expired OS read but issues no subsequent physical probe or evidence write', async () => {
    await fixture(async (f) => {
      let now = 0;
      f.probe = async (file, args) => {
        f.probes.push([file, args]);
        now = 101;
        return ps;
      };
      await expect(
        observeCompleteReadOnlyQuiescence({
          timeoutMs: 100,
          intervalMs: 10,
          now: () => now,
          readObservation: (step) =>
            invokeActualCliPhysicalEntry(f, '.expired.json', step),
          classifyObservation: () => {
            throw Error('expired physical result must never be classified');
          },
        }),
      ).rejects.toThrow('NATIVE_RETIREMENT_QUIESCENCE_TIMEOUT');
      expect(f.probes.map(([file]) => file)).toEqual(['/bin/ps']);
      expect(f.saved).toEqual([]);
    });
  });
});
