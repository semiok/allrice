import { describe, expect, it } from 'vitest';

import {
  BridgeCommandPayloadSchema,
  CompleteBridgeCommandInputSchema,
  CompleteBridgeWorkspaceSelectionInputSchema,
} from './bridge.js';

describe('Rice Bridge contracts', () => {
  it('accepts structured local capabilities and rejects arbitrary shell', () => {
    expect(
      BridgeCommandPayloadSchema.parse({
        capability: 'local.fs.read',
        arguments: { path: 'src/index.ts' },
      }),
    ).toMatchObject({
      capability: 'local.fs.read',
      arguments: { path: 'src/index.ts', maxBytes: 200_000 },
    });
    expect(() =>
      BridgeCommandPayloadSchema.parse({
        capability: 'local.shell',
        arguments: { command: 'whoami' },
      }),
    ).toThrow();
  });

  it('validates guarded text writes and directory creation', () => {
    expect(
      BridgeCommandPayloadSchema.parse({
        capability: 'local.fs.write',
        arguments: {
          path: 'src/index.ts',
          content: 'export const rice = true;\n',
          expectedSha256:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      }),
    ).toMatchObject({ capability: 'local.fs.write' });
    expect(
      BridgeCommandPayloadSchema.parse({
        capability: 'local.fs.mkdir',
        arguments: { path: 'src/new-module' },
      }),
    ).toMatchObject({ capability: 'local.fs.mkdir' });
  });

  it('rejects absolute and parent-traversing paths', () => {
    for (const path of ['/etc/passwd', '../secret', 'src/../../secret']) {
      expect(() =>
        BridgeCommandPayloadSchema.parse({
          capability: 'local.fs.read',
          arguments: { path },
        }),
      ).toThrow();
    }
  });

  it('requires an error code for failed results', () => {
    expect(() =>
      CompleteBridgeCommandInputSchema.parse({
        leaseToken: '9f437b6c-cbd8-4ba5-86d4-cb6119789f1d',
        status: 'failed',
        summary: 'failed',
      }),
    ).toThrow();
  });

  it('requires a grant for successful native workspace selection', () => {
    expect(() =>
      CompleteBridgeWorkspaceSelectionInputSchema.parse({
        leaseToken: '9f437b6c-cbd8-4ba5-86d4-cb6119789f1d',
        status: 'succeeded',
      }),
    ).toThrow();
    expect(
      CompleteBridgeWorkspaceSelectionInputSchema.parse({
        leaseToken: '9f437b6c-cbd8-4ba5-86d4-cb6119789f1d',
        status: 'succeeded',
        grantId: '53b852df-f389-4d37-b9d0-e1d6773921a2',
      }),
    ).toMatchObject({ status: 'succeeded' });
  });
});
