import {
  bridgeDeviceStatus,
  claimLocalBrowserWorkspace,
  heartbeatLocalBrowserWorkspace,
  nextLocalBrowserOperation,
  startLocalBrowserOperation,
  recordLocalBrowserReceipt,
  publishLocalBrowserObservation,
  acknowledgeLocalBrowserControl,
  recordLocalBrowserStopped,
  acknowledgeLocalBrowserRevocation,
  requestLocalBrowserEffect,
  localBrowserEffectStatus,
  completeLocalBrowserEffect,
  takeLocalBrowserInput,
  captureLocalBrowserFile,
  renewLocalBrowserOperations,
  publishBrowserObservationArtifact,
  readCurrentBrowserWorkspace,
  localBrowserPrincipal,
} from '@allrice/database';
import { getStorageAdapter } from '../storage/runtime.ts';
import { createLocalBrowserHttpHandler } from './local-browser-http.ts';

export const handleLocalBrowserRequest = createLocalBrowserHttpHandler({
  authenticate: bridgeDeviceStatus,
  capture: (device, input, bytes) =>
    captureLocalBrowserFile(device, input, bytes, getStorageAdapter()),
  execute: async (device, input) => {
    switch (input.kind) {
      case 'claim':
        return claimLocalBrowserWorkspace(
          device,
          input.controllerId,
          input.acceptWork,
        );
      case 'heartbeat': {
        const result = await heartbeatLocalBrowserWorkspace(device, input);
        if (!result.workspace.revoked)
          await renewLocalBrowserOperations(device, input);
        return result;
      }
      case 'next':
        return nextLocalBrowserOperation(device, input);
      case 'start':
        return startLocalBrowserOperation(device, input);
      case 'receipt':
        return recordLocalBrowserReceipt(device, input);
      case 'observation': {
        await publishLocalBrowserObservation(device, input);
        const w = await readCurrentBrowserWorkspace(
          localBrowserPrincipal(device),
          input.workspaceId,
        );
        await publishBrowserObservationArtifact(
          w,
          input.observation,
          getStorageAdapter(),
        );
        return { ok: true };
      }
      case 'control_ack':
        return acknowledgeLocalBrowserControl(device, input);
      case 'stopped':
        await recordLocalBrowserStopped(device, input);
        return { ok: true };
      case 'revoke_ack':
        await acknowledgeLocalBrowserRevocation(device, input);
        return { ok: true };
      case 'request_approval':
        return requestLocalBrowserEffect(device, input);
      case 'request_status':
        return localBrowserEffectStatus(device, input);
      case 'request_complete':
        return completeLocalBrowserEffect(device, input);
      case 'take_input':
        return takeLocalBrowserInput(device, input, getStorageAdapter());
    }
  },
});
