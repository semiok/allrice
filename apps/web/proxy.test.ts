import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isBridgeDeviceApiPath, proxy } from './proxy.js';
import { createPortalSession } from './lib/portal/session';
import { resolvePortal } from './lib/portal/config';

describe('Rice Bridge portal boundary', () => {
  it('lets device-credential routes reach their Bearer-token handlers', () => {
    expect(isBridgeDeviceApiPath('/api/v1/bridge/device/pair')).toBe(true);
    expect(
      isBridgeDeviceApiPath(
        '/api/v1/bridge/device/commands/6f9619ff-8b86-d011-b42d-00cf4fc964ff/complete',
      ),
    ).toBe(true);
    expect(
      isBridgeDeviceApiPath('/api/v1/bridge/device/workspace-selections/next'),
    ).toBe(true);
    expect(
      isBridgeDeviceApiPath(
        '/api/v1/bridge/device/workspace-selections/6f9619ff-8b86-d011-b42d-00cf4fc964ff/complete',
      ),
    ).toBe(true);
  });

  it('keeps browser device management behind the portal session', () => {
    expect(isBridgeDeviceApiPath('/api/v1/bridge/browser-workspaces')).toBe(
      true,
    );
    expect(
      isBridgeDeviceApiPath('/api/v1/bridge/browser-workspaces/capture'),
    ).toBe(true);
    expect(
      isBridgeDeviceApiPath('/api/v1/bridge/browser-workspaces/extra'),
    ).toBe(false);
    expect(
      isBridgeDeviceApiPath('/api/v1/bridge/browser-workspaces-extra'),
    ).toBe(false);
    expect(isBridgeDeviceApiPath('/api/v1/bridge/pairings')).toBe(false);
    expect(isBridgeDeviceApiPath('/api/v1/bridge/devices')).toBe(false);
    expect(isBridgeDeviceApiPath('/api/v1/bridge/devices/device-id')).toBe(
      false,
    );
  });

  it('only exempts exact governed device endpoints, never management or arbitrary actions', () => {
    const prefix = '/api/v1/bridge/device/operations';
    expect(isBridgeDeviceApiPath(`${prefix}/next`)).toBe(true);
    expect(isBridgeDeviceApiPath('/api/v1/bridge/device/runtime-profile')).toBe(
      true,
    );
    for (const action of [
      'start',
      'heartbeat',
      'output',
      'receipts',
      'service',
    ]) {
      const path = `${prefix}/6f9619ff-8b86-d011-b42d-00cf4fc964ff/${action}`;
      expect(isBridgeDeviceApiPath(path)).toBe(true);
      const response = proxy(
        new NextRequest(`https://allrice-snow.bplabs.xyz${path}`, {
          headers: { host: 'allrice-snow.bplabs.xyz' },
        }),
      );
      expect(response.status).toBe(200);
    }
    for (const suffix of [
      '../devices',
      'foo/start',
      '6f9619ff-8b86-d011-b42d-00cf4fc964ff/approve',
      'next/extra',
    ])
      expect(isBridgeDeviceApiPath(`${prefix}/${suffix}`)).toBe(false);
  });
});

