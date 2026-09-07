import { bridgeDeviceStatus } from '@allrice/database';

import { createRuntimeBridgeHttpHandler } from './operation-http';

/** B1 integration must install P04's trusted admission before this flag opens. */
export const handleRuntimeBridgeOperation = createRuntimeBridgeHttpHandler({
  enabled: () => process.env.ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED === '1',
  authenticate: bridgeDeviceStatus,
  ledgerForDevice: async () => {
    // Fail closed when P03-b is deployed independently of the B1 policy adapter.
    // No permissive fallback and no browser-supplied authorization bindings.
    throw new Error('RUNTIME_BRIDGE_ADMISSION_NOT_CONFIGURED');
  },
});
