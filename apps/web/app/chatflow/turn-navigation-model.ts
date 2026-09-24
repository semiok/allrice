import { modelGovernanceFailureText } from '@allrice/contracts';
import type { Message, RunView } from './chatflow-types';
import { preview } from './dsh-upstream/turn-navigation/preview';

/** Structural input to the official rail; Allrice currently loads full history. */
export interface TurnRailItem {
  readonly turn: number;
  readonly prompt: string;
  readonly response: string;
  readonly anchor:
    | { readonly kind: 'loaded'; readonly key: string }
    | { readonly kind: 'unloaded'; readonly seq: number };
}

export type TurnNavigatorTranslator = (
  key: string,
  values?: { turn: number },
) => string;

export const turnNavigationText: TurnNavigatorTranslator = (key, values) => {
  switch (key) {
    case 'chat.turnNavigation.label':
      return '轮次导航';
    case 'chat.turnNavigation.jump':
      return `跳转到第 ${values?.turn} 轮`;
    case 'chat.turnNavigation.jumpLoad':
      return `加载并跳转到第 ${values?.turn} 轮`;
    default:
      return `第 ${values?.turn} 轮`;
  }
};

function streamedPreview(view: RunView) {
  let text = '';
  for (const event of view.events) {
    if (event.type === 'assistant.text.delta')
      text += String(event.payload.text ?? '').slice(0, 240 - text.length);
    if (text.length >= 240) break;
  }
  return preview([text], 120);
}

/** Only visible conversation text enters a preview; never traces or tool output. */
export function conversationTurns(
  messages: readonly Message[],
  runViews: Readonly<Record<string, RunView>>,
): TurnRailItem[] {
  const items: TurnRailItem[] = [];
  const byRun = new Map<string, number>();
  let latest: number | undefined;
  let unboundPrompt: number | undefined;
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const known = message.runId ? byRun.get(message.runId) : undefined;
    if (message.role === 'user') {
      // A clarification receipt belongs to the question already being answered.
      if (
        message.content.interaction?.type === 'user_question_answer' &&
        known !== undefined
      )
        continue;
      latest = items.length;
      unboundPrompt = message.runId ? undefined : latest;
      items.push({
        turn: latest + 1,
        prompt: preview(
          [
            message.content.text ||
              (message.attachments?.length ? '已发送附件' : ''),
          ],
          50,
        ),
        response: '',
        anchor: { kind: 'loaded', key: message.id },
      });
      if (message.runId) byRun.set(message.runId, latest);
      continue;
    }
    const streamed = message.runId && runViews[message.runId];
    const text =
      (message.status === 'failed' && !message.content.budgetWarning
        ? modelGovernanceFailureText(message.errorCode)
        : null) ??
      ((streamed && streamedPreview(streamed)) ||
        (message.status === 'pending' ? '' : message.content.text));
    let index = known;
    // Older records may have no run ID on the prompt.
    if (index === undefined && latest !== undefined && !message.runId)
      index = latest;
    if (index === undefined) index = unboundPrompt;
    if (index === undefined) {
      if (!text && message.status === 'completed') continue;
      index = items.length;
      items.push({
        turn: index + 1,
        prompt: '',
        response: '',
        anchor: { kind: 'loaded', key: message.id },
      });
    }
    if (message.runId) {
      byRun.set(message.runId, index);
      if (index === unboundPrompt) unboundPrompt = undefined;
    }
    if (text)
      items[index] = { ...items[index]!, response: preview([text], 120) };
    latest = index;
  }
  return items;
}
