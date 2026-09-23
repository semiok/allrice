/** Bounded, explainable heuristics, not proof that every repeated call is a loop.
 * No raw tool output or chain of thought is retained in this state. */
export interface ProgressFact {
  name: string;
  argumentsDigest: string;
  resultDigest: string;
  outcome: 'success' | 'error' | 'empty' | 'poll' | 'control' | 'retry';
}
export interface ProgressState {
  history: ProgressFact[];
  reason: 'repeated_failure' | 'repeated_no_progress' | null;
}
export const initialProgressState = (): ProgressState => ({
  history: [],
  reason: null,
});
export function observeProgress(
  state: ProgressState,
  fact: ProgressFact,
): ProgressState {
  if (state.reason) return state;
  // Explicit bounded retry/poll/control is neither progress nor evidence of a
  // loop. It cannot wash away earlier failure history by emitting heartbeats.
  if (['poll', 'control', 'retry'].includes(fact.outcome)) return state;
  const history = [...state.history, fact].slice(-32);
  const sameFailure =
    history.slice(-3).length === 3 &&
    history
      .slice(-3)
      .every(
        (f) =>
          f.outcome === 'error' &&
          f.name === fact.name &&
          f.argumentsDigest === fact.argumentsDigest &&
          f.resultDigest === fact.resultDigest,
      );
  // Varying an argument/nonce/new child is not itself progress. Eight successive
  // failures still require a human decision, not an unbounded retry storm.
  const failedWindow = history.slice(-8);
  const failures =
    failedWindow.length === 8 &&
    failedWindow.every((f) => f.outcome === 'error');
  const last = history.slice(-12);
  const fingerprints = new Set(last.map((f) => `${f.name}:${f.resultDigest}`));
  // Read/write oscillations between the same few results are only a suspicion;
  // pause for a decision, never mark the task failed or roll back its artifacts.
  const stalled = last.length === 12 && fingerprints.size <= 2;
  return {
    history,
    reason:
      sameFailure || failures
        ? 'repeated_failure'
        : stalled
          ? 'repeated_no_progress'
          : null,
  };
}
