import { describe, expect, it } from 'vitest';

import { isBridgeDeviceApiPath } from './proxy.js';

describe('Rice Bridge portal boundary', () => {
  it('lets device-credential routes reach their Bearer-token handlers', () => {
    expect(isBridgeDeviceApiPath('/api/v1/bridge/device/pair')).toBe(true);
    expect(
      isBridgeDeviceApiPath(
        '/api/v1/bridge/device/commands/6f9619ff-8b86-d011-b42d-00cf4fc964ff/complete',
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
});