describe('portal authentication response boundary', () => {
  it('passes signed file reads to token validation but keeps signing behind login', () => {
    const host = 'allrice.bplabs.xyz';
    const file = '/api/v1/files/11111111-1111-4111-8111-111111111111';
    expect(
      proxy(
        new NextRequest(`https://${host}${file}?token=opaque`, {
          headers: { host },
        }),
      ).status,
    ).toBe(200);
    expect(
      proxy(
        new NextRequest(`https://${host}${file}/sign`, { headers: { host } }),
      ).status,
    ).toBe(401);
  });
  it('lets invitation tokens authenticate account activation on the shared entry', () => {
    const host = 'allrice.bplabs.xyz';
    for (const path of [
      '/accept-invitation?token=invite',
      '/api/v1/auth/invitations/accept',
    ]) {
      expect(
        proxy(new NextRequest(`https://${host}${path}`, { headers: { host } }))
          .status,
      ).toBe(200);
    }
    expect(
      proxy(
        new NextRequest(`https://${host}/api/v1/auth/invitations`, {
          headers: { host },
        }),
      ).status,
    ).toBe(401);
  });
  it('uses database sessions on the shared entry without binding everyone to Snow', () => {
    const host = 'allrice.bplabs.xyz';
    expect(resolvePortal(host)).toBeNull();
    const unsigned = proxy(
      new NextRequest(`https://${host}/chatflow?session=existing`, {
        headers: { host },
      }),
    );
    expect(
      new URL(unsigned.headers.get('location')!).searchParams.get('next'),
    ).toBe('/chatflow?session=existing');
    expect(
      proxy(
        new NextRequest(`https://${host}/api/v1/auth/session`, {
          headers: { host },
        }),
      ).status,
    ).toBe(401);
    expect(
      proxy(
        new NextRequest(`https://${host}/chatflow`, {
          headers: { host, cookie: 'allrice_session=db-token' },
        }),
      ).status,
    ).toBe(200);
    expect(
      proxy(
        new NextRequest(`https://${host}/api/v1/bridge/device/heartbeat`, {
          headers: { host },
        }),
      ).status,
    ).toBe(200);
  });
  let originalPortalAuthEnabled: string | undefined;

  beforeEach(() => {
    originalPortalAuthEnabled = process.env.ALLRICE_PORTAL_AUTH_ENABLED;
    process.env.ALLRICE_PORTAL_AUTH_ENABLED = '1';
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalPortalAuthEnabled === undefined) {
      delete process.env.ALLRICE_PORTAL_AUTH_ENABLED;
    } else {
      process.env.ALLRICE_PORTAL_AUTH_ENABLED = originalPortalAuthEnabled;
    }
  });

  it('passes only personal device settings to owner-checked handlers; blocks shared management', () => {
    vi.stubEnv(
      'ALLRICE_PORTAL_SESSION_SECRET',
      'synthetic-portal-secret-with-more-than-32-characters',
    );
    const host = 'allrice-snow.bplabs.xyz';
    const session = createPortalSession({
      portal: resolvePortal(host)!,
      subject: 'test',
      organizationId: 'test-org',
      workspaceId: 'test-workspace',
    });
    const headers = { host, cookie: `allrice_portal_session=${session.value}` };
    expect(
      proxy(new NextRequest(`https://${host}/api/v1/admin/mcp`, { headers }))
        .status,
    ).toBe(403);
    for (const path of [
      '/api/v1/admin/local-mcp',
      '/api/v1/admin/local-browser',
    ]) {
      expect(
        proxy(new NextRequest(`https://${host}${path}`, { headers })).status,
      ).toBe(200);
      expect(
        proxy(new NextRequest(`https://${host}${path}`, { headers: { host } }))
          .status,
      ).toBe(401);
    }
    for (const path of [
      '/api/v1/admin/mcp',
      '/api/v1/admin/browser-control',
      '/api/v1/admin/mcp-extra',
      '/api/v1/admin/local-browser/extra',
      '/api/v1/admin/local-browser-extra',
      '/api/v1/admin/mcp/extra',
      '/api/v1/admin/local-mcp-extra',
      '/api/v1/admin/local-mcp/extra',
      '/api/v1/admin/browser-control-extra',
      '/api/v1/admin/browser-control/extra',
      '/api/v1/admin/platform-employees',
      '/api/v1/admin/model-governance',
    ])
      expect(
        proxy(new NextRequest(`https://${host}${path}`, { headers })).status,
      ).toBe(403);
    expect(
      proxy(
        new NextRequest(`https://${host}/api/v1/admin/mcp`, {
          headers: { host },
        }),
      ).status,
    ).toBe(401);
    expect(
      proxy(
        new NextRequest('https://allrice-drink.bplabs.xyz/api/v1/admin/mcp', {
          headers: { ...headers, host: 'allrice-drink.bplabs.xyz' },
        }),
      ).status,
    ).toBe(401);
  });

  it('exempts only the exact status sync route for its own token handler', () => {
    const host = 'allrice-dsh.bplabs.xyz';
    const route = '/api/v1/internal/runtime-capabilities';
    const make = (path: string) =>
      new NextRequest(`https://${host}${path}`, { headers: { host } });
    expect(proxy(make(route)).status).toBe(200);
    for (const path of [
      route + '/extra',
      route + '-extra',
      '/api/v1/admin/runtime-console/capabilities',
    ]) {
      expect(proxy(make(path)).status).toBe(401);
    }
  });

  it('redirects anonymous tenant navigation but keeps its initial API failure as JSON', async () => {
    const origin = 'https://allrice-snow.bplabs.xyz';
    const headers = { host: 'allrice-snow.bplabs.xyz' };

    const navigation = proxy(
      new NextRequest(`${origin}/automation`, { headers }),
    );
    expect(navigation.status).toBe(307);
    expect(navigation.headers.get('location')).toBe(
      'https://allrice.bplabs.xyz/automation',
    );

    const capabilities = proxy(
      new NextRequest(`${origin}/api/v1/saas/capabilities`, { headers }),
    );
    expect(capabilities.status).toBe(401);
    expect(capabilities.headers.get('location')).toBeNull();
    expect(capabilities.headers.get('content-type')).toContain(
      'application/json',
    );
    await expect(capabilities.json()).resolves.toMatchObject({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
        retryable: false,
      },
    });
  });

  it('recognizes Drink as an isolated tenant portal', () => {
    const origin = 'https://allrice-drink.bplabs.xyz';
    const navigation = proxy(
      new NextRequest(`${origin}/chatflow`, {
        headers: { host: 'allrice-drink.bplabs.xyz' },
      }),
    );
    expect(navigation.status).toBe(307);
    expect(navigation.headers.get('location')).toBe(
      'https://allrice.bplabs.xyz/chatflow',
    );
  });
});

