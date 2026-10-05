/** Trusted operator archive only. HTTP callers must authenticate before this
 * bounded read. No commands, user paths, uploads, test runner or tenant writes. */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import {
  collectQualityEvidence,
  type RegressionScenario,
  type Source,
  type VitestEvidence,
} from './platform-quality-evidence.ts';
import { qualityRegressionScenarios } from './platform-quality-scenarios.ts';
import {
  RegressionEvidenceSchema,
  type RegressionEvidence,
} from './platform-quality-evidence-contracts.ts';
const digest = (bytes: string | Buffer) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const SourceSchema = z
  .object({
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    treeDigest: Digest,
    dirty: z.boolean(),
  })
  .strict();
const FileRef = z
  .object({ file: z.string().regex(/^[a-f0-9]{64}\.json$/), checksum: Digest })
  .strict();
const Manifest = z
  .object({
    version: z.literal(1),
    deployedSource: SourceSchema,
    records: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-f0-9]{64}$/),
            capture: FileRef,
            summary: FileRef,
            registry: FileRef,
            report: FileRef,
            originals: z.array(FileRef).max(8),
            execution: FileRef.optional(),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();
type ManifestValue = z.infer<typeof Manifest>;
const Registry = z
  .array(
    z
      .object({
        id: z.string().max(150),
        title: z.string().max(200),
        group: z.enum(['native', 'postgres', 'office']),
        input: z.string().max(1500),
        expected: z.string().max(1500),
        files: z
          .array(
            z
              .string()
              .regex(/^[A-Za-z0-9_./-]+$/)
              .refine(
                (path) => !isAbsolute(path) && !path.split('/').includes('..'),
              ),
          )
          .min(1)
          .max(8),
        assertionTags: z.array(z.string().max(200)).max(8).optional(),
        boundary: z.string().max(1500),
      })
      .strict(),
  )
  .min(1)
  .max(100);
const CaptureSchema = z
  .object({
    version: z.literal(1),
    group: z.enum(['native', 'postgres', 'office']),
    capturedAt: z.string().datetime({ offset: true }),
    registryDigest: Digest,
    source: SourceSchema,
    versions: z.record(z.string(), z.unknown()),
    registrySnapshot: Registry.optional(),
  })
  .strict();
const Execution = z
  .object({
    version: z.literal(1),
    captureChecksum: Digest,
    reportChecksum: Digest,
    executionExitCode: z.number().int().nonnegative(),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict();
type Ref = z.infer<typeof FileRef>;
const bounded = (path: string, maximum = 32_000_000) => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum)
      throw Error('EVIDENCE_READ_LIMIT');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw Error('EVIDENCE_FILE_CHANGED');
      offset += count;
    }
    const after = fstatSync(fd);
    if (
      readSync(fd, Buffer.alloc(1), 0, 1, offset) ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw Error('EVIDENCE_FILE_CHANGED');
    return bytes;
  } finally {
    closeSync(fd);
  }
};
const parse = (bytes: Buffer): unknown => JSON.parse(bytes.toString('utf8'));
function sourceRoot(
  report: VitestEvidence,
  registry: readonly RegressionScenario[],
) {
  const roots = new Set<string>();
  for (const suite of report.testResults)
    for (const file of registry.flatMap((r) => r.files))
      if (isAbsolute(suite.name) && suite.name.endsWith('/' + file))
        roots.add(suite.name.slice(0, -file.length));
  if (roots.size > 1) throw Error('EVIDENCE_MIXED_SOURCE_ROOT');
  return roots.values().next().value ?? '.';
}
function reports(report: unknown) {
  return z
    .object({
      startTime: z.number().finite(),
      success: z.boolean(),
      testResults: z
        .array(
          z
            .object({
              name: z.string().max(4096),
              status: z.string().max(30),
              assertionResults: z
                .array(
                  z
                    .object({
                      // Existing parameterized Vitest names reach 16,112 chars.
                      // Preserve originals within a finite field and byte budget.
                      fullName: z.string().max(32768),
                      status: z.string().max(30),
                      failureMessages: z.array(z.string()).optional(),
                    })
                    .passthrough(),
                )
                .max(20000),
            })
            .passthrough(),
        )
        .max(2000),
      originalReports: z
        .array(
          z.object({ path: z.string().max(4096), checksum: Digest }).strict(),
        )
        .max(8)
        .optional(),
    })
    .passthrough()
    .parse(report);
}

