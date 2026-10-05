/** Pure adapter over original Vitest results. Shared by the operator CLI and
 * read-only evidence reader; it never executes tests or accesses a database. */
import { createHash } from 'node:crypto';
import { relative, isAbsolute } from 'node:path';
import {
  qualityRegressionScenarios,
  qualityScenarioRegistryVersion,
  type QualityRegressionGroup,
} from './platform-quality-scenarios.ts';
const digest = (bytes: string | Buffer) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
export type Source = { sha: string; treeDigest: string; dirty: boolean };
export type RegressionScenario = {
  id: string;
  title: string;
  group: QualityRegressionGroup;
  input: string;
  expected: string;
  files: readonly string[];
  assertionTags?: readonly string[];
  boundary: string;
};
export type Capture = {
  version: 1;
  group: QualityRegressionGroup;
  capturedAt: string;
  registryDigest: string;
  source: Source;
  versions: Record<string, unknown>;
  registrySnapshot?: readonly RegressionScenario[];
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
type EvidenceStatus =
  | 'passed'
  | 'assertion_failed'
  | 'execution_failed'
  | 'unknown'
  | 'skipped'
  | 'partially_verified';
export type VitestEvidence = {
  startTime: number;
  success: boolean;
  testResults: Suite[];
};
export function collectQualityEvidence(input: {
  capture: Capture;
  current: Source;
  report: VitestEvidence;
  reportChecksum: string;
  reportPath: string;
  exitCode: number;
  cwd?: string;
  registry?: readonly RegressionScenario[];
}) {
  const { capture, current, report } = input;
  const registry = input.registry ?? qualityRegressionScenarios;
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
  if (capture.registryDigest !== digest(JSON.stringify(registry)))
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
  const cwd = input.cwd ?? '.';
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
  const scenarios = registry
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
            const status: EvidenceStatus =
              a.status === 'failed'
                ? failures.some((m) => /^AssertionError:/m.test(m))
                  ? 'assertion_failed'
                  : 'execution_failed'
                : a.status === 'passed'
                  ? 'passed'
                  : 'skipped';
            return {
              name: a.fullName,
              status,
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
      const status: EvidenceStatus =
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
