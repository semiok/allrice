import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { classifyExperienceFeedback } from './experience-feedback.ts';
import { loadedExperienceSkillEvidence } from './experience-evidence.ts';

describe('direct feedback evidence, not long-term change authority', () => {
  it.each([
    '刚才的对账报告漏了退款，核对时需要单列退款再汇总净回款。',
    '这份报告金额算错了。退款是负数；请核对原始流水。',
    '上次的研究结论有误，样本没有覆盖对照组。',
    '反馈：这份表格重复统计了订单，需要按订单号去重。',
    'Your previous calculation double-counted refunds. The net amount should exclude them.',
  ])('captures direct multi-clause correction: %s', (text) => {
    expect(classifyExperienceFeedback(text)).toBe('correction');
  });
  it.each([
    '我已复核：这一版的核对金额与原流水一致，差异原因也列得清晰。',
    '反馈：先展示合计、再列明细，阅读起来更清晰。',
    'I verified the result matches the input records.',
  ])('retains explicit feedback without marking it verified: %s', (text) => {
    expect(classifyExperienceFeedback(text)).toBe('explicit_feedback');
  });
  it.each([
    '帮我做一份对账报告。',
    '做得不错',
    '刚才那份报告漏了退款，仅本次补上即可。',
    '这份报告有误，但不要记录或学习这个反馈。',
    '这份报告有误，不要把这条反馈记录下来。',
    '刚才的报告漏了退款，这次只补这一单即可。',
    '反馈：金额有误。请勿将这条更正保存下来。',
    '上次的表格算错了，仅处理这一次。',
    'The previous report is wrong. Do not record this feedback.',
    'Your last report is missing a refund. Just this report needs a correction.',
    '以后都先写结论，再写过程。',
    '刚才的报告漏了退款。今后都把这个要求保存为长期规则。',
    '翻译：刚才的报告有误，应该按净额汇总。',
    '“刚才的报告有误，应该按净额汇总。”',
    '> 这份报告金额算错了。',
    '```\n刚才的报告有误，应该按净额汇总。\n```',
    '    刚才的报告有误，应该按净额汇总。',
    'Your last report is wrong. Do not remember this.',
    'x'.repeat(4001),
  ])(
    'excludes quotes, meta tasks, temporary demands and controlled edits: %s',
    (text) => {
      expect(classifyExperienceFeedback(text)).toBeNull();
    },
  );
});

describe('personal Skill provenance uses a successful exact frozen pin', () => {
  const pin = {
    organizationId: randomUUID(),
    ownerId: randomUUID(),
    instanceId: randomUUID(),
    installationId: randomUUID(),
    versionId: randomUUID(),
    bindingId: randomUUID(),
    bindingEpoch: 2,
    definitionChecksum: `sha256:${'a'.repeat(64)}`,
    packageChecksum: `sha256:${'b'.repeat(64)}`,
  };
  const run = {
    run_id: randomUUID(),
    execution_snapshot: { personalSkills: { skills: [pin] } },
  };
  const event = {
    id: randomUUID(),
    event_type: 'tool.completed',
    payload: {
      name: 'skill',
      nativePayload: { skillStatus: 'loaded', personalSkill: pin },
    },
  };
  it('keeps the exact Run, event and version; duplicate loads do not multiply dependencies', () => {
    expect(loadedExperienceSkillEvidence(run, [event, event])).toEqual([
      { runId: run.run_id, eventId: event.id, pin },
    ]);
  });
  it('does not infer use from available pins, failure, selected state, prose or a changed version', () => {
    for (const events of [
      [],
      [{ ...event, event_type: 'tool.failed' }],
      [
        {
          ...event,
          payload: {
            name: 'skill',
            nativePayload: { skillStatus: 'selected', personalSkill: pin },
          },
        },
      ],
      [{ ...event, payload: { text: 'skill loaded' } }],
      [
        {
          ...event,
          payload: {
            name: 'skill',
            nativePayload: {
              skillStatus: 'loaded',
              personalSkill: { ...pin, bindingEpoch: 3 },
            },
          },
        },
      ],
    ])
      expect(loadedExperienceSkillEvidence(run, events)).toEqual([]);
    expect(
      loadedExperienceSkillEvidence({ ...run, execution_snapshot: {} }, [
        event,
      ]),
    ).toEqual([]);
  });
});
