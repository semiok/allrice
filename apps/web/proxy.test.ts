import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isBridgeDeviceApiPath, proxy } from './proxy.js';

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
  let originalPortalAuthEnabled: string | undefined;

  beforeEach(() => {
    originalPortalAuthEnabled = process.env.ALLRICE_PORTAL_AUTH_ENABLED;
    process.env.ALLRICE_PORTAL_AUTH_ENABLED = '1';
  });

  afterEach(() => {
    if (originalPortalAuthEnabled === undefined) {
      delete process.env.ALLRICE_PORTAL_AUTH_ENABLED;
    } else {
      process.env.ALLRICE_PORTAL_AUTH_ENABLED = originalPortalAuthEnabled;
    }
  });

  it('redirects anonymous tenant navigation but keeps its initial API failure as JSON', async () => {
    const origin = 'https://allrice-snow.bplabs.xyz';
    const headers = { host: 'allrice-snow.bplabs.xyz' };

    const navigation = proxy(
      new NextRequest(`${origin}/automation`, { headers }),
    );
    expect(navigation.status).toBe(307);
    expect(navigation.headers.get('location')).toBe(`${origin}/login`);

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
    expect(navigation.headers.get('location')).toBe(`${origin}/login`);
  });
});
