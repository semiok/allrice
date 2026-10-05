/** Thin evidence adapter for existing Vitest reports. Never executes a command,
 * accesses a tenant database, or accepts a browser-supplied passing receipt. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  qualityRegressionScenarios,
  qualityScenarioRegistryVersion,
  type QualityRegressionGroup,
} from '../../../packages/database/src/platform-quality-scenarios.ts';
import { managedPythonPayloadsV1 } from '../../../packages/contracts/src/managed-python-payload.ts';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const digest = (bytes: string | Buffer) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
type Source = ReturnType<typeof currentSource>;
type Capture = {
  version: 1;
  group: QualityRegressionGroup;
  capturedAt: string;
  registryDigest: string;
  source: Source;
  versions: Record<string, unknown>;
};
type Assertion = {
  fullName: string;
  status: string;
  failureMessages?: string[];
};
type Suite = {
  name: string;
  status: string;
  assertionResults: Assertion[];
};
export type VitestEvidence = {
  startTime: number;
  success: boolean;
  testResults: Suite[];
};
export function currentSource(cwd = root) {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('SOURCE_SHA_UNAVAILABLE');
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd },
  )
    .toString()
    .split('\0')
    .filter(Boolean);
  const hash = createHash('sha256');
  for (const name of [...new Set(files)].sort()) {
    const path = resolve(cwd, name);
    // A deleted tracked file contributes a tombstone, never an older Git blob.
    let bytes: Buffer;
    let missing = false;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw Error('SOURCE_FILE_UNREADABLE');
      missing = true;
      bytes = Buffer.alloc(0);
    }
    hash
      .update(name)
      .update('\0')
      .update(`${missing ? 'missing' : 'present'}:${bytes.length}:`)
      .update(bytes)
      .update('\0');
  }
  return {
    sha,
    treeDigest: 'sha256:' + hash.digest('hex'),
    dirty: !!execFileSync('git', ['status', '--porcelain=v1'], {
      cwd,
      encoding: 'utf8',
    }).trim(),
  };
}
export function collectQualityEvidence(input: {
  capture: Capture;
  current: Source;
  report: VitestEvidence;
  reportChecksum: string;
  reportPath: string;
  exitCode: number;
  cwd?: string;
}) {
  const { capture, current, report } = input;
  if (
    capture.version !== 1 ||
    !['native', 'postgres', 'office'].includes(capture.group)
  )
    throw Error('CAPTURE_INVALID');
  if (
    !Number.isFinite(Date.parse(capture.capturedAt)) ||
    !Number.isInteger(input.exitCode) ||
    input.exitCode < 0
  )
    throw Error('CAPTURE_INVALID');
  if (
    capture.registryDigest !==
    digest(JSON.stringify(qualityRegressionScenarios))
  )
    throw Error('REGISTRY_CHANGED');
  if (
    capture.source.sha !== current.sha ||
    capture.source.treeDigest !== current.treeDigest
  )
    throw Error('SOURCE_CHANGED');
  if (
    !Number.isFinite(report.startTime) ||
    report.startTime < Date.parse(capture.capturedAt) ||
    !Array.isArray(report.testResults)
  )
    throw Error('REPORT_MISSING_OR_OLDER_THAN_CAPTURE');
  const cwd = input.cwd ?? root;
  const suites = new Map<string, Suite>();
  for (const suite of report.testResults) {
    if (
      typeof suite.name !== 'string' ||
      !Array.isArray(suite.assertionResults)
    )
      throw Error('REPORT_INVALID');
    const path = isAbsolute(suite.name)
      ? relative(cwd, suite.name)
      : suite.name;
    if (suites.has(path)) throw Error('REPORT_DUPLICATE_SUITE');
    suites.set(path, suite);
  }
  const scenarios = qualityRegressionScenarios
    .filter((s) => s.group === capture.group)
    .map((scenario) => {
      const results = scenario.files.map((file) => {
        const suite = suites.get(file);
        const tags =
          'assertionTags' in scenario ? scenario.assertionTags : null;
        const assertions = (suite?.assertionResults ?? [])
          .filter((a) => !tags || tags.some((tag) => a.fullName.includes(tag)))
          .map((a) => {
            if (
              !a.fullName ||
              ![
                'passed',
                'failed',
                'pending',
                'skipped',
                'todo',
                'disabled',
              ].includes(a.status)
            )
              throw Error('ASSERTION_INVALID');
            const failures = a.failureMessages ?? [];
            return {
              name: a.fullName,
              status:
                a.status === 'failed'
                  ? failures.some((m) => /^AssertionError:/m.test(m))
                    ? 'assertion_failed'
                    : 'execution_failed'
                  : a.status === 'passed'
                    ? 'passed'
                    : 'skipped',
              // Logs remain in the original controlled test artifact. Do not copy
              // raw errors, received values or credentials into a display summary.
              failureDigest: failures.length
                ? digest(JSON.stringify(failures))
                : null,
            };
          });
        return {
          file,
          matched: !!suite,
          suiteStatus: suite?.status ?? 'missing',
          assertions,
          executed: assertions.filter((a) => a.status !== 'skipped').length,
          skipped: assertions.filter((a) => a.status === 'skipped').length,
        };
      });
      const failure = results
        .flatMap((r) => r.assertions)
        .find((a) =>
          ['assertion_failed', 'execution_failed'].includes(a.status),
        );
      const missing = results.some(
        (r) => !r.matched || r.assertions.length === 0,
      );
      const none = results.every((r) => r.executed === 0);
      const suiteFailed = results.some(
        (r) => r.matched && r.suiteStatus === 'failed',
      );
      const status =
        failure?.status ??
        (suiteFailed
          ? 'execution_failed'
          : missing
            ? 'unknown'
            : none
              ? 'skipped'
              : results.some((r) => r.skipped || r.executed === 0)
                ? 'partially_verified'
                : results.some((r) => r.suiteStatus !== 'passed')
                  ? 'execution_failed'
                  : 'passed');
      return {
        ...scenario,
        status,
        results,
        inputDigest: digest(scenario.input),
        assertionDigest: digest(scenario.expected),
        reproduction: [
          'pnpm',
          'exec',
          'vitest',
          'run',
          '--maxWorkers=1',
          ...scenario.files,
        ],
      };
    });
  return {
    version: qualityScenarioRegistryVersion,
    capturedAt: capture.capturedAt,
    recordedAt: new Date().toISOString(),
    source: capture.source,
    group: capture.group,
    versions: capture.versions,
    registryDigest: capture.registryDigest,
    originalReport: { path: input.reportPath, checksum: input.reportChecksum },
    executionExitCode: input.exitCode,
    runnerSucceeded: input.exitCode === 0 && report.success === true,
    fullyVerified:
      input.exitCode === 0 &&
      report.success === true &&
      scenarios.length > 0 &&
      scenarios.every((s) => s.status === 'passed'),
    passedScenarioCount: scenarios.filter((s) => s.status === 'passed').length,
    scenarioCount: scenarios.length,
    scenarios,
    physicalDeviceValidation: 'not_executed',
    realModelUsed: false,
    employeeAndSkillVersions: 'synthetic_fixture_only',
    scope:
      capture.group === 'office'
        ? 'Fixed native cloud Office VM assertions and joined PG/HTTP delivery only; not Bridge devices, arbitrary projects, real model quality or current Dev acceptance.'
        : 'Existing fixture assertions only; not arbitrary projects, native Office software, real model quality or current Dev acceptance.',
  };
}
function jsonFile(path: string) {
  if (statSync(path).size > 30_000_000) throw Error('EVIDENCE_TOO_LARGE');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function save(path: string, data: unknown) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}
async function main() {
  const [action, ...args] = process.argv.slice(2);
  const options = Object.fromEntries(
    args.map((arg) => {
      const m = /^--([a-z-]+)=(.+)$/.exec(arg);
      if (!m) throw Error('ARGUMENT_INVALID');
      return [m[1]!, m[2]!];
    }),
  );
  if (!options.output) throw Error('OUTPUT_REQUIRED');
  if (action === 'capture') {
    if (!['native', 'postgres', 'office'].includes(options.group ?? ''))
      throw Error('GROUP_REQUIRED');
    const worker = jsonFile(resolve(root, 'apps/worker/package.json'));
    const web = jsonFile(resolve(root, 'apps/web/package.json'));
    const office = jsonFile(
      resolve(root, 'packages/office-runtime/package.json'),
    );
    save(options.output, {
      version: 1,
      group: options.group as QualityRegressionGroup,
      capturedAt: new Date().toISOString(),
      registryDigest: digest(JSON.stringify(qualityRegressionScenarios)),
      source: currentSource(),
      versions: {
        node: process.version,
        dshAgent: worker.dependencies['@deepseek-ai/dsh-agent'],
        dshWeb: web.dependencies['@deepseek-ai/dsh-client-ui-chat'],
        officeSkillPin: managedPythonPayloadsV1[0]!.officeChecker.upstream,
        officeConversionPackage:
          office.dependencies['@deepseek-ai/dsh-office-to-pdf'],
        lockDigest: digest(readFileSync(resolve(root, 'pnpm-lock.yaml'))),
        actualOfficeImage: null,
        actualBridgeVersion: null,
      },
    } satisfies Capture);
  } else if (action === 'collect') {
    if (
      !options.capture ||
      !!options.report === !!options['reports-dir'] ||
      !/^\d+$/.test(options['exit-code'] ?? '')
    )
      throw Error('COLLECT_ARGUMENTS_REQUIRED');
    if (options['reports-dir']) {
      const directory = resolve(options['reports-dir']);
      const paths = readdirSync(directory)
        .filter((name) => /^vitest-[a-z-]+\.json$/.test(name))
        .sort()
        .map((name) => resolve(directory, name));
      if (!paths.length) throw Error('REPORT_MISSING');
      const inputs = paths.map((path) => ({
        path,
        checksum: digest(readFileSync(path)),
        report: jsonFile(path) as VitestEvidence,
      }));
      options.report = resolve(directory, 'combined-report.json');
      save(options.report, {
        startTime: Math.min(...inputs.map((v) => v.report.startTime)),
        success: inputs.every((v) => v.report.success === true),
        testResults: inputs.flatMap((v) => v.report.testResults),
        originalReports: inputs.map(({ path, checksum }) => ({
          path,
          checksum,
        })),
      });
    }
    if (!options.report) throw Error('REPORT_MISSING');
    const bytes = readFileSync(options.report);
    const report = collectQualityEvidence({
      capture: jsonFile(options.capture),
      current: currentSource(),
      report: jsonFile(options.report),
      reportChecksum: digest(bytes),
      reportPath: resolve(options.report),
      exitCode: Number(options['exit-code']),
    });
    save(options.output, report);
    if (
      !report.runnerSucceeded ||
      report.scenarios.some((s) =>
        ['unknown', 'assertion_failed', 'execution_failed', 'skipped'].includes(
          s.status,
        ),
      )
    )
      process.exitCode = 1;
  } else throw Error('ACTION_INVALID');
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error: unknown) => {
    console.error(
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : 'EVIDENCE_COLLECTION_FAILED',
    );
    process.exitCode = 1;
  });
}
