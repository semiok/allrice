import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bundleQualityEvidence,
  readQualityEvidenceBundle,
} from './platform-quality-evidence-bundle.ts';
import {
  collectQualityEvidence,
  type Capture,
  type Source,
  type VitestEvidence,
} from './platform-quality-evidence.ts';
const hash = (bytes: string | Buffer) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
const source: Source = {
  sha: 'a'.repeat(40),
  treeDigest: 'sha256:' + 'b'.repeat(64),
  dirty: false,
};
const registry = [
  {
    id: 'test.historical.v1',
    title: '历史固定场景',
    group: 'native' as const,
    input: '固定样例',
    expected: '核对原报告',
    files: ['tests/old.test.ts'],
    boundary: '替身断言，不证明当前 Dev 验收。',
  },
];
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(
  status = 'passed',
  capturedSource = source,
  options: {
    receipt?: boolean;
    exitCode?: number;
    versions?: Record<string, unknown>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'allrice-evidence-bundle-'));
  roots.push(root);
  const inputs = join(root, 'inputs'),
    archive = join(root, 'archive');
  mkdirSync(inputs);
  const save = (name: string, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    writeFileSync(join(inputs, name), bytes);
    return hash(bytes);
  };
  const capture: Capture = {
    version: 1,
    group: 'native',
    capturedAt: new Date(1).toISOString(),
    source: capturedSource,
    registryDigest: hash(JSON.stringify(registry)),
    versions: {
      node: 'v22.23.2',
      dshAgent: '0.1.5-rc.3',
      credential: 'private-secret',
      dshWeb: '/Users/private path',
      ...options.versions,
    },
  };
  const captureHash = save('capture.json', capture);
  save('registry.json', registry);
  const report: VitestEvidence = {
    startTime: 2,
    success: status !== 'failed',
    testResults: [
      {
        name: '/private/repo/tests/old.test.ts',
        status: 'passed',
        assertionResults: [
          {
            fullName: 'private-test-name',
            status,
            failureMessages:
              status === 'failed' ? ['AssertionError: private-secret'] : [],
          },
        ],
      },
    ],
  };
  const originalHash = save('vitest-old.json', report);
  const combined = {
    ...report,
    originalReports: [
      { path: '/private/repo/.local/vitest-old.json', checksum: originalHash },
    ],
  };
  const combinedHash = save('combined-report.json', combined);
  const exitCode = options.exitCode ?? (status === 'failed' ? 1 : 0);
  if (options.receipt !== false)
    save('execution.json', {
      version: 1,
      captureChecksum: captureHash,
      reportChecksum: combinedHash,
      executionExitCode: exitCode,
      recordedAt: new Date().toISOString(),
    });
  const summary = collectQualityEvidence({
    capture,
    current: capturedSource,
    registry,
    report: combined,
    reportChecksum: combinedHash,
    reportPath: '/private/repo/.local/combined-report.json',
    exitCode,
    cwd: '/private/repo',
  });
  save('summary.json', summary);
  const bundle = (deployedSource = source) =>
    bundleQualityEvidence({
      directory: archive,
      deployedSource,
      summaries: [join(inputs, 'summary.json')],
      registries: [join(inputs, 'registry.json')],
    });
  return { root, inputs, archive, bundle, summary, report, save };
}
type TestManifest = {
  records: { originals: { file: string }[]; report: { file: string } }[];
};
function editManifest(directory: string, edit: (m: TestManifest) => void) {
  const path = join(directory, 'bundle.json'),
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  edit(manifest);
  writeFileSync(path, JSON.stringify(manifest));
}
describe('bounded original regression archive and public projection', () => {
  it('filters path and credential-URL sentinels from every recognized version field', () => {
    const f = fixture('passed', source, {
      versions: {
        node: '/Users/private-secret',
        dshAgent: 'https://operator:private-secret@model.example/v1',
        dshWeb: '/tmp/private-secret',
        officeSkillPin: '/Users/private-secret/office',
        officeConversionPackage: 'https://private-secret@example.test',
        actualBridgeVersion: '/tmp/private-secret',
        actualOfficeImage:
          'https://operator:private-secret@registry.example/image',
      },
    });
    const evidence = f.bundle();
    expect(evidence.state).toBe('available');
    expect(JSON.stringify(evidence)).not.toContain('private-secret');
    expect(
      Object.values(evidence.records[0]!.versions).every((v) => v === null),
    ).toBe(true);
  });
  it('accepts an original historical registry without exposing paths, test names, failure logs or extra version fields', () => {
    const f = fixture('failed');
    const evidence = f.bundle();
    expect(evidence.state).toBe('available');
    expect(evidence.currentDevAcceptance).toBe('not_claimed');
    expect(evidence.records[0]).toMatchObject({
      relation: 'exact_source',
      runnerSucceeded: false,
      fullyVerified: false,
      passedScenarioCount: 0,
      scenarios: [{ status: 'assertion_failed' }],
    });
    const publicJson = JSON.stringify(evidence);
    for (const privateValue of [
      'private-secret',
      'private-test-name',
      '/private/repo',
      'failureMessages',
      '/Users/private',
    ])
      expect(publicJson).not.toContain(privateValue);
    expect(evidence.records[0]!.versions.dshWeb).toBeNull();
    expect(readQualityEvidenceBundle(f.archive, source.sha)).toEqual(evidence);
  });
  it('retains both source SHAs, material equality and dirty/historical/unknown boundaries', () => {
    const f = fixture('passed', { ...source, sha: 'c'.repeat(40) });
    expect(f.bundle().records[0]).toMatchObject({
      relation: 'same_material',
      source: { sha: 'c'.repeat(40) },
    });
    expect(
      readQualityEvidenceBundle(f.archive, 'd'.repeat(40)).records[0]!.relation,
    ).toBe('unconfirmed');
    expect(
      f.bundle({ ...source, treeDigest: 'sha256:' + 'e'.repeat(64) })
        .records[0]!.relation,
    ).toBe('historical');
    expect(f.bundle({ ...source, dirty: true }).records[0]!.relation).toBe(
      'unconfirmed',
    );
    const dirty = fixture('passed', { ...source, dirty: true });
    expect(dirty.bundle().records[0]).toMatchObject({
      relation: 'same_material',
      source: { dirty: true },
    });
    expect(readQualityEvidenceBundle(undefined, source.sha).state).toBe(
      'not_configured',
    );
    const legacy = fixture('passed', source, { receipt: false });
    expect(legacy.bundle().records[0]).toMatchObject({
      executionExitStatus: 'not_recorded',
      runnerSucceeded: false,
      fullyVerified: false,
      passedScenarioCount: 1,
    });
  });
  it('does not promote success JSON after a nonzero runner exit by rewriting only the summary', () => {
    const f = fixture('passed', source, { exitCode: 1 });
    expect(f.bundle().records[0]).toMatchObject({
      executionExitStatus: 'confirmed',
      runnerSucceeded: false,
      fullyVerified: false,
      passedScenarioCount: 1,
    });
    f.save('summary.json', {
      ...f.summary,
      executionExitCode: 0,
      runnerSucceeded: true,
      fullyVerified: true,
    });
    expect(() => f.bundle()).toThrow('EVIDENCE_BUNDLE_INVALID');
  });
  it('cannot promote a skipped scenario by rewriting and rehashing the summary; failed candidate leaves prior index untouched', () => {
    const f = fixture('pending');
    const proof = f.bundle();
    expect(proof.records[0]).toMatchObject({
      fullyVerified: false,
      scenarios: [{ status: 'skipped' }],
    });
    const prior = readFileSync(join(f.archive, 'bundle.json'));
    f.save('summary.json', {
      ...f.summary,
      fullyVerified: true,
      passedScenarioCount: 1,
      scenarios: f.summary.scenarios.map((s) => ({ ...s, status: 'passed' })),
    });
    expect(() => f.bundle()).toThrow('EVIDENCE_BUNDLE_INVALID');
    expect(readFileSync(join(f.archive, 'bundle.json'))).toEqual(prior);
    expect(
      readQualityEvidenceBundle(f.archive, source.sha).records[0]!
        .fullyVerified,
    ).toBe(false);
  });
  it('verifies original bytes and concatenation, not just summary and combined-report checksums', () => {
    const f = fixture();
    f.bundle();
    editManifest(f.archive, (m) => {
      const ref = m.records[0]!.originals[0]!;
      writeFileSync(join(f.archive, ref.file), 'tampered');
    });
    expect(readQualityEvidenceBundle(f.archive, source.sha)).toMatchObject({
      state: 'invalid',
      records: [],
    });
    const g = fixture();
    // Rehash a different combined report and regenerate its summary; the actual
    // original report still has a different assertion, so the bundle must fail.
    const originalHash = hash(readFileSync(join(g.inputs, 'vitest-old.json')));
    const modified = {
      ...g.report,
      testResults: [],
      originalReports: [
        { path: '/private/vitest-old.json', checksum: originalHash },
      ],
    };
    const reportHash = g.save('combined-report.json', modified);
    g.save('summary.json', {
      ...g.summary,
      originalReport: {
        path: '/private/combined-report.json',
        checksum: reportHash,
      },
    });
    expect(() => g.bundle()).toThrow('EVIDENCE_BUNDLE_INVALID');
  });
  it('rejects symlink, traversal, oversized or missing archived inputs without retaining passing records', () => {
    const f = fixture();
    f.bundle();
    const m = JSON.parse(readFileSync(join(f.archive, 'bundle.json'), 'utf8')),
      path = join(f.archive, m.records[0].report.file);
    const external = join(f.root, 'external.json');
    writeFileSync(external, readFileSync(path));
    rmSync(path);
    symlinkSync(external, path);
    expect(readQualityEvidenceBundle(f.archive, source.sha).state).toBe(
      'invalid',
    );
    editManifest(f.archive, (manifest) => {
      manifest.records[0]!.report.file = '../external.json';
    });
    expect(readQualityEvidenceBundle(f.archive, source.sha).state).toBe(
      'invalid',
    );
    const g = fixture();
    g.bundle();
    const gm = JSON.parse(readFileSync(join(g.archive, 'bundle.json'), 'utf8')),
      gp = join(g.archive, gm.records[0].report.file);
    truncateSync(gp, 32_000_001);
    expect(readQualityEvidenceBundle(g.archive, source.sha).state).toBe(
      'invalid',
    );
    rmSync(gp);
    expect(readQualityEvidenceBundle(g.archive, source.sha).records).toEqual(
      [],
    );
  });
});
