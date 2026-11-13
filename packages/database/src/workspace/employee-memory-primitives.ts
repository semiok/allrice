import type { PersonalMemoryPair } from '@allrice/contracts';

/** Complete compatibility body for V1 readers of newly written V2 pairs. */
export const memoryPairContent = (pair: PersonalMemoryPair) =>
  pair.details === null ? pair.summary : `${pair.summary}\n${pair.details}`;
