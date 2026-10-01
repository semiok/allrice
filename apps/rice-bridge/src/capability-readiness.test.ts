import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
