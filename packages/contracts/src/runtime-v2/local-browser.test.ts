import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  LocalBrowserCaptureSchema,
  LocalBrowserClaimSchema,
  LocalBrowserHttpRequestSchema,
} from './local-browser.ts';
describe('P22 device controller contract boundaries', () => {
  it('claim separately requests work vs revocation-only and never accepts a job lease or target shell', () => {
    const request = {
      kind: 'claim',
      controllerId: randomUUID(),
      acceptWork: false,
    };
    expect(LocalBrowserHttpRequestSchema.safeParse(request).success).toBe(true);
    for (const extra of [
      { jobLeaseToken: randomUUID() },
      { executable: '/bin/sh' },
      { profilePath: '/Users/private' },
    ])
      expect(
        LocalBrowserHttpRequestSchema.safeParse({ ...request, ...extra })
          .success,
      ).toBe(false);
  });
  it('rejects a detached lease without its browser workspace', () => {
    expect(
      LocalBrowserClaimSchema.safeParse({
        workspace: null,
        lease: {
          workspaceId: randomUUID(),
          token: randomUUID(),
          expiresAt: new Date().toISOString(),
        },
        revocations: [],
      }).success,
    ).toBe(false);
  });
  it('handover capture is scoped to exact workspace/fence/observation while download requires START lease', () => {
    const owned = {
      workspaceId: randomUUID(),
      controllerLeaseToken: randomUUID(),
    };
    expect(
      LocalBrowserCaptureSchema.safeParse({
        kind: 'screenshot',
        ...owned,
        fence: 3,
        observationId: randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      LocalBrowserCaptureSchema.safeParse({
        kind: 'download',
        ...owned,
        fileName: 'file.bin',
        mediaType: 'application/octet-stream',
      }).success,
    ).toBe(false);
  });
  it('intercepted POST approval binds exact digest and one physical request id, without raw body/credentials', () => {
    const request = {
      kind: 'request_approval',
      workspaceId: randomUUID(),
      controllerLeaseToken: randomUUID(),
      requestId: randomUUID(),
      operationId: randomUUID(),
      operationLeaseToken: randomUUID(),
      effect: {
        url: 'https://site.example/submit',
        urlDigest: 'sha256:' + 'a'.repeat(64),
        method: 'POST',
        bodyDigest: 'sha256:' + 'b'.repeat(64),
        bodyBytes: 200,
      },
    };
    expect(LocalBrowserHttpRequestSchema.safeParse(request).success).toBe(true);
    expect(
      LocalBrowserHttpRequestSchema.safeParse({
        ...request,
        effect: { ...request.effect, body: 'secret' },
      }).success,
    ).toBe(false);
    expect(
      LocalBrowserHttpRequestSchema.safeParse({
        ...request,
        requestId: undefined,
      }).success,
    ).toBe(false);
  });
});
