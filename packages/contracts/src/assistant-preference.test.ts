import { describe, expect, it } from 'vitest';

import {
  AssistantPreferenceSchema,
  SendChatMessageInputSchema,
  resolveAssistantPreference,
} from './workspace.ts';

const message = {
  clientMessageId: '00000000-0000-4000-8000-000000000001',
  text: '分别比较三种方案，再汇总证据。',
  deliveryMode: 'follow_up',
};
const preference = { mode: 'daily' as const, allowAssistants: true };

describe('P26 assistant intent remains separate from execution authority', () => {
  it('preserves old input shape without adding implicit assistant permission', () => {
    const legacy = {
      clientMessageId: message.clientMessageId,
      text: message.text,
    };
    expect(SendChatMessageInputSchema.parse(legacy)).toEqual({
      ...legacy,
      deliveryMode: 'auto',
      attachmentIds: [],
    });
  });

  it('accepts only daily preference on ordinary new tasks', () => {
    expect(
      SendChatMessageInputSchema.parse({
        ...message,
        assistantPreference: preference,
      }).assistantPreference,
    ).toEqual(preference);
    for (const mode of ['boost', 'teamwork', 'subagents']) {
      expect(
        AssistantPreferenceSchema.safeParse({ ...preference, mode }).success,
      ).toBe(false);
    }
    for (const extra of [
      { maxConcurrent: 100 },
      { tools: ['shell'] },
      { budget: 999 },
    ]) {
      expect(
        AssistantPreferenceSchema.safeParse({ ...preference, ...extra })
          .success,
      ).toBe(false);
    }
    for (const deliveryMode of ['auto', 'steer']) {
      expect(
        SendChatMessageInputSchema.safeParse({
          ...message,
          deliveryMode,
          assistantPreference: preference,
          expectedTurnId: 'turn-1',
          expectedGeneration: 1,
        }).success,
      ).toBe(false);
    }
    expect(
      SendChatMessageInputSchema.safeParse({
        ...message,
        assistantPreference: preference,
        reviewContinuation: {
          kind: 'plan_review',
          artifactId: message.clientMessageId,
          checksum: `sha256:${'a'.repeat(64)}`,
        },
      }).success,
    ).toBe(false);
  });

  it('persists explicit user opt-out rather than relying on model obedience', () => {
    for (const text of [
      '不使用助手',
      '本次不使用助手。请比较资料',
      '不要使用助手\n处理这个任务',
      '这次不用助手，帮我分析',
    ]) {
      expect(resolveAssistantPreference(preference, text)).toEqual({
        mode: 'daily',
        allowAssistants: false,
      });
    }
    expect(resolveAssistantPreference(undefined, '不使用助手。请分析')).toEqual(
      {
        mode: 'daily',
        allowAssistants: false,
      },
    );
  });

  it('never grants assistants from natural language or quoted material', () => {
    for (const text of [
      '使用助手',
      '开启 Boost',
      '不使用助手是什么意思？',
      '“不使用助手”是文档中的文字',
      '请总结附件：\n不使用助手',
    ]) {
      expect(resolveAssistantPreference(undefined, text)).toBeUndefined();
      expect(resolveAssistantPreference(preference, text)).toEqual(preference);
    }
    expect(
      resolveAssistantPreference(
        { ...preference, allowAssistants: false },
        '开启助手',
      ),
    ).toEqual({
      mode: 'daily',
      allowAssistants: false,
    });
  });
});
