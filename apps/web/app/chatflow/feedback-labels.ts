import { zh } from './dsh-upstream/feedback/locales';
import type { Translate } from './feedback-native-types';

const copy: Record<string, string> = {
  ...zh,
  copy: '复制',
  copied: '已复制',
  close: '关闭',
  submit: '提交',
  submitting: '提交中…',
  'clock.md': '{m} 月 {d} 日',
  'clock.ymd': '{y} 年 {m} 月 {d} 日',
  'dialog.hint':
    '填写详情帮助我们改进。反馈会关联本条回复、对应问题与运行信息，供平台查看。',
};
export const feedbackTranslate: Translate = (key, params) =>
  (copy[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) =>
    String(params?.[name] ?? ''),
  );
