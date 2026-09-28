import type { Message, RunView } from './chatflow-types';

/** Transport activity never overrides a settled message from session history. */
export function isMessageRunActive(message: Message, view?: RunView | null) {
  return (
    message.role === 'assistant' &&
    message.status === 'pending' &&
    (!view || view.status === 'connecting' || view.status === 'running')
  );
}
