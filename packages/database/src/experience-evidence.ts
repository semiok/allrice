import type { getDatabase } from './core/client.ts';
export {
  matchSuccessfulPersonalSkillLoad,
  loadedMemorySourceSkillEvidence as loadedExperienceSkillEvidence,
} from './memory-source-skills.ts';

/** The legacy collector never consumes pending or historical sources again. */
export async function collectPendingExperienceEvidence(
  options: {
    database?: ReturnType<typeof getDatabase>;
    limit?: number;
  } = {},
) {
  void options;
  return { captured: 0, ignored: 0, busy: 0 };
}
