/** Browser selection epoch. Returning to the same ID is a new lifetime. */
export function createSessionSelection() {
  let sessionId: string | null = null;
  let generation = 0;
  return {
    select(next: string | null) {
      if (next === sessionId) return false;
      sessionId = next;
      generation += 1;
      return true;
    },
    invalidate() {
      generation += 1;
    },
    capture() {
      const capturedGeneration = generation;
      return {
        sessionId,
        generation: capturedGeneration,
        current: () => generation === capturedGeneration,
      };
    },
  };
}
