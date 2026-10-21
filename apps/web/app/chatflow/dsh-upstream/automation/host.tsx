/** AllRice's narrow view adapter. Upstream components own interaction/layout;
 * this module supplies public display data, locale and text rendering only. */
export { formatMessageClock } from '../feedback/message-chrome';

export const triggerLabels = {
  'message.trigger.schedule': '自动化任务',
  'message.trigger.request': '自动触发',
  'message.trigger.goal': '目标任务',
  'message.trigger.agent': '员工消息',
  'message.trigger.team': '团队消息',
  'message.trigger.subagent': '协作任务',
  'message.trigger.github': 'GitHub 事件',
  'message.trigger.webhook': '外部事件',
  'message.trigger.job': '后台任务',
  'message.trigger.plugin': '应用事件',
  'message.trigger.explanation': '这次工作由自动化任务触发。以下为执行要求。',
  'clock.md': '{m}月{d}日',
  'clock.ymd': '{y}年{m}月{d}日',
};
export type ChatKey = keyof typeof triggerLabels;
export interface ContextMessageNode {
  source: { kind: string };
  time: number;
  content: readonly { type: 'text'; text: string }[];
}
export type ChatNodeViewProps<Kind extends 'turn-trigger'> = {
  node: { kind: Kind; data: ContextMessageNode };
  t: typeof triggerTranslate;
};
export function triggerTranslate(
  key: ChatKey,
  parameters?: Record<string, string | number>,
) {
  return triggerLabels[key].replace(
    /\{(\w+)\}/g,
    (_, name: string) => String(parameters?.[name] ?? name),
  );
}
export function NoticeBody({
  content,
}: Pick<ContextMessageNode, 'content' | 'source'> & { t: unknown }) {
  return <>{content.map((block) => block.text).join('\n')}</>;
}
