import {
  listPlatformNativeSkills,
  listEmployeeToolAvailability,
  readRuntimeCapabilityInventory,
  workbenchEnabled,
} from '@allrice/database';
import webUi from '../app/dsh-upstream/upstream.json';
import type { RuntimeCapabilityResponse } from '../app/runtime-console/runtime-capability-facts';

export async function readRuntimeCapabilityResponse(): Promise<RuntimeCapabilityResponse> {
  const [inventory, skills] = await Promise.all([
    readRuntimeCapabilityInventory(),
    listPlatformNativeSkills(),
  ]);
  return {
    ...inventory,
    webUi: {
      components: webUi.componentSets.map(({ id, version }) => ({
        id,
        version,
      })),
      workbenchEnabled: workbenchEnabled(),
    },
    skills,
    webTools: listEmployeeToolAvailability().map((tool) => ({
      name: tool.canonicalName,
      enabled: tool.released,
    })),
  };
}
