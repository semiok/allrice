import { describe, expect, it } from 'vitest';

import {
  BridgeCommandPayloadSchema,
  CompleteBridgeCommandInputSchema,
} from './bridge.js';

describe('Rice Bridge v0.1 contracts', () => {
  it('accepts only the five structured read-only capabilities', () => {
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
});
