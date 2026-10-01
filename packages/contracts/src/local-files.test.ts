import { describe, expect, it } from 'vitest';
import {
  BridgeCommandPayloadSchema,
  BridgeCapabilities,
  HeartbeatBridgeDeviceInputSchema,
} from './bridge.ts';
import {
  LocalFilePathSchema,
  LocalFilePayloadSchema,
  LocalFileResultSchema,
  localFileMaximumBytes,
  localFileResultMatchesPayload,
} from './local-files.ts';

const expected = {
  checksum: `sha256:${'a'.repeat(64)}`,
  version: `sha256:${'b'.repeat(64)}`,
  sizeBytes: 8,
  mediaType: 'application/pdf',
};
describe('binary file metadata is bounded and bound to the exact action', () => {
  it('preserves Chinese/spaces and rejects absolute paths, traversal, executable arguments and embedded bytes', () => {
    expect(LocalFilePathSchema.parse('中文 目录/报告.pdf')).toBe(
      '中文 目录/报告.pdf',
    );
    for (const path of [
      '/tmp/report.pdf',
      '../report.pdf',
      '资料/../report.pdf',
      '资料//report.pdf',
      'a\\b',
      'a\0b',
    ])
      expect(() => LocalFilePathSchema.parse(path)).toThrow();
    expect(() =>
      BridgeCommandPayloadSchema.parse({
        capability: 'local.file.save',
        arguments: { path: '报告.pdf', contentBase64: 'UEs=' },
      }),
    ).toThrow();
    expect(() =>
      LocalFilePayloadSchema.parse({
        capability: 'local.file.open',
        arguments: { path: '报告.pdf', expected, command: 'open arbitrary' },
      }),
    ).toThrow();
  });
  it('rejects forged destinations, versions and capability/result substitutions', () => {
    const payload = LocalFilePayloadSchema.parse({
      capability: 'local.file.open',
      arguments: { path: '报告.pdf', expected },
    });
    const output = LocalFileResultSchema.parse({
      contractVersion: 1,
      status: 'opened',
      path: '报告.pdf',
      file: expected,
      object: null,
      localSaved: false,
      platformUploaded: false,
    });
    expect(localFileResultMatchesPayload(payload, output)).toBe(true);
    for (const forged of [
      { ...output, path: '别的.pdf' },
      { ...output, file: { ...expected, version: expected.checksum } },
      { ...output, status: 'revealed' as const },
    ])
      expect(localFileResultMatchesPayload(payload, forged)).toBe(false);
    expect(() =>
      LocalFileResultSchema.parse({ ...output, localSaved: true }),
    ).toThrow();
    expect(() =>
      LocalFileResultSchema.parse({
        ...output,
        file: { ...expected, sizeBytes: localFileMaximumBytes + 1 },
      }),
    ).toThrow();
  });
  it('keeps current protocol v2 and legacy v1 heartbeats with their original capabilities', () => {
    expect(
      HeartbeatBridgeDeviceInputSchema.parse({
        protocolVersion: 1,
        capabilities: ['local.fs.read'],
      }),
    ).toMatchObject({ protocolVersion: 1 });
    expect(
      HeartbeatBridgeDeviceInputSchema.parse({
        protocolVersion: 2,
        capabilities: BridgeCapabilities,
      }),
    ).toMatchObject({ protocolVersion: 2 });
  });
});
