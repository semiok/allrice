'use client';

import type { Message } from './chatflow-types';
import { TurnTriggerNodeView } from './dsh-upstream/automation/TurnTriggerNodeView';
import css from './automation-tasks.module.css';
import { triggerTranslate } from './dsh-upstream/automation/host';

/** Only authenticated server attribution can select the non-human UI. */
export function AutomationTrigger({
  message,
  onOpen,
}: {
  message: Message;
  onOpen?: (id: string) => void;
}) {
  if (message.role !== 'user' || message.source?.kind !== 'schedule')
    return null;
  return (
    <div>
      <TurnTriggerNodeView
        node={{
          kind: 'turn-trigger',
          data: {
            time: Date.parse(message.createdAt),
            source: { kind: 'schedule' },
            content: [{ type: 'text', text: message.content.text }],
          },
        }}
        t={triggerTranslate}
      />
      {onOpen && (
        <button
          type="button"
          className={css.taskLink}
          onClick={() => onOpen(message.source!.taskId)}
        >
          查看任务
        </button>
      )}
    </div>
  );
}
