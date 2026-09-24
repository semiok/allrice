import {
  listPlatformNativeSkills,
  listEmployeeToolAvailability,
  readRuntimeCapabilityInventory,
} from '@allrice/database';
import { AllriceCapabilitySummarySchema } from '@allrice/contracts';
import {
  integratedCapabilityStatus,
  runtimeCapabilityFacts,
  type RuntimeCapabilityResponse,
} from '../app/runtime-console/runtime-capability-facts';

export async function readRuntimeCapabilityResponse(): Promise<RuntimeCapabilityResponse> {
  const [inventory, skills] = await Promise.all([
    readRuntimeCapabilityInventory(),
    listPlatformNativeSkills(),
  ]);
  return {
    ...inventory,
    skills,
    webTools: listEmployeeToolAvailability().map((tool) => ({
      name: tool.canonicalName,
      enabled: tool.released,
    })),
  };
}

export function summarizeRuntimeCapabilities(data: RuntimeCapabilityResponse) {
  const facts = runtimeCapabilityFacts(data);
  return AllriceCapabilitySummarySchema.parse({
    schemaVersion: 1,
    checkedAt: data.checkedAt,
    webReleaseSha: process.env.ALLRICE_RELEASE_SHA ?? null,
    workerReleaseShas: [
      ...new Set(
        facts.workers.flatMap((w) => (w.releaseSha ? [w.releaseSha] : [])),
      ),
    ],
    versions: facts.versions,
    onlineWorkers: facts.workers.length,
    componentCount: facts.componentCount,
    enhancementCount: facts.enhancementCount,
    availableSkills: facts.availableSkills.length,
    publishedSkills: facts.publishedSkillIds.size,
    publications: data.publications.length,
    capabilities: [
      'native-images',
      'assistants',
      'development',
      'durable-wait',
      'session-recovery',
    ].map((id) => ({
      id,
      status: integratedCapabilityStatus(id, data),
    })),
  });
}
