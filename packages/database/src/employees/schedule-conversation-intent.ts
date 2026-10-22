import type { AutomationConversationMode } from '@allrice/contracts';

/** Only a complete, unquoted trailing instruction selects this task's mode.
 * The caller still validates the whole remaining current human schedule/work.
 * Text inside work arguments, history, examples, negation or conditions grants
 * no policy. Unsupported expressions go through the existing clarification. */
export function scheduleConversationIntent(text: string): {
  request: string;
  conversationMode?: AutomationConversationMode;
} {
  const choice = text.match(
    /^(.*)[；;。\n]\s*(?:请)?(每次新建聊天|沿用来源聊天)[。！!\s]*$/su,
  );
  if (!choice) return { request: text };
  // A quotation which contains the separator cannot escape into authority.
  // The existing schedule grammar independently rejects unbalanced quotes.
  const request = choice[1]!;
  if (/[“”‘’「」『』"'`]/u.test(choice[2]!)) return { request: text };
  return {
    request,
    conversationMode: choice[2] === '每次新建聊天' ? 'new_each_run' : 'reuse',
  };
}