describe('legacy navigation compatibility', () => {
  it('moves HTML links with their exact path/query, while keeping devices, OAuth, SSE and signed downloads on their original origin', () => {
    vi.stubEnv('ALLRICE_PORTAL_AUTH_ENABLED', '1');
    try {
      for (const host of [
        'allrice-snow.bplabs.xyz',
        'allrice-drink.bplabs.xyz',
        'allrice-dsh.bplabs.xyz',
      ]) {
        for (const path of [
          '/chatflow?session=kept&employee=rice',
          '/runtime-console?view=activity',
          '/workspace/mcp?connectionId=kept',
          '/accept-invitation?token=kept',
        ]) {
          const response = proxy(
            new NextRequest(`https://${host}${path}`, { headers: { host } }),
          );
          expect(response.headers.get('location')).toBe(
            `https://allrice.bplabs.xyz${path}`,
          );
        }
        for (const path of [
          '/api/v1/bridge/device/heartbeat',
          '/api/v1/connections/callback?state=kept&code=kept',
          '/api/v1/runs/run/events',
          '/api/v1/files/11111111-1111-4111-8111-111111111111?token=kept',
        ]) {
          expect(
            proxy(
              new NextRequest(`https://${host}${path}`, { headers: { host } }),
            ).headers.get('location'),
          ).toBeNull();
        }
      }
      expect(
        proxy(
          new NextRequest('https://allrice-snow.bplabs.xyz/chatflow', {
            method: 'POST',
            headers: { host: 'allrice-snow.bplabs.xyz' },
          }),
        ).headers.get('location'),
      ).not.toContain('https://allrice.bplabs.xyz');
      expect(
        proxy(
          new NextRequest('https://dsh.pblabs.xyz/chatflow', {
            headers: { host: 'dsh.pblabs.xyz' },
          }),
        ).status,
      ).toBe(421);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
