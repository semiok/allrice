import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  nativeControlDatabaseDistDigest,
  nativeControlUpgradeStep,
  validateNativeControlUpgradeDatabaseUrl,
  validateNativeControlUpgradeActiveIdentity,
  validateNativeControlUpgradeProofs,
} from './upgrade-native-schedule-control.mjs';

const operator = fileURLToPath(
  new URL('./upgrade-native-schedule-control.mjs', import.meta.url),
);
const root = fileURLToPath(new URL('../../', import.meta.url)).replace(
  /\/$/,
  '',
);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
const digest = (value) => 'sha256:' + hash(JSON.stringify(canonical(value)));
const paths = [];
const temp = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'allrice-control-cli-')));
  paths.push(dir);
  return dir;
};
const write = (path, value) => {
  writeFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600 });
  return { path, sha256: hash(readFileSync(path)) };
};
const url = 'postgres://a123@127.0.0.1:5432/allrice_dev';
const run = (args, override = {}) =>
  spawnSync(process.execPath, [operator, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: process.env.PATH, DATABASE_URL: url, ...override },
  });
afterEach(() => {
  for (const path of paths.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function proofs(phase = 'prepare') {
  const stateRoot = '/synthetic/state',
    planId = 'b7a7eef3-2bd3-4b1a-87cc-9a94565370fd';
  const before = {
    artifactId: digest('old'),
    profileId: 'allrice-recurring-control-v1',
    storageId: 'retained-storage',
    stateRoot: '/synthetic/control',
  };
  const after = { ...before, artifactId: digest('new') };
  const review = {
    phase,
    releaseDirectory: root,
    releaseSha: '1'.repeat(40),
    sourceTree: '2'.repeat(40),
    partitionId: 'recurring-partition',
    beforeReference: before,
    afterReference: after,
    artifactProofPin: {
      path: '/synthetic/artifact.json',
      sha256: 'a'.repeat(64),
    },
    publicHistoryPin: {
      path: '/synthetic/history.json',
      sha256: 'b'.repeat(64),
    },
    offlineProofPin: { path: '/synthetic/exit.json', sha256: 'c'.repeat(64) },
    activeReleaseIdentity: {
      releaseDirectory: '/synthetic/accepted-base',
      releaseSha: '3'.repeat(40),
      sourceTree: '4'.repeat(40),
    },
  };
  const artifact = {
    kind: 'allrice-native-control-artifact-proof-v1',
    rootReviewed: true,
    reviewedBy: 'root',
    passed: true,
    generation: 'dsh-0.2.1-rc.2-687f282',
    beforeReference: before,
    afterReference: after,
  };
  const history = {
    ...artifact,
    kind: 'allrice-native-control-public-history-proof-v1',
  };
  const offline = {
    kind: 'allrice-native-control-offline-proof-v1',
    rootReviewed: true,
    reviewedBy: 'root',
    passed: true,
    candidate: {
      releaseDirectory: root,
      releaseSha: review.releaseSha,
      sourceTree: review.sourceTree,
    },
    stoppedRelease: review.activeReleaseIdentity,
    planId,
    planDigest: phase === 'prepare' ? null : digest('frozen plan'),
    observedAtMs: 1000,
    expiresAtMs: 2000,
    locks: ['/qa-validation.lock', '/dev-deployment.lock'].map((path) => ({
      path: stateRoot + path,
      ownerPid: 100,
      ownerBirth: 'root-birth',
      tokenDigest: digest(path),
      acquiredAtMs: 500,
      ownershipEvidenceDigest: digest('lock receipt'),
    })),
    processes: ['web', 'worker'].map((role, i) => ({
      role,
      pid: 101 + i,
      birth: role + '-birth',
      stopMode: 'normal',
      stopRequestedAtMs: 800,
      exitConfirmedAtMs: 900,
      exitEvidenceDigest: digest(role + ' normal exit'),
    })),
  };
  const artifactEvidence = {
    kind: 'reviewed-native-control-compatibility-v1',
    generation: artifact.generation,
    beforeReference: before,
    afterReference: after,
    artifactVerificationDigest: 'sha256:' + review.artifactProofPin.sha256,
    publicHistoryVerificationDigest: 'sha256:' + review.publicHistoryPin.sha256,
  };
  const plan = {
    planId,
    partitionId: review.partitionId,
    beforeReference: before,
    afterReference: after,
    artifactEvidence,
    artifactEvidenceDigest: digest(artifactEvidence),
  };
  const input =
    phase === 'prepare'
      ? {
          kind: 'native-control-upgrade-prepare-input-v1',
          requestId: planId,
          partitionId: review.partitionId,
          beforeReference: before,
          afterReference: after,
        }
      : {
          kind: 'native-control-upgrade-apply-input-v1',
          plan,
          planDigest: offline.planDigest,
          offlineStoppedAttestation: {
            kind: 'offlineStopped',
            environment: 'dev',
            planId,
            planDigest: offline.planDigest,
            observedAtMs: offline.observedAtMs,
            expiresAtMs: offline.expiresAtMs,
            locks: offline.locks,
            processes: offline.processes,
            operatorEvidenceDigest: 'sha256:' + review.offlineProofPin.sha256,
          },
        };
  return {
    review,
    input,
    artifact,
    history,
    offline,
    mode: phase,
    stateRoot,
    artifactEvidence,
  };
}

describe('control upgrade operator boundary without a database or services', () => {
  it('is disabled with no arguments and no credentials', () => {
    const result = execFileSync(process.execPath, [operator], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(JSON.parse(result)).toEqual({
      disabled: true,
      databaseWritten: false,
      modes: ['prepare', 'apply', 'readback'],
    });
  });
  it.each([
    'postgres://user:never-print@remote.example.test:5432/allrice_dev',
    'postgres://a123@127.0.0.1:5432/allrice',
    'postgres://a123@127.0.0.1:5433/allrice_dev',
    'postgres://a123@localhost:5432/allrice_dev',
    'postgres://a123@127.0.0.1:5432/allrice_dev?host=remote',
    'postgres://a123@127.0.0.1:5432/allrice_dev?options=-csearch_path=other',
    'postgres://a123@127.0.0.1:5432/allrice_dev#hidden',
  ])('rejects redirected/alternate targets before DB import (%#)', (value) => {
    const result = run(
      ['--mode', 'apply', '--root', root, '--input', '/missing'],
      { DATABASE_URL: value },
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).code).toBe(
      'NATIVE_CONTROL_UPGRADE_LOCAL_DEV_ONLY',
    );
    expect(result.stderr).not.toContain('never-print');
  });
  it.each([
    'PGHOST',
    'PGHOSTADDR',
    'PGPORT',
    'PGDATABASE',
    'PGSERVICE',
    'PGSERVICEFILE',
    'PGOPTIONS',
    'PGTARGETSESSIONATTRS',
  ])('refuses environment routing override %s', (key) => {
    expect(() =>
      validateNativeControlUpgradeDatabaseUrl({
        DATABASE_URL: url,
        [key]: 'unreviewed',
      }),
    ).toThrow('LOCAL_DEV_ONLY');
  });
  it('refuses broad permissions, symlinks, and a changed review hash before database import', () => {
    const dir = temp(),
      input = write(join(dir, 'input.json'), {}),
      review = write(join(dir, 'review.json'), {});
    const args = [
      '--mode',
      'prepare',
      '--root',
      root,
      '--input',
      input.path,
      '--review',
      review.path,
      '--review-sha',
      review.sha256,
    ];
    chmodSync(input.path, 0o644);
    expect(JSON.parse(run(args).stderr).code).toBe(
      'NATIVE_CONTROL_UPGRADE_PRIVATE_INPUT_REQUIRED',
    );
    chmodSync(input.path, 0o600);
    const link = join(dir, 'link.json');
    symlinkSync(input.path, link);
    expect(
      JSON.parse(run(args.map((v) => (v === input.path ? link : v))).stderr)
        .code,
    ).toBe('NATIVE_CONTROL_UPGRADE_EXACT_PRIVATE_PATH_REQUIRED');
    expect(
      JSON.parse(
        run(args.map((v) => (v === review.sha256 ? 'd'.repeat(64) : v))).stderr,
      ).code,
    ).toBe('NATIVE_CONTROL_UPGRADE_REVIEW_CHANGED');
  });
  it('does not promote a disabled or self-declared reviewed policy', () => {
    const dir = temp(),
      input = write(join(dir, 'input.json'), {}),
      review = write(join(dir, 'review.json'), {
        kind: 'allrice-dev-native-control-upgrade-review-v1',
        enabled: false,
        rootReviewed: false,
        reviewedBy: null,
      });
    const result = run([
      '--mode',
      'prepare',
      '--root',
      root,
      '--input',
      input.path,
      '--review',
      review.path,
      '--review-sha',
      review.sha256,
    ]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).code).toBe(
      'NATIVE_CONTROL_UPGRADE_EXACT_ROOT_REVIEW_REQUIRED',
    );
  });
  it('refuses a mismatched candidate source before dist import, intent or DB calls', () => {
    const dir = temp(),
      p = proofs();
    const stateRoot = join(homedir(), 'allrice-dev', '.local');
    p.review.releaseSha = '0'.repeat(40);
    p.review.sourceTree = '0'.repeat(40);
    p.offline.candidate = {
      releaseDirectory: root,
      releaseSha: p.review.releaseSha,
      sourceTree: p.review.sourceTree,
    };
    p.offline.locks.forEach((lock) => {
      lock.path = stateRoot + lock.path.slice(p.stateRoot.length);
    });
    const input = write(join(dir, 'input.json'), p.input);
    const reviewed = {
      ...p.review,
      kind: 'allrice-dev-native-control-upgrade-review-v1',
      enabled: true,
      rootReviewed: true,
      reviewedBy: 'root',
      reviewedAtMs: 1000,
      inputPin: input,
      operatorSha256: hash(readFileSync(operator)),
      databaseDistDigest: '0'.repeat(64),
      artifactProofPin: write(join(dir, 'artifact.json'), p.artifact),
      publicHistoryPin: write(join(dir, 'history.json'), p.history),
      offlineProofPin: write(join(dir, 'offline.json'), p.offline),
    };
    const policy = write(join(dir, 'review.json'), reviewed);
    const result = run([
      '--mode',
      'prepare',
      '--root',
      root,
      '--input',
      input.path,
      '--output',
      join(dir, 'output.json'),
      '--review',
      policy.path,
      '--review-sha',
      policy.sha256,
    ]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).code).toBe(
      'NATIVE_CONTROL_UPGRADE_SOURCE_CHANGED',
    );
    expect(() => readFileSync(input.path + '.intent.json')).toThrow();
  });
  it('validates both explicit phases and readonly historical bindings, with no automatic OS claims', () => {
    for (const phase of ['prepare', 'apply']) {
      const p = proofs(phase);
      expect(validateNativeControlUpgradeProofs(p).planId).toBe(
        p.offline.planId,
      );
      expect(
        validateNativeControlUpgradeProofs({ ...p, mode: 'readback' }).before,
      ).toEqual(p.review.beforeReference);
    }
  });
  it('keeps the accepted stopped release distinct from candidate source/build identity', () => {
    const p = proofs(),
      identity = p.review.activeReleaseIdentity;
    const accepted = {
      ...identity,
      webReleaseSha: identity.releaseSha,
      workerReleaseSha: identity.releaseSha,
    };
    expect(() =>
      validateNativeControlUpgradeActiveIdentity(p.review, accepted),
    ).not.toThrow();
    expect(() => validateNativeControlUpgradeProofs(p)).not.toThrow();
    expect(() =>
      validateNativeControlUpgradeActiveIdentity(p.review, {
        ...accepted,
        releaseDirectory: p.review.releaseDirectory,
      }),
    ).toThrow('ACTIVE_RELEASE_CHANGED');
    expect(() =>
      validateNativeControlUpgradeActiveIdentity(p.review, {
        ...accepted,
        releaseSha: p.review.releaseSha,
      }),
    ).toThrow('ACTIVE_RELEASE_CHANGED');
    const wrong = globalThis.structuredClone(p);
    wrong.offline.stoppedRelease = wrong.offline.candidate;
    expect(() => validateNativeControlUpgradeProofs(wrong)).toThrow(
      'REVIEWED_OFFLINE_REQUIRED',
    );
    expect(() =>
      validateNativeControlUpgradeActiveIdentity(p.review, {
        ...accepted,
        sourceTree: '5'.repeat(40),
      }),
    ).toThrow('ACTIVE_RELEASE_CHANGED');
    const noTree = globalThis.structuredClone(p.review);
    delete noTree.activeReleaseIdentity.sourceTree;
    expect(() =>
      validateNativeControlUpgradeActiveIdentity(noTree, {
        ...accepted,
        sourceTree: undefined,
      }),
    ).not.toThrow();
  });
  it.each([
    (p) => {
      p.artifact.passed = false;
    },
    (p) => {
      p.history.rootReviewed = false;
    },
    (p) => {
      p.history.afterReference = {
        ...p.history.afterReference,
        artifactId: digest('other'),
      };
    },
    (p) => {
      p.artifact.generation = 'unapproved';
    },
    (p) => {
      p.offline.planId = 'different';
    },
    (p) => {
      p.offline.locks[0].path = '/other/qa-validation.lock';
    },
    (p) => {
      p.offline.locks[1].ownerBirth = 'another owner';
    },
    (p) => {
      p.offline.processes[0].stopMode = 'forced';
    },
    (p) => {
      p.offline.processes[1].role = 'web';
    },
    (p) => {
      p.offline.processes[0].exitConfirmedAtMs = 5000;
    },
    (p) => {
      p.offline.expiresAtMs = 1_000_000;
    },
    (p) => {
      p.input.ttlMs = 0;
    },
    (p) => {
      p.input.afterReference = {
        ...p.input.afterReference,
        stateRoot: '/other-root',
      };
    },
    (p) => {
      p.input.extra = 'unreviewed';
    },
  ])(
    'rejects incompatible, missing, stale or misbound root evidence (%#)',
    (mutate) => {
      const p = globalThis.structuredClone(proofs());
      mutate(p);
      expect(() => validateNativeControlUpgradeProofs(p)).toThrow(
        'NATIVE_CONTROL_UPGRADE_',
      );
    },
  );
  it.each([
    (p) => {
      p.input.offlineStoppedAttestation.operatorEvidenceDigest =
        digest('unrelated proof');
    },
    (p) => {
      p.input.offlineStoppedAttestation.observedAtMs++;
    },
    (p) => {
      p.input.plan.artifactEvidence.publicHistoryVerificationDigest =
        digest('unrelated history');
    },
    (p) => {
      p.input.planDigest = digest('different frozen plan');
    },
  ])('rejects apply proof/hash conflicts before DB import (%#)', (mutate) => {
    const p = globalThis.structuredClone(proofs('apply'));
    mutate(p);
    expect(() => validateNativeControlUpgradeProofs(p)).toThrow(
      'NATIVE_CONTROL_UPGRADE_',
    );
  });
  it('pins every compiled database file and refuses symlinked builds', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'index.js'), 'export {};');
    writeFileSync(
      join(dir, 'native-schedule-control-upgrade.js'),
      'export const version=1;',
    );
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'nested', 'client.js'), 'export {};');
    const original = await nativeControlDatabaseDistDigest(dir);
    expect(original).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(
      join(dir, 'nested', 'client.js'),
      'export const changed=true;',
    );
    expect(await nativeControlDatabaseDistDigest(dir)).not.toBe(original);
    symlinkSync(join(dir, 'index.js'), join(dir, 'linked.js'));
    await expect(nativeControlDatabaseDistDigest(dir)).rejects.toThrow(
      'DATABASE_DIST_SYMLINK',
    );
  });
  it('never repeats an uncertain prepare; recovery reads only the original plan ID', async () => {
    const p = proofs(),
      intentPath = join(temp(), 'prepare.intent.json'),
      binding = {
        phase: 'prepare',
        planId: p.offline.planId,
        inputSha256: 'a',
        reviewSha256: 'b',
      };
    const recoveredPlan = {
      planId: p.offline.planId,
      partitionId: p.input.partitionId,
      beforeReference: p.input.beforeReference,
      afterReference: p.input.afterReference,
      artifactEvidence: p.artifactEvidence,
    };
    const api = {
      prepareNativeScheduleControlUpgrade: vi
        .fn()
        .mockRejectedValue(Error('synthetic lost ACK')),
      readNativeScheduleControlUpgrade: vi.fn().mockResolvedValue({
        status: 'plan_only',
        plan: recoveredPlan,
        planDigest: digest(recoveredPlan),
      }),
      nativeOnceDigest: digest,
    };
    const args = {
      api,
      db: { synthetic: true },
      mode: 'prepare',
      phase: 'prepare',
      input: p.input,
      intentPath,
      binding,
      artifactEvidence: p.artifactEvidence,
    };
    await expect(nativeControlUpgradeStep(args)).rejects.toThrow(
      'synthetic lost ACK',
    );
    expect((await nativeControlUpgradeStep(args)).mode).toBe('readback');
    expect(api.prepareNativeScheduleControlUpgrade).toHaveBeenCalledTimes(1);
    expect(api.readNativeScheduleControlUpgrade).toHaveBeenCalledWith({
      db: args.db,
      planId: p.offline.planId,
    });
    const other = {
      ...recoveredPlan,
      afterReference: {
        ...recoveredPlan.afterReference,
        artifactId: digest('unrelated'),
      },
    };
    api.readNativeScheduleControlUpgrade.mockResolvedValue({
      status: 'plan_only',
      plan: other,
      planDigest: digest(other),
    });
    await expect(nativeControlUpgradeStep(args)).rejects.toThrow(
      'PREPARE_READBACK_CONFLICT',
    );
    expect(api.prepareNativeScheduleControlUpgrade).toHaveBeenCalledTimes(1);
  });
  it('persists an apply intent before mutation; unknown results and every later invocation require exact readback', async () => {
    for (const status of ['applied', 'not_applied']) {
      const p = proofs('apply'),
        intentPath = join(temp(), 'apply.intent.json'),
        binding = {
          phase: 'apply',
          planId: p.offline.planId,
          inputSha256: 'a',
          reviewSha256: 'b',
        };
      const approval = {
        kind: 'synthetic-only-approval',
        planDigest: p.input.planDigest,
      };
      const api = {
        applyNativeScheduleControlUpgrade: vi.fn(async () => {
          expect(JSON.parse(readFileSync(intentPath)).binding).toEqual(binding);
          throw Error('synthetic lost COMMIT ACK');
        }),
        readNativeScheduleControlUpgrade: vi.fn().mockResolvedValue({ status }),
        nativeOnceDigest: digest,
      };
      const args = {
        api,
        db: { synthetic: true },
        mode: 'apply',
        phase: 'apply',
        input: p.input,
        approval,
        intentPath,
        binding,
      };
      await expect(nativeControlUpgradeStep(args)).rejects.toThrow(
        'lost COMMIT ACK',
      );
      expect((await nativeControlUpgradeStep(args)).result.status).toBe(status);
      expect(api.applyNativeScheduleControlUpgrade).toHaveBeenCalledTimes(1);
      expect(api.readNativeScheduleControlUpgrade).toHaveBeenLastCalledWith({
        db: args.db,
        planId: p.offline.planId,
        expected: {
          planDigest: p.input.planDigest,
          approvalDigest: digest(approval),
          attestationDigest: digest(p.input.offlineStoppedAttestation),
        },
      });
      await expect(
        nativeControlUpgradeStep({
          ...args,
          binding: { ...binding, reviewSha256: 'tampered' },
        }),
      ).rejects.toThrow('INTENT_CONFLICT');
      expect(api.applyNativeScheduleControlUpgrade).toHaveBeenCalledTimes(1);
    }
  });
  it('explicit readback makes no intent or mutation, and concurrent attempts have only one writer', async () => {
    const p = proofs('apply'),
      intentPath = join(temp(), 'no-write.intent.json'),
      binding = { phase: 'apply', planId: p.offline.planId };
    const api = {
      applyNativeScheduleControlUpgrade: vi
        .fn()
        .mockResolvedValue({ sequence: '1' }),
      readNativeScheduleControlUpgrade: vi
        .fn()
        .mockResolvedValue({ status: 'not_applied' }),
      nativeOnceDigest: digest,
    };
    const args = {
      api,
      db: {},
      mode: 'readback',
      phase: 'apply',
      input: p.input,
      approval: {},
      intentPath,
      binding,
    };
    expect((await nativeControlUpgradeStep(args)).databaseWritten).toBe(false);
    expect(() => readFileSync(intentPath)).toThrow();
    expect(api.applyNativeScheduleControlUpgrade).not.toHaveBeenCalled();
    await Promise.allSettled([
      nativeControlUpgradeStep({ ...args, mode: 'apply' }),
      nativeControlUpgradeStep({ ...args, mode: 'apply' }),
    ]);
    expect(api.applyNativeScheduleControlUpgrade).toHaveBeenCalledTimes(1);
  });
});

