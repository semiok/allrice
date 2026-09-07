import {
  bridgeDeviceStatus,
  createGovernedBridgeOperationLedger,
} from '@allrice/database';

import { createRuntimeBridgeHttpHandler } from './operation-http';

/** Default-off B1 endpoint, backed by current P04 authority in the ledger transaction. */
export const handleRuntimeBridgeOperation = createRuntimeBridgeHttpHandler({
  enabled: () => process.env.ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED === '1',
  authenticate: bridgeDeviceStatus,
  ledgerForDevice: async (device) =>
    createGovernedBridgeOperationLedger(device),
});