function readBundle(
  directory: string | undefined,
  releaseSha: string | undefined,
  suppliedManifest?: ManifestValue,
): RegressionEvidence {
  const deployedSha = /^[a-f0-9]{40}$/.test(releaseSha ?? '')
    ? releaseSha!
    : null;
  const empty = (state: RegressionEvidence['state']): RegressionEvidence => ({
    schemaVersion: 1,
    state,
    deployedSha,
    currentDevAcceptance: 'not_claimed',
    records: [],
  });
  if (!directory) return empty('not_configured');
  try {
    if (!isAbsolute(directory)) return empty('invalid');
    const root = realpathSync(directory);
    if (
      !suppliedManifest &&
      realpathSync(join(root, 'bundle.json')) !== join(root, 'bundle.json')
    )
      throw Error('EVIDENCE_SYMLINK');
    const manifest =
      suppliedManifest ??
      Manifest.parse(parse(bounded(join(root, 'bundle.json'), 100_000)));
    if (
      new Set(manifest.records.map((r) => r.id)).size !==
      manifest.records.length
    )
      throw Error('EVIDENCE_DUPLICATE');
    let totalBytes = 0;
    const cache = new Map<string, Buffer>();
    function read(ref: Ref) {
      if (ref.file !== ref.checksum.slice(7) + '.json')
        throw Error('EVIDENCE_REFERENCE_INVALID');
      const existing = cache.get(ref.file);
      if (existing) return existing;
      if (cache.size >= 64) throw Error('EVIDENCE_FILE_LIMIT');
      const path = join(root, ref.file);
      if (realpathSync(path) !== path || dirname(path) !== root)
        throw Error('EVIDENCE_SYMLINK');
      const size = statSync(path).size;
      if (totalBytes + size > 64_000_000) throw Error('EVIDENCE_TOTAL_LIMIT');
      const bytes = bounded(path);
      if (totalBytes + bytes.length > 64_000_000)
        throw Error('EVIDENCE_TOTAL_LIMIT');
      totalBytes += bytes.length;
      if (digest(bytes) !== ref.checksum) throw Error('EVIDENCE_CHECKSUM');
      cache.set(ref.file, bytes);
      return bytes;
    }
    const records = manifest.records.map(
      (record): RegressionEvidence['records'][number] => {
        const capture = CaptureSchema.parse(parse(read(record.capture)));
        const registry = Registry.parse(parse(read(record.registry)));
        if (capture.registryDigest !== digest(JSON.stringify(registry)))
          throw Error('EVIDENCE_REGISTRY');
        if (
          capture.registrySnapshot &&
          JSON.stringify(capture.registrySnapshot) !== JSON.stringify(registry)
        )
          throw Error('EVIDENCE_REGISTRY');
        const report = reports(parse(read(record.report)));
        const originals = new Map(
          record.originals.map((ref) => [ref.checksum, read(ref)]),
        );
        if ((report.originalReports?.length ?? 0) !== record.originals.length)
          throw Error('EVIDENCE_ORIGINAL_REPORTS');
        for (const ref of report.originalReports ?? [])
          if (!originals.has(ref.checksum))
            throw Error('EVIDENCE_ORIGINAL_REPORTS');
        if (report.originalReports) {
          const actual = report.originalReports.map((ref) =>
            reports(parse(originals.get(ref.checksum)!)),
          );
          if (
            !isDeepStrictEqual(
              report.testResults,
              actual.flatMap((r) => r.testResults),
            ) ||
            report.startTime !== Math.min(...actual.map((r) => r.startTime)) ||
            report.success !== actual.every((r) => r.success)
          )
            throw Error('EVIDENCE_COMBINED_REPORT');
        }
        const summary = z
          .object({
            recordedAt: z.string().datetime({ offset: true }),
            originalReport: z.object({
              path: z.string().max(4096),
              checksum: Digest,
            }),
            executionExitCode: z.number().int().nonnegative(),
          })
          .passthrough()
          .parse(parse(read(record.summary)));
        const execution = record.execution
          ? Execution.parse(parse(read(record.execution)))
          : null;
        if (
          execution &&
          (execution.captureChecksum !== record.capture.checksum ||
            execution.reportChecksum !== record.report.checksum ||
            Date.parse(execution.recordedAt) < report.startTime ||
            Date.parse(execution.recordedAt) > Date.parse(summary.recordedAt))
        )
          throw Error('EVIDENCE_EXECUTION_RECEIPT');
        if (
          record.id !== record.summary.checksum.slice(7) ||
          summary.originalReport.checksum !== record.report.checksum
        )
          throw Error('EVIDENCE_SUMMARY');
        const expected = collectQualityEvidence({
          capture,
          registry,
          current: capture.source,
          report,
          reportChecksum: record.report.checksum,
          reportPath: summary.originalReport.path,
          exitCode: execution?.executionExitCode ?? summary.executionExitCode,
          cwd: sourceRoot(report, registry),
        });
        // Recompute with the original registry and report. Only recording time is
        // retained; no browser-supplied verdict or wider passing scope is trusted.
        if (
          !isDeepStrictEqual(
            { ...expected, recordedAt: summary.recordedAt },
            summary,
          )
        )
          throw Error('EVIDENCE_SUMMARY_MISMATCH');
        const releaseConfirmed =
          deployedSha === manifest.deployedSource.sha &&
          !manifest.deployedSource.dirty;
        const materialConfirmed =
          releaseConfirmed &&
          capture.source.treeDigest === manifest.deployedSource.treeDigest;
        const semver = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
        const versionFormats: Record<string, RegExp> = {
          node: /^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/,
          dshAgent: semver,
          dshWeb: semver,
          officeConversionPackage: semver,
          actualBridgeVersion: semver,
          officeSkillPin:
            /^@deepseek-ai\/dsh-skill-office@\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/,
          actualOfficeImage:
            /^(?:sha256:[a-f0-9]{64}|[A-Za-z0-9][A-Za-z0-9._/-]{0,100}@sha256:[a-f0-9]{64})$/,
        };
        const safeVersion = (key: string) =>
          typeof capture.versions[key] === 'string' &&
          (capture.versions[key] as string).length <= 150 &&
          versionFormats[key]?.test(capture.versions[key] as string)
            ? (capture.versions[key] as string)
            : null;
        return {
          id: record.id,
          group: capture.group,
          source: capture.source,
          relation: materialConfirmed
            ? capture.source.sha === deployedSha && !capture.source.dirty
              ? 'exact_source'
              : 'same_material'
            : releaseConfirmed
              ? 'historical'
              : 'unconfirmed',
          capturedAt: capture.capturedAt,
          recordedAt: summary.recordedAt,
          registryDigest: capture.registryDigest,
          originalReportChecksum: record.report.checksum,
          executionExitStatus: execution ? 'confirmed' : 'not_recorded',
          runnerSucceeded: !!execution && expected.runnerSucceeded,
          fullyVerified: !!execution && expected.fullyVerified,
          passedScenarioCount: expected.passedScenarioCount,
          scenarioCount: expected.scenarioCount,
          versions: {
            node: safeVersion('node'),
            dshAgent: safeVersion('dshAgent'),
            dshWeb: safeVersion('dshWeb'),
            officeSkillPin: safeVersion('officeSkillPin'),
            officeConversionPackage: safeVersion('officeConversionPackage'),
            lockDigest: Digest.safeParse(capture.versions.lockDigest).success
              ? (capture.versions.lockDigest as string)
              : null,
            actualOfficeImage: safeVersion('actualOfficeImage'),
            actualBridgeVersion: safeVersion('actualBridgeVersion'),
          },
          scenarios: expected.scenarios.map((s) => ({
            id: s.id,
            title: s.title,
            status: s.status,
            boundary: s.boundary,
            inputDigest: s.inputDigest,
            assertionDigest: s.assertionDigest,
            executed: s.results.reduce((n, r) => n + r.executed, 0),
            skipped: s.results.reduce((n, r) => n + r.skipped, 0),
          })),
          scope: expected.scope,
          physicalDeviceValidation: 'not_executed',
          realModelUsed: false,
        };
      },
    );
    return RegressionEvidenceSchema.parse({
      schemaVersion: 1,
      state: 'available',
      deployedSha,
      currentDevAcceptance: 'not_claimed',
      records,
    });
  } catch (error) {
    return empty(
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'not_configured'
        : 'invalid',
    );
  }
}

