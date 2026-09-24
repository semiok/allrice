import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  BrowserProfileSchema,
  BrowserObservationSchema,
  BrowserCommandSchema,
  BrowserHttpRequestSchema,
  browserOriginAllowed,
  browserObservationCurrent,
  browserObservationIsFresh,
  browserObservationLifetimeMs,
} from './browser-control.ts';
describe('P21 cloud and Bridge reusable control envelope', () => {
  it('shares the same bounded positive lifetime for renderer and cloud/local admission', () => {
    const capturedAt = new Date(10_000).toISOString();
    expect(browserObservationLifetimeMs).toBe(60_000);
    for (const lifetime of [1, 60_000]) {
      expect(
        browserObservationIsFresh(
          { capturedAt, expiresAt: new Date(10_000 + lifetime).toISOString() },
          10_000,
        ),
      ).toBe(true);
    }
    for (const lifetime of [-1, 0, 60_001, 120_000]) {
      expect(
        browserObservationIsFresh(
          { capturedAt, expiresAt: new Date(10_000 + lifetime).toISOString() },
          10_000,
        ),
      ).toBe(false);
    }
    expect(
      browserObservationIsFresh(
        { capturedAt, expiresAt: new Date(11_000).toISOString() },
        8_999,
      ),
    ).toBe(false);
    expect(
      browserObservationIsFresh(
        { capturedAt, expiresAt: new Date(11_000).toISOString() },
        11_000,
      ),
    ).toBe(false);
    expect(
      browserObservationIsFresh(
        { capturedAt: 'bad', expiresAt: 'bad' },
        10_000,
      ),
    ).toBe(false);
  });
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
  it('platform public HTTPS profiles remove website setup while retaining URL and legacy origin constraints', () => {
    const profile = BrowserProfileSchema.parse({
      version: 1,
      network: 'public_https',
      origins: [],
    });
    for (const url of ['https://example.com/', 'https://example.org/a'])
      expect(browserOriginAllowed(url, profile)).toBe(true);
    for (const url of [
      'http://example.com/',
      'https://example.com:444/',
      'https://user:secret@example.com/',
      'file:///tmp/private',
    ])
      expect(browserOriginAllowed(url, profile)).toBe(false);
    expect(
      BrowserProfileSchema.safeParse({ version: 1, origins: [] }).success,
    ).toBe(false);
    // DNS/public-address pinning is independently exercised in the production cloud driver.
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
