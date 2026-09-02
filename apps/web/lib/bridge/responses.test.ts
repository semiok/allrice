import { describe, expect, it } from 'vitest';

import { ApiErrorSchema } from '@allrice/contracts';
import { BridgeDataError } from '@allrice/database';

import { bridgeErrorResponse } from './responses';

describe('bridge error responses', () => {
  it.each([
    ['device_unauthorized', 401, 'AUTHENTICATION_REQUIRED', false],
    ['pairing_invalid', 403, 'BRIDGE_REQUEST_INVALID', false],
    ['device_offline', 503, 'DEPENDENCY_UNAVAILABLE', true],
    ['lease_lost', 409, 'CONFLICT', false],
    ['result_too_large', 413, 'QUOTA_EXCEEDED', false],
  ] as const)(
    'maps %s to the canonical API envelope',
    async (bridgeCode, status, apiCode, retryable) => {
      const response = bridgeErrorResponse(new BridgeDataError(bridgeCode));
      const body = await response.json();

      expect(response.status).toBe(status);
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
      expect(body).toMatchObject({ error: { code: apiCode, retryable } });
    },
  );
});
