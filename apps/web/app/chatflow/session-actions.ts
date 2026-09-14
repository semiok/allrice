import type { createSessionSelection } from './session-selection';

type Selection = ReturnType<
  ReturnType<typeof createSessionSelection>['capture']
>;
export type SessionAction = {
  current: () => boolean;
  adoptCreatedSession: (sessionId: string) => boolean;
  finish: () => boolean;
};

/** Owns UI side effects, not server tasks. Leaving a Session never cancels a POST. */
export function createSessionActions(capture: () => Selection) {
  const owners = new Map<string, SessionAction>();
  return {
    pending(channel: string) {
      return owners.get(channel)?.current() ?? false;
    },
    begin(channel: string): SessionAction | null {
      if (owners.get(channel)?.current()) return null;
      let scope = capture();
      const ticket: SessionAction = {
        current: () => owners.get(channel) === ticket && scope.current(),
        adoptCreatedSession(sessionId) {
          const next = capture();
          // Only our single null→created transition is allowed. A→B→A, or
          // navigation during createSession, cannot resurrect an old request.
          if (
            owners.get(channel) !== ticket ||
            scope.sessionId !== null ||
            next.sessionId !== sessionId ||
            next.generation !== scope.generation + 1
          )
            return false;
          scope = next;
          return ticket.current();
        },
        finish() {
          const current = ticket.current();
          if (owners.get(channel) === ticket) owners.delete(channel);
          return current;
        },
      };
      owners.set(channel, ticket);
      return ticket;
    },
  };
}
