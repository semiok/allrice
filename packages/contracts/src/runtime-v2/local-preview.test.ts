import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LocalBrowserWorkspaceSchema } from './local-browser.ts';
import {
  localPreviewOrigin,
  localPreviewUrlAllowed,
  reservedLocalPreviewUrl,
  LocalPreviewTargetSchema,
} from './local-preview.ts';
describe('P23 preview capability contract', () => {
  const endpointId = randomUUID();
  const target = LocalPreviewTargetSchema.parse({
    version: 1,
    endpointId,
    scope: {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      projectId: null,
    },
    ownerId: randomUUID(),
    deviceId: randomUUID(),
    runId: randomUUID(),
    rootRunId: randomUUID(),
    browserWorkspaceId: randomUUID(),
    browserProfileId: randomUUID(),
    browserGrantId: randomUUID(),
    processId: randomUUID(),
    attemptId: randomUUID(),
    generation: 1,
    fence: 1,
    processInputDigest: 'sha256:' + 'a'.repeat(64),
    folderGrantId: randomUUID(),
    folderGrantVersion: 1,
    containerId: 'b'.repeat(64),
    imageDigest: 'sha256:' + 'c'.repeat(64),
    port: 3100,
    hardDeadlineAt: new Date().toISOString(),
  });
  it('allows only the exact dedicated virtual HTTPS origin', () => {
    expect(
      localPreviewUrlAllowed(
        target,
        localPreviewOrigin(endpointId) + '/app.js?version=1',
      ),
    ).toBe(true);
    for (const url of [
      'http://127.0.0.1:3100',
      'http://localhost:3100',
      'https://example.com',
      localPreviewOrigin(randomUUID()),
      localPreviewOrigin(endpointId) + ':8443/',
      localPreviewOrigin(endpointId) + '/#secret',
      localPreviewOrigin(endpointId).replace('https://', 'https://user@'),
      localPreviewOrigin(endpointId) + '/\nsecret',
    ])
      expect(localPreviewUrlAllowed(target, url)).toBe(false);
  });
  it('reserves the whole internal namespace including bare/trailing-dot variants', () => {
    for (const url of [
      'https://preview.allrice.invalid',
      'https://PREVIEW.ALLRICE.INVALID.',
      'http://other.preview.allrice.invalid',
      localPreviewOrigin(endpointId),
    ])
      expect(reservedLocalPreviewUrl(url)).toBe(true);
    expect(
      reservedLocalPreviewUrl('https://preview.allrice.invalid.example.com'),
    ).toBe(false);
  });
  it('never accepts unbound arbitrary ports, container names, or extra tunnel destinations', () => {
    for (const overrides of [
      { port: 80 },
      { containerId: 'some-container' },
      { destination: 'http://localhost:5432' },
      { generation: -1 },
    ])
      expect(
        LocalPreviewTargetSchema.safeParse({ ...target, ...overrides }).success,
      ).toBe(false);
  });
  it('browser transport rejects preview scope/profile/grant/lifetime mismatches and ambient file or credential permissions', () => {
    const expiresAt = new Date(Date.now() + 4000).toISOString(),
      hardDeadlineAt = new Date(Date.now() + 60000).toISOString();
    const t = { ...target, hardDeadlineAt },
      w = {
        id: t.browserWorkspaceId,
        scope: t.scope,
        ownerId: t.ownerId,
        deviceId: t.deviceId,
        runId: t.runId,
        rootRunId: t.rootRunId,
        sessionId: randomUUID(),
        profileId: t.browserProfileId,
        logicalProfileId: randomUUID(),
        grantId: t.browserGrantId,
        grantRevision: 1,
        persistLogin: false,
        profile: { version: 1, origins: [localPreviewOrigin(t.endpointId)] },
        fence: 1,
        acknowledgedFence: 0,
        state: 'starting',
        desiredControl: 'agent',
        expiresAt: hardDeadlineAt,
        revoked: false,
        preview: { target: t, endpointLeaseId: randomUUID(), expiresAt },
      };
    expect(LocalBrowserWorkspaceSchema.safeParse(w).success).toBe(true);
    for (const extra of [
      { deviceId: randomUUID() },
      { profileId: randomUUID() },
      { grantId: randomUUID() },
      { runId: randomUUID() },
      { persistLogin: true },
      { scope: { ...t.scope, workspaceId: randomUUID() } },
      { profile: { ...w.profile, allowUploads: true } },
      { profile: { ...w.profile, origins: ['https://example.com'] } },
      { expiresAt: new Date(Date.now() + 1000).toISOString() },
    ])
      expect(
        LocalBrowserWorkspaceSchema.safeParse({ ...w, ...extra }).success,
      ).toBe(false);
  });
});