export function readQualityEvidenceBundle(
  directory: string | undefined,
  releaseSha: string | undefined,
) {
  return readBundle(directory, releaseSha);
}

/** Operator CLI builds a content-addressed archive and switches its index last. */
export function bundleQualityEvidence(input: {
  directory: string;
  deployedSource: Source;
  summaries: string[];
  registries?: string[];
}) {
  const root = resolve(input.directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const suppliedRegistries = [
    qualityRegressionScenarios,
    ...(input.registries ?? []).map((p) =>
      Registry.parse(parse(bounded(resolve(p), 200_000))),
    ),
  ];
  if (!input.summaries.length || input.summaries.length > 12)
    throw Error('EVIDENCE_RECORD_LIMIT');
  function archive(bytes: Buffer): Ref {
    const checksum = digest(bytes),
      file = checksum.slice(7) + '.json',
      path = join(root, file);
    try {
      writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        digest(bounded(path)) !== checksum
      )
        throw error;
    }
    return { file, checksum };
  }
  const records: ManifestValue['records'] = input.summaries.map((path) => {
    const summaryPath = resolve(path),
      parent = dirname(summaryPath),
      summaryBytes = bounded(summaryPath),
      summary = z
        .object({
          originalReport: z.object({
            path: z.string().max(4096),
            checksum: Digest,
          }),
        })
        .passthrough()
        .parse(parse(summaryBytes));
    const captureBytes = bounded(join(parent, 'capture.json'), 200_000),
      capture = CaptureSchema.parse(parse(captureBytes));
    const registry =
      capture.registrySnapshot ??
      suppliedRegistries.find(
        (r) => digest(JSON.stringify(r)) === capture.registryDigest,
      );
    if (!registry) throw Error('EVIDENCE_ORIGINAL_REGISTRY_REQUIRED');
    const reportBytes = bounded(
      join(parent, basename(summary.originalReport.path)),
    );
    if (digest(reportBytes) !== summary.originalReport.checksum)
      throw Error('EVIDENCE_REPORT_CHECKSUM');
    const report = reports(parse(reportBytes));
    const originals = (report.originalReports ?? []).map((r) => {
      const bytes = bounded(join(parent, basename(r.path)));
      if (digest(bytes) !== r.checksum) throw Error('EVIDENCE_REPORT_CHECKSUM');
      return archive(bytes);
    });
    const summaryRef = archive(summaryBytes);
    let execution: Ref | undefined;
    try {
      execution = archive(bounded(join(parent, 'execution.json'), 200_000));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return {
      id: summaryRef.checksum.slice(7),
      capture: archive(captureBytes),
      summary: summaryRef,
      registry: archive(Buffer.from(JSON.stringify(registry))),
      report: archive(reportBytes),
      originals,
      ...(execution ? { execution } : {}),
    };
  });
  const value = Manifest.parse({
    version: 1,
    deployedSource: input.deployedSource,
    records,
  });
  const proof = readBundle(root, input.deployedSource.sha, value);
  if (proof.state !== 'available') throw Error('EVIDENCE_BUNDLE_INVALID');
  const temporary = join(root, `${randomUUID()}.pending`);
  writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  renameSync(temporary, join(root, 'bundle.json'));
  return proof;
}