describe('exact cloud credential dispatch after the existing source gates', () => {
  it('passes the source-issued credential only to this plan preparation', async () => {
    const directory = temp(),
      credential = { kind: 'synthetic-reviewed-observation' },
      input = {
        requestId: '975a5189-c944-462e-9cd6-923ed205a81a',
        partitionId: 'synthetic-control',
        beforeReference: { artifactId: digest('before') },
        afterReference: { artifactId: digest('after') },
      };
    const api = {
      prepareNativeScheduleControlUpgrade: vi.fn(async () => ({
        acknowledged: true,
      })),
    };
    await nativeControlUpgradeStep({
      api,
      db: { synthetic: true },
      mode: 'prepare',
      phase: 'prepare',
      input,
      approval: null,
      intentPath: join(directory, 'exact.intent.json'),
      binding: { planId: input.requestId },
      artifactEvidence: { synthetic: true },
      historicalCloudAbsenceCredential: credential,
    });
    expect(
      api.prepareNativeScheduleControlUpgrade,
    ).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        requestId: input.requestId,
        historicalCloudAbsenceCredential: credential,
      }),
    );
  });
  it('retains its durable intent and reads back after unknown credential/plan COMMIT without another write', async () => {
    const directory = temp(),
      credential = { kind: 'synthetic-reviewed-observation' },
      input = {
        requestId: '775a5189-c944-462e-9cd6-923ed205a81a',
        partitionId: 'synthetic-control',
        beforeReference: { artifactId: digest('before') },
        afterReference: { artifactId: digest('after') },
      };
    const api = {
      prepareNativeScheduleControlUpgrade: vi.fn(async () => {
        throw Error('synthetic lost COMMIT');
      }),
      readNativeScheduleControlUpgrade: vi.fn(async () => ({
        status: 'not_found',
      })),
    };
    const request = {
      api,
      db: { synthetic: true },
      mode: 'prepare',
      phase: 'prepare',
      input,
      approval: null,
      intentPath: join(directory, 'exact.intent.json'),
      binding: { planId: input.requestId },
      artifactEvidence: { synthetic: true },
      historicalCloudAbsenceCredential: credential,
    };
    await expect(nativeControlUpgradeStep(request)).rejects.toThrow(
      'synthetic lost COMMIT',
    );
    expect((await nativeControlUpgradeStep(request)).mode).toBe('readback');
    expect(api.prepareNativeScheduleControlUpgrade).toHaveBeenCalledTimes(1);
    expect(
      api.readNativeScheduleControlUpgrade,
    ).toHaveBeenCalledExactlyOnceWith({
      db: request.db,
      planId: input.requestId,
    });
  });
});
