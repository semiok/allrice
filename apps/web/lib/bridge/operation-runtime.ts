import { runtimeFeatureEnabled } from '@allrice/contracts';
import {
  bridgeDeviceStatus,
  createGovernedBridgeOperationLedger,
  readManagedPythonRuntimeGrant,
} from '@allrice/database';

import { createRuntimeBridgeHttpHandler } from './operation-http';

/** Current member/device authority is rechecked in each ledger transaction. */
export const handleRuntimeBridgeOperation = createRuntimeBridgeHttpHandler({
  enabled: () =>
    runtimeFeatureEnabled('ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED'),
  authenticate: async (token) => {
    const status = await bridgeDeviceStatus(token);
    return {
      ...status,
      managedRuntimeGrant: await readManagedPythonRuntimeGrant(status.device),
    };
  },
  ledgerForDevice: async (device) =>
    createGovernedBridgeOperationLedger(device),
});
