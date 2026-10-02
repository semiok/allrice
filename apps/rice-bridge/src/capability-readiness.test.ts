import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  BridgeCapabilities,
  HeartbeatBridgeDeviceInputSchema,
  RuntimeLocalPythonProfileSchema,
  managedPythonPayloadForPlatform,
  RuntimeLocalPdfProfileSchema,
  pdfReadReleaseForPlatform,
} from '@allrice/contracts';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  projectBridgeCapabilityReadiness,
  probeBridgeFiles,
  readinessErrorCode,
} from './capability-readiness.js';

const facts = {
  environment: {
    version: 1 as const,
    clientVersion: 'fixture',
    browser: 'ready' as const,
    sandbox: 'unavailable' as const,
    preview: 'unavailable' as const,
    paused: false,
  },
  nativeMac: true,
  phase: 'online',
  files: {
    folder: true,
    writable: true,
    folderReason: 'folder_missing',
    gitVersion: '2.45.1',
  },
  activeForeground: 0,
  activeBrowsers: 0,
  operationLedgerEnabled: true,
  browserVersion: '140.0.0',
};
describe('Bridge per-capability facts', () => {
  it.each([
    'ready',
    'busy',
    'preparing',
    'paused',
    'offline',
    'unsupported',
  ] as const)(
    'reports independent readonly PDF %s with a real bounded heartbeat shape',
    (state) => {
      const profile = RuntimeLocalPdfProfileSchema.parse({
        contractVersion: 1,
        profileVersion: 1,
        backend: 'native-seatbelt-v1',
        platform: 'macos-x64',
        pins: pdfReadReleaseForPlatform('macos-x64')!.pins,
        available: true,
        readOnly: true,
        ocr: false,
        stopConfirmed: true,
        isolation: {
          network: 'none',
          hostFileAccess: 'none',
          childExecution: 'none',
          memoryEnforcement: 'watchdog',
          resourceBudgetBytes: 512 * 1024 * 1024,
          watchdogThresholdBytes: 512 * 1024 * 1024,
          timeoutMs: 30000,
          deniedHostRead: true,
          deniedHostWrite: true,
          deniedNetwork: true,
          deniedChildExecution: true,
        },
        limits: {
          inputBytes: 20 * 1024 * 1024,
          resultBytes: 400000,
          maximumPages: 10,
          maximumCharacters: 300000,
        },
      });
      const environment = {
        ...facts.environment,
        paused: state === 'paused',
        settings: {
          localBrowser: false,
          localCommand: false,
          development: false,
        },
      };
      const reports = projectBridgeCapabilityReadiness({
        ...facts,
        environment,
        files: { ...facts.files, folder: false, writable: false },
        phase: state === 'offline' ? 'offline' : 'online',
        activeForeground: state === 'busy' ? 1 : 0,
        managedPdf: {
          state:
            state === 'preparing' || state === 'unsupported' ? state : 'ready',
          profile,
          reason:
            state === 'unsupported'
              ? 'PDF_RESOURCE_INTEGRITY_FAILED'
              : state === 'preparing'
                ? 'runtime_preparing'
                : 'ready',
        },
      });
      expect(
        reports.find((r) => r.capability === 'local.pdf.read'),
      ).toMatchObject({
        state,
        versions: { parser: '2.4.5', architecture: 'macos-x64' },
      });
      expect(reports.every((r) => Object.keys(r.versions).length <= 8)).toBe(
        true,
      );
      expect(
        HeartbeatBridgeDeviceInputSchema.safeParse({
          protocolVersion: 2,
          capabilities: BridgeCapabilities,
          environment: { ...environment, readiness: reports },
        }).success,
      ).toBe(true);
    },
  );
  it('does not inherit folder readiness or Node/Python readiness without a PDF probe', () => {
    const reports = projectBridgeCapabilityReadiness(facts);
    expect(
      reports.find((r) => r.capability === 'local.pdf.read'),
    ).toMatchObject({
      state: 'unsupported',
      reason: 'pdf_runtime_not_reported',
    });
  });
  it.each(['ready', 'busy', 'paused', 'offline'] as const)(
    'keeps a full managed Python profile within the heartbeat contract while %s',
    (state) => {
      const release = managedPythonPayloadForPlatform('macos-x64')!;
      const profile = RuntimeLocalPythonProfileSchema.parse({
        contractVersion: 1,
        profileVersion: 1,
        backend: 'local-vm-container-v1',
        imageId: release.imageId,
        architecture: release.architecture,
        pythonVersion: release.pythonVersion,
        packagesChecksum: release.packagesChecksum,
        officeCheckerChecksum: release.officeChecker.sha256,
        pngCheckerChecksum: release.pngChecker.sha256,
        fontChecksum: release.font.sha256,
        available: true,
        purposes: ['office', 'python_charts'],
        officeGeneration: true,
        officeFormulaCalculation: false,
        officePreview: false,
        stopConfirmed: true,
      });
      const environment = {
        ...facts.environment,
        settings: {
          localBrowser: true,
          localCommand: state !== 'paused',
          development: true,
        },
      };
      const reports = projectBridgeCapabilityReadiness({
        ...facts,
        environment,
        phase: state === 'offline' ? 'offline' : 'online',
        activeForeground: state === 'busy' ? 1 : 0,
        managedPython: {
          state: state === 'paused' ? 'paused' : 'ready',
          reason: state === 'paused' ? 'capability_paused' : 'ready',
          profile,
        },
      });
      for (const capability of ['local.office', 'local.python'] as const) {
        expect(reports.find((r) => r.capability === capability)).toMatchObject({
          state,
          versions: {
            bridge: facts.environment.clientVersion,
            node: process.versions.node,
            backend: profile.backend,
            image: profile.imageId,
            architecture: profile.architecture,
            python: profile.pythonVersion,
            profile: '1',
            packages: profile.packagesChecksum,
          },
        });
      }
      expect(
        reports.every((report) => Object.keys(report.versions).length <= 8),
      ).toBe(true);
      expect(
        HeartbeatBridgeDeviceInputSchema.safeParse({
          protocolVersion: 2,
          capabilities: BridgeCapabilities,
          environment: { ...environment, readiness: reports },
        }).success,
      ).toBe(true);
      // Full checker/font identities remain in the separate runtime profile.
      expect(profile).toMatchObject({
        officeCheckerChecksum: release.officeChecker.sha256,
        pngCheckerChecksum: release.pngChecker.sha256,
        fontChecksum: release.font.sha256,
      });
    },
  );
  it('keeps files/browser usable independently of absent sandbox and Office', () => {
    const reports = projectBridgeCapabilityReadiness(facts);
    expect(reports.find((r) => r.capability === 'local.fs.read')).toMatchObject(
      { state: 'ready' },
    );
    expect(
      reports.find((r) => r.capability === 'local.file.save'),
    ).toMatchObject({ state: 'ready', versions: { binaryFiles: '1' } });
    expect(reports.find((r) => r.capability === 'local.browser')).toMatchObject(
      { state: 'ready', versions: { chromium: '140.0.0' } },
    );
    expect(reports.find((r) => r.capability === 'local.process')).toMatchObject(
      { state: 'unsupported', missing: ['sandbox_unavailable'] },
    );
    expect(reports.find((r) => r.capability === 'local.office')).toMatchObject({
      state: 'unsupported',
      reason: 'office_not_implemented',
    });
  });
  it('projects activity, pauses, preparation, disconnection and missing git separately', () => {
    expect(
      projectBridgeCapabilityReadiness({ ...facts, activeBrowsers: 1 }).find(
        (r) => r.capability === 'local.browser',
      )?.state,
    ).toBe('busy');
    expect(
      projectBridgeCapabilityReadiness({
        ...facts,
        environment: { ...facts.environment, browser: 'preparing' },
      }).find((r) => r.capability === 'local.browser')?.state,
    ).toBe('preparing');
    expect(
      projectBridgeCapabilityReadiness({
        ...facts,
        environment: {
          ...facts.environment,
          settings: {
            localBrowser: false,
            localCommand: true,
            development: true,
          },
        },
      }).find((r) => r.capability === 'local.browser')?.state,
    ).toBe('paused');
    expect(
      projectBridgeCapabilityReadiness({ ...facts, phase: 'offline' }).find(
        (r) => r.capability === 'local.fs.read',
      )?.state,
    ).toBe('offline');
    expect(
      projectBridgeCapabilityReadiness({
        ...facts,
        files: { ...facts.files, gitVersion: undefined },
      }).find((r) => r.capability === 'local.git.status'),
    ).toMatchObject({ state: 'unsupported', missing: ['git_missing'] });
    expect(
      projectBridgeCapabilityReadiness({ ...facts, nativeMac: false }).every(
        (r) => r.state === 'unsupported',
      ),
    ).toBe(true);
  });
  it('probes a granted Chinese path and detects a moved root without reading its files', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'allrice-readiness-'));
    const root = await realpath(parent);
    const config = {
      server: 'https://synthetic.invalid/',
      deviceId: 'synthetic',
      deviceName: 'fixture',
      grants: [
        {
          id: 'synthetic',
          label: '中文资料',
          rootPath: root,
          rootFingerprint: createHash('sha256').update(root).digest('hex'),
        },
      ],
    };
    try {
      expect(await probeBridgeFiles(config)).toMatchObject({
        folder: true,
        writable: true,
      });
      await rename(root, `${root}-中文资料`);
      expect(await probeBridgeFiles(config)).toMatchObject({
        folder: false,
        folderReason: 'folder_unavailable',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(`${root}-中文资料`, { recursive: true, force: true });
    }
  });
  it('does not leak raw exception paths into reported reasons', () => {
    expect(
      readinessErrorCode(
        new Error('/Users/private/secret.json: no access'),
        'sandbox_unavailable',
      ),
    ).toBe('sandbox_unavailable');
    expect(
      readinessErrorCode({ code: 'TOOLCHAIN_CHANGED' }, 'sandbox_unavailable'),
    ).toBe('TOOLCHAIN_CHANGED');
  });
  it('does not advertise writes when their existing operation ledger is disabled', () => {
    const reports = projectBridgeCapabilityReadiness({
      ...facts,
      operationLedgerEnabled: false,
    });
    expect(reports.find((r) => r.capability === 'local.fs.read')).toMatchObject(
      { state: 'ready' },
    );
    expect(
      reports.find((r) => r.capability === 'local.fs.write'),
    ).toMatchObject({
      state: 'unsupported',
      missing: ['operation_ledger_disabled'],
    });
  });
});
