import {
  ApfsPersonVmDisk,
  FilePersonVmKeyStore,
  MicrosandboxPersonVm,
} from '@allrice/person-vm';
import { readVerifiedProductionPersonVmInputs } from './production-artifacts.js';
import { createProductionEgressInstallation } from './production-egress.js';

/** Real inert provider construction only, not an installed Host or runtime.
 * Nothing boots or allocates a disk here. The final single-service composition
 * must pass this same platform snapshot to its shared admission host. */
export async function createProductionPersonVmProviders(signal: AbortSignal) {
  const loaded = await readVerifiedProductionPersonVmInputs(signal);
  signal.throwIfAborted();
  const native = new MicrosandboxPersonVm({
    ...loaded.configuration.native,
    memoryMiB: loaded.platform.memoryMiB,
  });
  const disk = new ApfsPersonVmDisk({
    root: loaded.configuration.disk.root,
    keys: new FilePersonVmKeyStore(loaded.configuration.disk.keyRoot),
    capacityGiB: loaded.configuration.disk.capacityGiB,
  });
  signal.throwIfAborted();
  const egressInstallation = createProductionEgressInstallation(loaded, signal);
  return Object.freeze({
    ...loaded,
    native,
    disk,
    egressInstallation,
    memoryGuestPlan: egressInstallation.memoryGuestPlan,
  });
}
