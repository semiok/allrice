import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  BrowserProfileSchema,
  BrowserObservationSchema,
  BrowserCommandSchema,
  BrowserHttpRequestSchema,
  browserOriginAllowed,
  browserObservationCurrent,
} from './browser-control.ts';
describe('P21 cloud and Bridge reusable control envelope', () => {
  it('defaults deny sensitive capabilities; exact HTTPS origin, no wildcard/subdomain/port/userinfo', () => {
    const p = BrowserProfileSchema.parse({
      version: 1,
      origins: ['https://site.example'],
    });
    expect(p.allowHumanCredentials).toBe(false);
    expect(p.allowUploads).toBe(false);
    expect(browserOriginAllowed('https://site.example/path?q=1', p)).toBe(true);
    for (const url of [
      'https://child.site.example/',
      'https://site.example:444/',
      'http://site.example/',
      'https://user:pass@site.example/',
      'data:text/html,1',
    ])
      expect(browserOriginAllowed(url, p)).toBe(false);
    expect(
      BrowserProfileSchema.safeParse({ version: 1, origins: ['invalid'] })
        .success,
    ).toBe(false);
  });
  it('observation freshness binds profile/fence and cannot be forged by future timestamps', () => {
    const o = BrowserObservationSchema.parse({
      version: 1,
      id: randomUUID(),
      profileId: randomUUID(),
      fence: 2,
      revision: 1,
      capturedAt: new Date(1000).toISOString(),
      expiresAt: new Date(2000).toISOString(),
      url: 'about:blank',
      title: '',
      text: '',
      pageDigest: 'sha256:' + 'a'.repeat(64),
      elements: [],
      screenshotObjectId: null,
    });
    expect(
      browserObservationCurrent(o, {
        profileId: o.profileId,
        fence: 2,
        now: 1500,
      }),
    ).toBe(true);
    for (const now of [999, 2000])
      expect(
        browserObservationCurrent(o, { profileId: o.profileId, fence: 2, now }),
      ).toBe(false);
    expect(
      browserObservationCurrent(o, {
        profileId: o.profileId,
        fence: 1,
        now: 1500,
      }),
    ).toBe(false);
  });
  it('public ingress cannot impersonate agent or forge intercepted request; no arbitrary JS or selectors', () => {
    const c = {
      version: 1,
      workspaceId: randomUUID(),
      profileId: randomUUID(),
      actor: 'human',
      fence: 1,
      observationId: randomUUID(),
      action: { type: 'click', elementId: 'e1' },
    };
    expect(
      BrowserHttpRequestSchema.safeParse({
        kind: 'act',
        requestId: randomUUID(),
        command: c,
      }).success,
    ).toBe(true);
    expect(
      BrowserHttpRequestSchema.safeParse({
        kind: 'act',
        requestId: randomUUID(),
        command: { ...c, actor: 'agent' },
      }).success,
    ).toBe(false);
    expect(
      BrowserCommandSchema.safeParse({
        ...c,
        action: { type: 'evaluate', script: '1' },
      }).success,
    ).toBe(false);
    expect(
      BrowserCommandSchema.safeParse({
        ...c,
        action: { type: 'click', elementId: 'e1', selector: 'body' },
      }).success,
    ).toBe(false);
  });
});
