import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { qualityRegressionScenarios } from '../../../packages/database/src/platform-quality-scenarios.ts';
import {
  collectQualityEvidence,
  type VitestEvidence,
} from './quality-scenarios.ts';
const source = {
  sha: 'a'.repeat(40),
  treeDigest: 'sha256:' + 'b'.repeat(64),
  dirty: false,
};
const capture = {
  version: 1 as const,
  group: 'native' as const,
  source,
  versions: { model: 'synthetic-only', bridge: null },
  capturedAt: new Date(1).toISOString(),
  registryDigest:
    'sha256:' +
    createHash('sha256')
      .update(JSON.stringify(qualityRegressionScenarios))
      .digest('hex'),
};
function input() {
  const files = [
    ...new Set(
      qualityRegressionScenarios
        .filter((s) => s.group === 'native')
        .flatMap((s) => s.files),
    ),
  ];
  return {
    capture,
    current: source,
    exitCode: 0,
    reportChecksum: 'sha256:' + 'c'.repeat(64),
    reportPath: 'original-vitest.json',
    cwd: '/repo',
    report: {
      startTime: 2,
      success: true,
      testResults: files.map((name) => ({
        name: '/repo/' + name,
        status: 'passed',
        assertionResults: [{ fullName: 'fixed assertion', status: 'passed' }],
      })),
    } satisfies VitestEvidence,
  };
}
describe('versioned existing-runner evidence boundaries', () => {
  it('requires each mapped suite and preserves exact source/runner scope without claiming a physical/model check', () => {
    const args = input();
    const report = collectQualityEvidence(args);
    expect(report.fullyVerified).toBe(true);
    expect(report.physicalDeviceValidation).toBe('not_executed');
    expect(report.realModelUsed).toBe(false);
    args.report.testResults.pop();
    const missing = collectQualityEvidence(args);
    expect(missing.fullyVerified).toBe(false);
    expect(missing.scenarios.some((s) => s.status === 'unknown')).toBe(true);
  });
  it('does not turn exit zero, an empty suite or skipped assertions into passed coverage', () => {
    const args = input();
    args.report.testResults[0]!.assertionResults[0]!.status = 'pending';
    expect(collectQualityEvidence(args).fullyVerified).toBe(false);
    expect(collectQualityEvidence(args).scenarios[0]!.status).toBe(
      'partially_verified',
    );
    args.report.testResults[0]!.assertionResults = [];
    expect(collectQualityEvidence(args).scenarios[0]!.status).toBe('unknown');
    const crashed = input();
    crashed.exitCode = 1;
    crashed.report.success = false;
    expect(collectQualityEvidence(crashed).runnerSucceeded).toBe(false);
    expect(collectQualityEvidence(crashed).fullyVerified).toBe(false);
    crashed.report.testResults[0]!.status = 'failed';
    crashed.report.testResults[0]!.assertionResults[0]!.status = 'pending';
    expect(collectQualityEvidence(crashed).scenarios[0]!.status).toBe(
      'execution_failed',
    );
  });
  it('distinguishes failed assertions from execution errors and does not expose raw failures', () => {
    const args = input();
    expect(() =>
      collectQualityEvidence({
        ...args,
        capture: { ...capture, capturedAt: 'invalid' },
      }),
    ).toThrow('CAPTURE_INVALID');
    args.report.testResults[0]!.assertionResults = [
      {
        fullName: 'fixed failure',
        status: 'failed',
        failureMessages: ['AssertionError: private-credential-value'],
      },
    ];
    expect(collectQualityEvidence(args).scenarios[0]!.status).toBe(
      'assertion_failed',
    );
    expect(JSON.stringify(collectQualityEvidence(args))).not.toContain(
      'private-credential-value',
    );
    args.report.testResults[0]!.assertionResults[0]!.failureMessages = [
      'Error: fixture crashed',
    ];
    expect(collectQualityEvidence(args).scenarios[0]!.status).toBe(
      'execution_failed',
    );
  });
  it('keeps tagged native Office coverage separate from an unexecuted physical check or a passing text turn', () => {
    const args = input();
    const scenario = qualityRegressionScenarios.find(
      (s) => s.id === 'office.native-delivery.v1',
    )!;
    const report: VitestEvidence = {
      startTime: 2,
      success: true,
      testResults: [
        {
          name: '/repo/' + scenario.files[0],
          status: 'passed',
          assertionResults: [
            {
              fullName: 'chat.production-two-turn.v1: text only',
              status: 'passed',
            },
            {
              fullName: 'office.native-delivery.v1: native XLSX',
              status: 'pending',
            },
          ],
        },
      ],
    };
    const collected = () =>
      collectQualityEvidence({
        ...args,
        capture: { ...capture, group: 'office' },
        report,
      });
    expect(
      collected().scenarios.find((s) => s.id === scenario.id)?.status,
    ).toBe('skipped');
    expect(collected().fullyVerified).toBe(false);
    report.testResults[0]!.assertionResults.pop();
    expect(
      collected().scenarios.find((s) => s.id === scenario.id)?.status,
    ).toBe('unknown');
    report.testResults[0]!.assertionResults.push({
      fullName: 'office.native-delivery.v1: native XLSX',
      status: 'passed',
    });
    expect(
      collected().scenarios.find((s) => s.id === scenario.id)?.status,
    ).toBe('passed');
    expect(collected().fullyVerified).toBe(false); // The separate three-format suite is still missing.
  });
  it('rejects mismatched versions and historical, duplicate or malformed reports', () => {
    const args = input();
    expect(() =>
      collectQualityEvidence({
        ...args,
        current: { ...source, treeDigest: 'sha256:' + 'd'.repeat(64) },
      }),
    ).toThrow('SOURCE_CHANGED');
    expect(() =>
      collectQualityEvidence({
        ...args,
        capture: { ...capture, registryDigest: 'changed' },
      }),
    ).toThrow('REGISTRY_CHANGED');
    args.report.startTime = 0;
    expect(() => collectQualityEvidence(args)).toThrow(
      'REPORT_MISSING_OR_OLDER_THAN_CAPTURE',
    );
    args.report.startTime = 2;
    args.report.testResults.push(args.report.testResults[0]!);
    expect(() => collectQualityEvidence(args)).toThrow(
      'REPORT_DUPLICATE_SUITE',
    );
  });
});
